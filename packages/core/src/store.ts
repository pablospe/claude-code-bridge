import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BridgeEvent } from "./events.ts";

/**
 * Append-only JSONL event store.
 *
 * readAll() returns a Promise<BridgeEvent[]>. For M1 sessions the per-session
 * log is small enough that materializing the full list is simpler than an
 * AsyncIterable. If logs grow beyond memory budgets a streaming variant can
 * be added without changing append().
 *
 * Appends are serialized through an internal promise chain so concurrent
 * callers cannot interleave partial writes. The parent directory is created
 * lazily on the first append.
 */
export class JsonlEventStore {
  readonly #path: string;
  #stream: WriteStream | undefined;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;
  #dirEnsured = false;

  constructor(path: string) {
    this.#path = path;
  }

  append(event: BridgeEvent): Promise<void> {
    const next = this.#chain.then(() => this.#writeLine(event));
    // Swallow on the chain so one failure doesn't poison subsequent appends.
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async readAll(): Promise<BridgeEvent[]> {
    // node:fs (not Bun.file) so the library runs under Node, not just Bun —
    // OpenClaw and other consumers embed this on the Node runtime. ENOENT is
    // the "no log yet" case and maps to an empty history.
    let text: string;
    try {
      text = await readFile(this.#path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
    if (text.length === 0) {
      return [];
    }
    const out: BridgeEvent[] = [];
    const lines = text.split(/\r?\n/);
    // If the file doesn't end with a newline the final element is a partial
    // write from a concurrent append-in-flight. Drop it rather than warning.
    if (!text.endsWith("\n")) {
      lines.pop();
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as BridgeEvent);
      } catch (err) {
        console.warn(
          `JsonlEventStore: skipping malformed line ${i + 1} in ${this.#path}: ${String(err)}`,
        );
      }
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    // Drain any in-flight appends BEFORE flipping the closed flag so a
    // fire-and-forget append in flight on the chain doesn't get rejected
    // by #writeLine's closed check.
    await this.#chain.catch(() => undefined);
    this.#closed = true;
    if (this.#stream) {
      const stream = this.#stream;
      this.#stream = undefined;
      await new Promise<void>((resolve, reject) => {
        stream.end((err?: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  async #writeLine(event: BridgeEvent): Promise<void> {
    if (this.#closed) {
      throw new Error("JsonlEventStore is closed");
    }
    await this.#ensureDir();
    const stream = this.#ensureStream();
    const line = `${JSON.stringify(event)}\n`;
    await new Promise<void>((resolve, reject) => {
      stream.write(line, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async #ensureDir(): Promise<void> {
    if (this.#dirEnsured) return;
    await mkdir(dirname(this.#path), { recursive: true });
    this.#dirEnsured = true;
  }

  #ensureStream(): WriteStream {
    if (!this.#stream) {
      const stream = createWriteStream(this.#path, { flags: "a" });
      // Out-of-band stream errors (lazy-open failures, ENOSPC mid-stream, EIO,
      // autoDestroy fallout) are emitted on the stream's 'error' event. With
      // no listener, Node would re-route to uncaughtException and crash the
      // process. Log instead so per-write callbacks still surface their own
      // errors normally.
      stream.on("error", (err) => {
        console.error(`JsonlEventStore: stream error on ${this.#path}: ${String(err)}`);
      });
      this.#stream = stream;
    }
    return this.#stream;
  }
}
