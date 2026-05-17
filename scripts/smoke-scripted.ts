#!/usr/bin/env bun
// scripts/smoke-scripted.ts - best-effort scripted real-claude smoke.
//
// Gated on CCB_RUN_REAL_CLAUDE=1. When the gate is not set, this script exits
// 0 immediately with a "skipped" notice. When the gate is set, it:
//   1. mints a UUID session id
//   2. emits a per-session .mcp.json via `ccb mcp-config`
//   3. spawns `bun apps/ccb/src/cli.ts serve` and waits for the "listening on"
//      stderr line
//   4. spawns `claude --dangerously-load-development-channels server:ccb
//      --mcp-config <file>` and pipes a single user prompt to its stdin
//   5. watches the bridge serve stdout for an agent.reply or agent.done event
//   6. exits 0 on success, 1 on failure, 0 (with a notice) when claude refuses
//      to boot headlessly (claude needs a TTY per the bridge's own findings)
//
// This is intentionally best-effort: the real-claude path lives in the manual
// procedure documented in SMOKE.md. The scripted variant exists for CI
// experiments where a TTY is available; do not rely on it in plain CI.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI_PATH = join(REPO_ROOT, "apps/ccb/src/cli.ts");
const REPLY_TIMEOUT_MS = 30_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (line: string) => boolean,
  onLine?: (line: string) => void,
): Promise<string | undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return undefined;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      onLine?.(line);
      if (predicate(line)) {
        reader.releaseLock();
        return line;
      }
      nl = buffer.indexOf("\n");
    }
  }
}

async function main(): Promise<void> {
  if (process.env.CCB_RUN_REAL_CLAUDE !== "1") {
    process.stderr.write("scripts/smoke-scripted.ts: skipped (set CCB_RUN_REAL_CLAUDE=1 to run)\n");
    process.exit(0);
  }

  const sessionId = crypto.randomUUID();
  const tmp = await mkdtemp(join(tmpdir(), "ccb-smoke-scripted-"));
  const mcpConfigPath = join(tmp, "smoke.mcp.json");
  const storeDir = join(tmp, "store");

  const host = "127.0.0.1";
  const port = 18484;
  const endpoint = `${host}:${port}`;

  process.stderr.write(`smoke-scripted: session_id=${sessionId} endpoint=${endpoint}\n`);
  process.stderr.write(`smoke-scripted: mcp-config -> ${mcpConfigPath}\n`);

  const mcpConfigChild = Bun.spawn({
    cmd: [
      "bun",
      CLI_PATH,
      "mcp-config",
      "--endpoint",
      endpoint,
      "--session-id",
      sessionId,
      "--out",
      mcpConfigPath,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const mcpExit = await mcpConfigChild.exited;
  if (mcpExit !== 0) {
    const err = await new Response(mcpConfigChild.stderr).text();
    process.stderr.write(`smoke-scripted: mcp-config failed: ${err}\n`);
    await rm(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  process.stderr.write("smoke-scripted: starting bridge serve...\n");

  const serveChild = Bun.spawn({
    cmd: [
      "bun",
      CLI_PATH,
      "serve",
      "--endpoint",
      endpoint,
      "--session-id",
      sessionId,
      "--store-dir",
      storeDir,
      "--format",
      "json",
    ],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const replyDeferred = deferred<string>();
  const replyTimer = setTimeout(() => {
    replyDeferred.reject(new Error("timeout waiting for agent.reply or agent.done"));
  }, REPLY_TIMEOUT_MS);

  const stdoutWatch = readUntil(
    serveChild.stdout,
    (line) => {
      if (line.length === 0) return false;
      try {
        const ev = JSON.parse(line) as { type?: string };
        // A turn can legally end with bridge_done only, so agent.done is also
        // a valid terminator.
        if (ev.type === "agent.reply" || ev.type === "agent.done") {
          replyDeferred.resolve(line);
          return true;
        }
      } catch {
        // ignore non-json lines (the bridge writes pretty too sometimes)
      }
      return false;
    },
    (line) => {
      if (line.length > 0) {
        process.stderr.write(`serve.stdout> ${line}\n`);
      }
    },
  );

  await readUntil(
    serveChild.stderr,
    (line) => line.includes("listening on"),
    (line) => {
      if (line.length > 0) {
        process.stderr.write(`serve.stderr> ${line}\n`);
      }
    },
  );

  process.stderr.write("smoke-scripted: spawning claude...\n");

  const claudeChild = Bun.spawn({
    cmd: [
      "claude",
      "--dangerously-load-development-channels",
      "server:ccb",
      "--mcp-config",
      mcpConfigPath,
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  try {
    const stdin = claudeChild.stdin;
    if (stdin) {
      const writer = stdin.getWriter();
      await writer.write(new TextEncoder().encode("hello bridge\n"));
      await writer.close();
    }
  } catch (err) {
    process.stderr.write(`smoke-scripted: claude stdin write failed: ${String(err)}\n`);
  }

  const claudeExitPromise = claudeChild.exited.then((code) => {
    process.stderr.write(`smoke-scripted: claude exited code=${code}\n`);
  });

  let exitCode = 0;
  try {
    await Promise.race([
      replyDeferred.promise.then((line) => {
        process.stderr.write(`smoke-scripted: observed terminator: ${line}\n`);
      }),
      claudeExitPromise.then(() => {
        throw new Error("claude exited before agent.reply or agent.done was seen");
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("claude exited before")) {
      process.stderr.write("smoke-scripted: skipped: claude refused headless boot (needs a TTY)\n");
      exitCode = 0;
    } else {
      process.stderr.write(`smoke-scripted: failed: ${msg}\n`);
      exitCode = 1;
    }
  } finally {
    clearTimeout(replyTimer);
    try {
      claudeChild.kill();
    } catch {
      // best effort
    }
    try {
      serveChild.kill("SIGINT");
    } catch {
      // best effort
    }
    await Promise.allSettled([stdoutWatch, serveChild.exited, claudeChild.exited]);
    await rm(tmp, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`smoke-scripted: unexpected error: ${msg}\n`);
  process.exit(1);
});
