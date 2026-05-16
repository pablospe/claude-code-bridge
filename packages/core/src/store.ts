import type { FileSink } from "bun";
import type { BridgeEvent } from "./events.ts";

/**
 * Append-only JSONL event store.
 *
 * readAll() returns a Promise<BridgeEvent[]>. For M1 sessions the per-session
 * log is small enough that materializing the full list is simpler than an
 * AsyncIterable. If logs grow beyond memory budgets a streaming variant can
 * be added without changing append().
 */
export class JsonlEventStore {
  readonly #path: string;
  #writer: FileSink | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async append(event: BridgeEvent): Promise<void> {
    if (!this.#writer) {
      this.#writer = Bun.file(this.#path).writer();
    }
    this.#writer.write(`${JSON.stringify(event)}\n`);
    await this.#writer.flush();
  }

  async readAll(): Promise<BridgeEvent[]> {
    const file = Bun.file(this.#path);
    if (!(await file.exists())) {
      return [];
    }
    const text = await file.text();
    if (text.length === 0) {
      return [];
    }
    const out: BridgeEvent[] = [];
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      out.push(JSON.parse(line) as BridgeEvent);
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.#writer) {
      await this.#writer.end();
      this.#writer = undefined;
    }
  }
}
