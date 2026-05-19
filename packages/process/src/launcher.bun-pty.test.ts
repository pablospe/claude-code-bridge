import { expect, test } from "bun:test";
import { launch } from "./launcher.ts";

/**
 * Regression suite for oven-sh/bun#25822: under Bun on Linux, node-pty's
 * onData callback never fires because Bun's `tty.ReadStream(fd)` does not
 * emit `'data'` events for non-blocking PTY master fds. These tests use the
 * REAL `@homebridge/node-pty-prebuilt-multiarch` module (no `mock.module`)
 * so the polyfill in `launcher.ts` is actually exercised end-to-end.
 *
 * Skipped under Node (the bug is Bun-specific; the launcher's non-Bun branch
 * is the pre-fix code path and is already covered by `launcher.test.ts`).
 */

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

test.if(isBun)("Bun: onData fires for real PTY output (oven-sh/bun#25822)", async () => {
  const handle = launch("bash", ["-c", "echo hello world; sleep 0.05; echo bye"]);
  const chunks: string[] = [];
  handle.onData((c) => chunks.push(c));
  const exit = await handle.waitExit();
  expect(exit.code).toBe(0);
  const combined = chunks.join("");
  expect(chunks.length).toBeGreaterThan(0);
  expect(combined).toContain("hello world");
  expect(combined).toContain("bye");
});

test.if(isBun)("Bun: polling loop stops after child exit (no leaked timer)", async () => {
  const handle = launch("bash", ["-c", "echo done"]);
  const chunks: string[] = [];
  handle.onData((c) => chunks.push(c));
  const exit = await handle.waitExit();
  expect(exit.code).toBe(0);
  // Allow any in-flight read to drain; then assert no further chunks arrive.
  await new Promise((r) => setTimeout(r, 80));
  const before = chunks.length;
  await new Promise((r) => setTimeout(r, 80));
  expect(chunks.length).toBe(before);
});

test.if(isBun)("Bun: write -> echo round-trip via PTY", async () => {
  // `cat` echoes via the line discipline; this verifies bidirectional bytes
  // flow through both the polling read path and the underlying PTY master.
  const handle = launch("bash", ["-c", "stty -echo; cat"]);
  const chunks: string[] = [];
  handle.onData((c) => chunks.push(c));
  // Give the child a moment to settle before writing.
  await new Promise((r) => setTimeout(r, 100));
  handle.write("ping\n");
  // Poll for the echoed line.
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !chunks.join("").includes("ping")) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(chunks.join("")).toContain("ping");
  await handle.kill("signal");
  await handle.waitExit();
});
