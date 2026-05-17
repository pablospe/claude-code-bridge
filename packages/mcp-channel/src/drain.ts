/**
 * Minimal Writable surface drainWritable needs. Avoids depending on the full
 * NodeJS.WriteStream type so a test can pass a stub.
 */
export interface DrainableWritable {
  readonly destroyed?: boolean;
  write(chunk: string, cb?: (err?: Error | null) => void): boolean;
}

/**
 * Wait for the empty-write callback to fire so the kernel has flushed any
 * pending bytes. Returns within timeoutMs even if the callback never fires
 * (orphaned/wedged stream) or if the stream is already destroyed.
 */
export function drainWritable(stream: DrainableWritable, timeoutMs: number): Promise<void> {
  if (stream.destroyed === true) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();
    }, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      stream.write("", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    }
  });
}
