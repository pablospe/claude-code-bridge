#!/usr/bin/env bun
// scripts/smoke-scripted.ts - end-to-end scripted real-claude smoke.
//
// Gated on CCB_RUN_REAL_CLAUDE=1. When the gate is not set the script writes a
// notice on stderr and exits 0 (skipped). When the gate is set:
//
//   1. Creates a fresh temp store directory (per-session JSONL lands here).
//   2. Spawns `bun apps/ccb/src/cli.ts demo --supervisor=claude --format=json
//      --store-dir=<tmp> "<prompt>"`. The managed-launch supervisor owns the
//      `claude` process for the lifetime of the turn.
//   3. Waits for the demo to exit. If it exits 0, scans the store dir for the
//      JSONL log it wrote and asserts at least one terminator event is
//      present (an `agent.reply{final:true}` or an `agent.done`).
//   4. Returns exit 1 if the JSONL log is missing or contains no terminator.
//
// Fallback ("skipped" with exit 0): when managed launch cannot even start —
// for example node-pty cannot load on this host — the demo command surfaces a
// `LauncherUnavailableError`. The script detects that signature on stderr and
// exits 0 with a clear "skipped" notice. This keeps the script honest on hosts
// where managed launch is impossible without faking the positive path.
//
// Cleanup: any spawned child is killed on exit and the temp directory is
// removed unconditionally.
//
// Exit codes:
//   0 - success (terminator observed) OR skipped (gate unset, or node-pty
//       unavailable on this host)
//   1 - failure (demo non-zero, JSONL missing, or no terminator in JSONL)

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI_PATH = join(REPO_ROOT, "apps/ccb/src/cli.ts");
const DEMO_TIMEOUT_MS = 90_000;
const DEFAULT_PROMPT = "ping";

interface DemoOutcome {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return await new Response(stream).text();
}

async function runDemo(storeDir: string, prompt: string): Promise<DemoOutcome> {
  const child = Bun.spawn({
    cmd: [
      "bun",
      CLI_PATH,
      "demo",
      "--supervisor=claude",
      "--format=json",
      `--store-dir=${storeDir}`,
      `--timeout-ms=${DEMO_TIMEOUT_MS}`,
      prompt,
    ],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  let timedOut = false;
  const watchdog = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
  }, DEMO_TIMEOUT_MS + 5_000);
  (watchdog as { unref?: () => void }).unref?.();

  // Tee both pipes so we can echo progress while still capturing the whole
  // buffer. The demo's `--format=json` writes one event per stdout line.
  const [stdout, stderr, exitCode] = await Promise.all([
    readAll(child.stdout).then((s) => {
      for (const line of s.split("\n")) {
        if (line.length > 0) process.stderr.write(`demo.stdout> ${line}\n`);
      }
      return s;
    }),
    readAll(child.stderr).then((s) => {
      for (const line of s.split("\n")) {
        if (line.length > 0) process.stderr.write(`demo.stderr> ${line}\n`);
      }
      return s;
    }),
    child.exited,
  ]);

  clearTimeout(watchdog);
  return { exitCode, stdout, stderr, timedOut };
}

function looksLikeLauncherUnavailable(stderr: string): boolean {
  // The typed error surfaces when the JS catch path runs. Bun on some Linux
  // hosts panics in the NAPI loader before the JS layer sees the failure, so
  // also detect the panic signature (`unsupported uv function` or
  // `Crashed while loading native module` with `node-pty` in the path).
  return (
    stderr.includes("LauncherUnavailableError") ||
    stderr.includes("node-pty failed to load") ||
    stderr.includes("managed launch is unavailable") ||
    (stderr.includes("unsupported uv function") && stderr.includes("node-pty")) ||
    (stderr.includes("Crashed while loading native module") && stderr.includes("node-pty"))
  );
}

interface TerminatorScan {
  readonly jsonlPath: string | undefined;
  readonly terminator: unknown | undefined;
}

async function scanStoreForTerminator(storeDir: string): Promise<TerminatorScan> {
  let entries: string[];
  try {
    entries = await readdir(storeDir);
  } catch {
    return { jsonlPath: undefined, terminator: undefined };
  }
  const jsonlFiles = entries.filter((f) => f.endsWith(".jsonl"));
  if (jsonlFiles.length === 0) {
    return { jsonlPath: undefined, terminator: undefined };
  }
  // Multiple jsonl files in a fresh store dir would mean the demo started more
  // than one session; we only spawn one. Scan all of them just in case and
  // return the first match.
  for (const file of jsonlFiles) {
    const path = join(storeDir, file);
    const content = await readFile(path, "utf8");
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      let event: { type?: string; final?: boolean } | undefined;
      try {
        event = JSON.parse(line) as { type?: string; final?: boolean };
      } catch {
        continue;
      }
      if (!event || typeof event.type !== "string") continue;
      if (event.type === "agent.done") {
        return { jsonlPath: path, terminator: event };
      }
      if (event.type === "agent.reply" && event.final === true) {
        return { jsonlPath: path, terminator: event };
      }
    }
    // No terminator in this file; keep the path around so the failure
    // message can point at it.
    return { jsonlPath: path, terminator: undefined };
  }
  return { jsonlPath: undefined, terminator: undefined };
}

async function main(): Promise<void> {
  if (process.env.CCB_RUN_REAL_CLAUDE !== "1") {
    process.stderr.write("scripts/smoke-scripted.ts: skipped (set CCB_RUN_REAL_CLAUDE=1 to run)\n");
    process.exit(0);
  }

  const prompt = process.argv[2] ?? DEFAULT_PROMPT;
  const storeDir = await mkdtemp(join(tmpdir(), "ccb-smoke-scripted-"));
  process.stderr.write(`smoke-scripted: store-dir=${storeDir}\n`);
  process.stderr.write(`smoke-scripted: prompt=${JSON.stringify(prompt)}\n`);
  process.stderr.write("smoke-scripted: running managed-launch demo...\n");

  let exitCode = 1;
  try {
    const demo = await runDemo(storeDir, prompt);

    if (demo.timedOut) {
      process.stderr.write(
        `smoke-scripted: failed: demo timed out after ${DEMO_TIMEOUT_MS + 5_000}ms\n`,
      );
      exitCode = 1;
      return;
    }

    if (demo.exitCode !== 0) {
      if (looksLikeLauncherUnavailable(demo.stderr)) {
        process.stderr.write(
          "smoke-scripted: skipped: node-pty is unavailable on this host (managed launch cannot start)\n",
        );
        exitCode = 0;
        return;
      }
      process.stderr.write(`smoke-scripted: failed: demo exited code=${demo.exitCode}\n`);
      exitCode = 1;
      return;
    }

    const scan = await scanStoreForTerminator(storeDir);
    if (!scan.jsonlPath) {
      process.stderr.write(`smoke-scripted: failed: no JSONL log written under ${storeDir}\n`);
      exitCode = 1;
      return;
    }
    if (!scan.terminator) {
      process.stderr.write(
        `smoke-scripted: failed: ${scan.jsonlPath} contains no agent.reply{final:true} or agent.done\n`,
      );
      exitCode = 1;
      return;
    }
    process.stderr.write(
      `smoke-scripted: ok: terminator observed in ${scan.jsonlPath}: ${JSON.stringify(scan.terminator)}\n`,
    );
    exitCode = 0;
  } finally {
    try {
      await rm(storeDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    process.exit(exitCode);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`smoke-scripted: unexpected error: ${msg}\n`);
  process.exit(1);
});
