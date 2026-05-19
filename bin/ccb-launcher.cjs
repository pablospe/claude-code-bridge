#!/usr/bin/env node
/**
 * ccb-launcher — external claude launcher for the bridge.
 *
 * Pairs with `ccb serve` (the bridge running under Bun) to provide a
 * working real-claude managed-launch path on hosts where Bun cannot fully
 * drive a node-pty PTY (Linux + Bun NAPI gap, tracked at
 * https://github.com/oven-sh/bun/issues/25822).
 *
 * Spawns `claude` under PTY with the exact arg set `ClaudeCodeSupervisor`
 * would generate, auto-confirms the dev-channels warning the same way,
 * and tees every PTY byte to a log file for debugging. Runs under Node
 * (not Bun) so node-pty's `onData` callback fires reliably.
 *
 * Usage:
 *
 *   # Terminal 1 — bridge under Bun:
 *   bun apps/ccb/src/cli.ts serve \
 *     --endpoint 127.0.0.1:18484 \
 *     --session-id <uuid> \
 *     --format json
 *
 *   # Terminal 2 — launcher under Node:
 *   ccb-launcher --endpoint 127.0.0.1:18484 --session-id <uuid>
 *   #  or, when running from a source checkout without a global install:
 *   node bin/ccb-launcher.cjs --endpoint 127.0.0.1:18484 --session-id <uuid>
 *
 *   # Terminal 1 (after the channel server connects) — type a prompt
 *   # into the bridge's stdin to push a channel notification through.
 *   # Watch the bridge's JSONL output for agent.reply / agent.done.
 *
 * The launcher exits when claude exits (or on Ctrl-C). The PTY trace log
 * is appended; delete it between runs for fresh output.
 *
 * See `docs/SMOKE.md` § "External launcher (ccb-launcher)" for the full
 * walkthrough and the supervisor architecture rationale.
 */

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--endpoint" || a === "--session-id" || a === "--log" || a === "--mcp-config") {
      out[a.slice(2)] = argv[++i];
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  process.stdout.write(`ccb-launcher — external claude launcher for the bridge\n\n`);
  process.stdout.write(`usage: ccb-launcher [options]\n\n`);
  process.stdout.write(`options:\n`);
  process.stdout.write(
    `  --endpoint <host:port>     bridge control endpoint (default 127.0.0.1:18484)\n`,
  );
  process.stdout.write(`  --session-id <uuid>        session id to claim (must match bridge)\n`);
  process.stdout.write(
    `  --log <path>               PTY trace log path (default /tmp/ccb-launcher.log)\n`,
  );
  process.stdout.write(`  --mcp-config <path>        write the generated .mcp.json here\n`);
  process.stdout.write(`  -h, --help                 show this help and exit\n\n`);
  process.stdout.write(
    `Pair with: bun apps/ccb/src/cli.ts serve --endpoint <host:port> --session-id <uuid>\n`,
  );
  process.exit(0);
}

const endpoint = opts.endpoint || process.env.CCB_BRIDGE_ENDPOINT || "127.0.0.1:18484";
const sessionId = opts["session-id"] || process.env.CCB_SESSION_ID;
const logPath = opts.log || "/tmp/ccb-launcher.log";
const mcpConfigPath = opts["mcp-config"] || `/tmp/ccb-launcher-${process.pid}.mcp.json`;

if (!sessionId) {
  process.stderr.write("error: --session-id is required (or set CCB_SESSION_ID)\n");
  process.exit(2);
}

// Defer the native-module require so `--help` doesn't fail when node-pty is
// not resolvable (e.g., a checkout without `bun install` having populated the
// workspace dependencies).
const pty = require("@homebridge/node-pty-prebuilt-multiarch");

// `bin/` is one level under the repo root.
const repoRoot = path.resolve(__dirname, "..");
const bunBin = process.env.CCB_BUN_BIN || "/home/pablo/.bun/bin/bun";
const channelServerBin = path.join(repoRoot, "packages/mcp-channel/src/bin.ts");

