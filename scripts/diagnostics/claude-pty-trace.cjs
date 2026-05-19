#!/usr/bin/env node
/**
 * claude-pty-trace.cjs — diagnostic harness for managed-launch debugging.
 *
 * Spawns `claude` under PTY with the exact args ClaudeCodeSupervisor would
 * generate, then tees every byte of PTY output to a log file. The harness
 * runs under Node (not Bun) so node-pty's NAPI bindings — specifically the
 * `onData` callback that Bun's NAPI compat layer drops silently — actually
 * fire. This gives full visibility into what claude prints during boot,
 * after the dev-channels Enter, and after channel notifications arrive.
 *
 * Usage:
 *   1. Start the bridge in one terminal:
 *        bun apps/ccb/src/cli.ts serve --endpoint 127.0.0.1:18484 \
 *          --session-id 11111111-2222-3333-4444-555555555555 --format json
 *   2. In a second terminal, run this harness pointing at the bridge:
 *        node scripts/diagnostics/claude-pty-trace.cjs \
 *          --endpoint 127.0.0.1:18484 \
 *          --session-id 11111111-2222-3333-4444-555555555555
 *   3. In a third terminal, type a prompt into the bridge's stdin to push a
 *      channel notification through. Observe what claude does in the trace
 *      log /tmp/claude-pty-trace.log (configurable via --log).
 *
 * The harness exits when claude exits (or on Ctrl-C). Logs are appended;
 * delete the file between runs if you want fresh output.
 */

const pty = require("@homebridge/node-pty-prebuilt-multiarch");
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
  process.stdout.write(`usage: node claude-pty-trace.cjs [options]\n\n`);
  process.stdout.write(`options:\n`);
  process.stdout.write(
    `  --endpoint <host:port>     bridge control endpoint (default 127.0.0.1:18484)\n`,
  );
  process.stdout.write(`  --session-id <uuid>        session id to claim (must match bridge)\n`);
  process.stdout.write(
    `  --log <path>               PTY trace log path (default /tmp/claude-pty-trace.log)\n`,
  );
  process.stdout.write(`  --mcp-config <path>        write the generated .mcp.json here\n`);
  process.exit(0);
}

const endpoint = opts.endpoint || process.env.CCB_BRIDGE_ENDPOINT || "127.0.0.1:18484";
const sessionId = opts["session-id"] || process.env.CCB_SESSION_ID;
const logPath = opts.log || "/tmp/claude-pty-trace.log";
const mcpConfigPath = opts["mcp-config"] || `/tmp/claude-pty-trace-${process.pid}.mcp.json`;

if (!sessionId) {
  process.stderr.write("error: --session-id is required (or set CCB_SESSION_ID)\n");
  process.exit(2);
}

const repoRoot = path.resolve(__dirname, "..", "..");
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

process.stderr.write(`claude-pty-trace: spawning claude\n`);
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

process.stderr.write(`claude-pty-trace: pid=${term.pid}\n\n`);

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
    `\nclaude-pty-trace: claude exited code=${e.exitCode} signal=${e.signal} chunks=${chunkCount} bytes=${byteCount}\n`,
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
// the production supervisor's behavior so the harness exercises the same
// code path the bridge takes.
const CONFIRM_DELAYS_MS = [500, 3500, 6500, 9500, 12500, 15500];
let confirmFired = 0;
for (const delay of CONFIRM_DELAYS_MS) {
  setTimeout(() => {
    if (term.killed) return;
    confirmFired++;
    process.stderr.write(`[harness] auto-confirm \\r #${confirmFired} at +${delay}ms\n`);
    log.write(`[harness] auto-confirm \\r #${confirmFired} at +${delay}ms\n`);
    try {
      term.write("\r");
    } catch (err) {
      log.write(`[harness] write failed: ${String(err)}\n`);
    }
  }, delay);
}

// Forward stdin (if a TTY) to the PTY so the harness can be driven
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
  process.stderr.write("[harness] no TTY on stdin; harness will not forward input\n");
}

const shutdown = (signal) => {
  process.stderr.write(`\n[harness] received ${signal}, killing claude\n`);
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
