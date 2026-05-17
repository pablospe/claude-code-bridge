import { expect, test } from "bun:test";
import { type DrainableWritable, drainWritable } from "./drain.ts";

test("drainWritable resolves when the write callback fires", async () => {
  const stream: DrainableWritable = {
    write(_chunk, cb) {
      queueMicrotask(() => cb?.());
      return true;
    },
  };
  const start = Date.now();
  await drainWritable(stream, 500);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(100);
});

test("drainWritable resolves within timeoutMs when the callback never fires", async () => {
  const stream: DrainableWritable = {
    write() {
      // Callback intentionally dropped — simulates orphaned/wedged stdout.
      return false;
    },
  };
  const start = Date.now();
  await drainWritable(stream, 100);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeGreaterThanOrEqual(95);
  expect(elapsed).toBeLessThan(300);
});

test("drainWritable returns immediately when the stream is destroyed", async () => {
  const stream: DrainableWritable = {
    destroyed: true,
    write() {
      throw new Error("should not be called");
    },
  };
  const start = Date.now();
  await drainWritable(stream, 1000);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(50);
});

test("drainWritable swallows a synchronous write() throw and resolves", async () => {
  const stream: DrainableWritable = {
    write() {
      throw new Error("broken pipe");
    },
  };
  const start = Date.now();
  await drainWritable(stream, 1000);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(100);
});
