import type { BridgeEvent } from "./events.ts";

/**
 * In-process pub/sub for BridgeEvent.
 *
 * Each subscriber owns a queue so a slow consumer cannot block emit().
 * The M1 queue is unbounded — backpressure can be added later if a real
 * consumer falls behind enough to matter. emit() is synchronous and
 * non-blocking.
 */
export class EventBus {
  readonly #subscribers = new Set<Subscriber>();
  #closed = false;

  emit(event: BridgeEvent): void {
    if (this.#closed) return;
    for (const sub of this.#subscribers) {
      sub.push(event);
    }
  }

  subscribe(): AsyncIterable<BridgeEvent> {
    if (this.#closed) {
      return emptyIterable();
    }
    const sub = new Subscriber(() => {
      this.#subscribers.delete(sub);
    });
    this.#subscribers.add(sub);
    return sub;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const sub of this.#subscribers) {
      sub.end();
    }
    this.#subscribers.clear();
  }
}

class Subscriber implements AsyncIterable<BridgeEvent> {
  readonly #queue: BridgeEvent[] = [];
  readonly #onDispose: () => void;
  #waiter: ((value: IteratorResult<BridgeEvent>) => void) | undefined;
  #ended = false;

  constructor(onDispose: () => void) {
    this.#onDispose = onDispose;
  }

  push(event: BridgeEvent): void {
    if (this.#ended) return;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = undefined;
      w({ value: event, done: false });
      return;
    }
    this.#queue.push(event);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#waiter) {
      const w = this.#waiter;
      this.#waiter = undefined;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<BridgeEvent> {
    return {
      next: (): Promise<IteratorResult<BridgeEvent>> => {
        const head = this.#queue.shift();
        if (head !== undefined) {
          return Promise.resolve({ value: head, done: false });
        }
        if (this.#ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.#waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<BridgeEvent>> => {
        this.#ended = true;
        this.#onDispose();
        if (this.#waiter) {
          const w = this.#waiter;
          this.#waiter = undefined;
          w({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function emptyIterable(): AsyncIterable<BridgeEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<BridgeEvent> {
      return {
        next: () => Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}
