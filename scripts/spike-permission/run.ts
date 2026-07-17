#!/usr/bin/env bun
// Throwaway driver for the permission-relay spike (Task 1 of M5). Launches the
// real locally-installed `claude` over a PTY via the repo's own launcher,
// declares the spike stdio MCP server as a development channel, drives a Bash
// tool call, and verifies:
//   phase A (default):       proof file written AND a permission_request arrived
//   phase B (--pre-approve): proof file written AND NO permission_request (pre-approved)
//
// Run from the repo root:  bun scripts/spike-permission/run.ts [--pre-approve]
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Import the launcher by relative path: workspace `@ccb/*` specifiers are not
// symlinked into node_modules, so a script outside a package can't resolve
// them. The launcher module is self-contained (its only external dep is the
// node-pty fork, resolved from the root node_modules).
import { launch } from "../../packages/process/src/launcher.ts";

const PRE_APPROVE = process.argv.includes("--pre-approve");

const SERVER_PATH = resolve(import.meta.dirname, "server.ts");

// Boot/timing budget. The auto-confirm blind \r writes must all land BEFORE we
// type the prompt, so they cannot accidentally answer the permission dialog.
const CONFIRM_FIRST_MS = 500;
const CONFIRM_INTERVAL_MS = 3_000;
const CONFIRM_MAX = 6; // last write lands at 500 + 5*3000 = 15_500ms
const PROMPT_AT_MS = 18_000;
const POLL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ccb-spike-"));
  const logPath = join(dir, "spike.log");
  const mcpPath = join(dir, "mcp.json");
  const proofPath = join(dir, "proof.txt");
  writeFileSync(logPath, "");

  const mcp = {
    mcpServers: {
      ccb: {
        command: process.execPath,
        args: [SERVER_PATH],
        env: { CCB_SPIKE_LOG: logPath },
      },
    },
  };
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2));

  const args = [
    "--dangerously-load-development-channels",
    "server:ccb",
    "--mcp-config",
    mcpPath,
    "--strict-mcp-config",
    "--setting-sources",
    "project,local",
    "--add-dir",
    dir,
  ];
  if (PRE_APPROVE) {
    args.push("--allowed-tools", "Bash");
  }

  // Rolling PTY tail for the debugging window.
  const ptyChunks: string[] = [];
  const pushPty = (chunk: string): void => {
    ptyChunks.push(chunk);
    if (ptyChunks.length > 400) ptyChunks.splice(0, ptyChunks.length - 400);
  };

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const launcher = launch("claude", args, { env });
  launcher.onData(pushPty);

  // Blind dev-channels confirm: \r at 500ms, then every 3s up to 6 writes.
  // All scheduled to complete by ~15.5s, well before the prompt at 18s.
  const confirmTimers: ReturnType<typeof setTimeout>[] = [];
  for (let i = 0; i < CONFIRM_MAX; i++) {
    const delay = CONFIRM_FIRST_MS + i * CONFIRM_INTERVAL_MS;
    confirmTimers.push(
      setTimeout(() => {
        try {
          launcher.write("\r");
        } catch {
          /* swallow */
        }
      }, delay),
    );
  }

  let sawRequest = false;
  let rawLog = "";
  let proof = false;

  const readLog = (): string => {
    try {
      return readFileSync(logPath, "utf8");
    } catch {
      return "";
    }
  };

  try {
    await sleep(PROMPT_AT_MS);

    // Type the prompt. Do NOT write any \r after this for the permission
    // dialog in phase A — the remote allow must be what unblocks the tool.
    const prompt = `Use the Bash tool to run exactly this command: touch ${proofPath}`;
    launcher.write(prompt);
    await sleep(200);
    launcher.write("\r");
    const promptTypedAt = Date.now();

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      rawLog = readLog();
      if (!sawRequest && rawLog.includes('"kind":"permission_request"')) {
        sawRequest = true;
        console.error(`[spike] permission_request observed at +${Date.now() - promptTypedAt}ms`);
      }
      if (!proof && existsSync(proofPath)) {
        proof = true;
        console.error(`[spike] proof file observed at +${Date.now() - promptTypedAt}ms`);
      }
      // Success conditions per phase.
      if (PRE_APPROVE) {
        if (proof) break; // phase B: don't wait the full window for absence
      } else if (proof && sawRequest) {
        break;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    rawLog = readLog();
  } finally {
    for (const t of confirmTimers) clearTimeout(t);
    try {
      await launcher.kill("graceful", { gracefulInput: "/exit\r" });
    } catch {
      try {
        await launcher.kill("signal");
      } catch {
        /* swallow */
      }
    }
  }

  const ok = PRE_APPROVE ? proof && !sawRequest : proof && sawRequest;

  const summary = {
    phase: PRE_APPROVE ? "B (--pre-approve)" : "A",
    preApprove: PRE_APPROVE,
    sawRequest,
    proof,
    ok,
    dir,
  };
  console.log("=== SPIKE SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("=== RAW SPIKE LOG ===");
  console.log(rawLog || "(empty)");
  if (!ok) {
    console.log("=== PTY TAIL ===");
    console.log(ptyChunks.join(""));
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[spike] fatal:", err);
  process.exit(2);
});