// Write the per-session .mcp.json mirroring what the supervisor generates.
const mcpConfig = {
  mcpServers: {
    ccb: {
      command: bunBin,
      args: [channelServerBin],
      env: {
        CCB_BRIDGE_ENDPOINT: endpoint,
        CCB_SESSION_ID: sessionId,
      },
    },
  },
};
fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

const args = [
  "--dangerously-load-development-channels",
  "server:ccb",
  "--mcp-config",
  mcpConfigPath,
  "--strict-mcp-config",
  "--add-dir",
  repoRoot,
  "--allowed-tools",
  "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done",
];

process.stderr.write(`ccb-launcher: spawning claude\n`);
process.stderr.write(`  endpoint:  ${endpoint}\n`);
process.stderr.write(`  sessionId: ${sessionId}\n`);
process.stderr.write(`  mcpConfig: ${mcpConfigPath}\n`);
process.stderr.write(`  logPath:   ${logPath}\n`);

const log = fs.createWriteStream(logPath, { flags: "a" });
const sep = `\n==== ${new Date().toISOString()} pid=${process.pid} ====\n`;
log.write(sep);

const term = pty.spawn("claude", args, {
  cwd: repoRoot,
  env: { ...process.env },
  cols: 120,
  rows: 40,
});

process.stderr.write(`ccb-launcher: pid=${term.pid}\n\n`);

let chunkCount = 0;
let byteCount = 0;
term.onData((chunk) => {
  chunkCount++;
  byteCount += chunk.length;
  process.stdout.write(chunk);
  const ts = process.hrtime.bigint();
  log.write(`[${ts}] [chunk#${chunkCount} ${chunk.length}B] ${JSON.stringify(chunk)}\n`);
});

term.onExit((e) => {
  process.stderr.write(
    `\nccb-launcher: claude exited code=${e.exitCode} signal=${e.signal} chunks=${chunkCount} bytes=${byteCount}\n`,
  );
  log.write(
    `[exit] code=${e.exitCode} signal=${e.signal} chunks=${chunkCount} bytes=${byteCount}\n`,
  );
  log.end();
  try {
    fs.unlinkSync(mcpConfigPath);
  } catch {
    /* best effort */
  }
  process.exit(e.exitCode || 0);
});

// Auto-confirm the dev-channels warning the same way the supervisor does:
// schedule \r writes at 500ms, then every 3s up to 6 attempts. This mirrors
// the production supervisor's behavior so the launcher exercises the same
// code path the bridge takes.
const CONFIRM_DELAYS_MS = [500, 3500, 6500, 9500, 12500, 15500];
let confirmFired = 0;
for (const delay of CONFIRM_DELAYS_MS) {
  setTimeout(() => {
    if (term.killed) return;
    confirmFired++;
    process.stderr.write(`[ccb-launcher] auto-confirm \\r #${confirmFired} at +${delay}ms\n`);
    log.write(`[ccb-launcher] auto-confirm \\r #${confirmFired} at +${delay}ms\n`);
    try {
      term.write("\r");
    } catch (err) {
      log.write(`[ccb-launcher] write failed: ${String(err)}\n`);
    }
  }, delay);
}

// Forward stdin (if a TTY) to the PTY so the launcher can be driven
// interactively. The bridge's channel notifications still flow over TCP;
// stdin here is for typing INTO claude directly.
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (d) => {
    try {
      term.write(d.toString("utf8"));
    } catch {
      /* best effort */
    }
  });
} else {
  process.stderr.write("[ccb-launcher] no TTY on stdin; harness will not forward input\n");
}

const shutdown = (signal) => {
  process.stderr.write(`\n[ccb-launcher] received ${signal}, killing claude\n`);
  try {
    term.kill("SIGINT");
  } catch {
    /* best effort */
  }
  setTimeout(() => {
    try {
      term.kill("SIGKILL");
    } catch {
      /* best effort */
    }
    process.exit(0);
  }, 2000);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
