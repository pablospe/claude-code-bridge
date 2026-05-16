import { expect, test } from "bun:test";
import { EventBus } from "./bus.ts";
import type { BridgeEvent } from "./events.ts";

async function collect(iter: AsyncIterable<BridgeEvent>, count: number): Promise<BridgeEvent[]> {
  const out: BridgeEvent[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

test("multiple subscribers each see all emitted events", async () => {
  const bus = new EventBus();
  const a = bus.subscribe();
  const b = bus.subscribe();

  const events: BridgeEvent[] = [
    { type: "session.started", sessionId: "s1" },
    { type: "agent.progress", sessionId: "s1", content: "tick" },
    { type: "agent.reply", sessionId: "s1", content: "ok", final: true },
  ];
  for (const e of events) bus.emit(e);

  const [seenA, seenB] = await Promise.all([collect(a, 3), collect(b, 3)]);
  expect(seenA).toEqual(events);
  expect(seenB).toEqual(events);

  bus.close();
});

test("subscriber added after some events sees only future events", async () => {
  const bus = new EventBus();
  bus.emit({ type: "session.started", sessionId: "s1" });

  const sub = bus.subscribe();
  bus.emit({ type: "agent.reply", sessionId: "s1", content: "x", final: true });

  const seen = await collect(sub, 1);
  expect(seen).toEqual([{ type: "agent.reply", sessionId: "s1", content: "x", final: true }]);

  bus.close();
});

test("breaking the for-await loop stops further deliveries", async () => {
  const bus = new EventBus();
  const sub = bus.subscribe();

  bus.emit({ type: "session.started", sessionId: "s1" });

  let count = 0;
  for await (const _e of sub) {
    count++;
    break;
  }
  expect(count).toBe(1);

  bus.emit({ type: "agent.progress", sessionId: "s1", content: "ignored" });

  expect(count).toBe(1);
  bus.close();
});

test("close() ends all subscriber iterations", async () => {
  const bus = new EventBus();
  const a = bus.subscribe();
  const b = bus.subscribe();

  const collectAll = async (iter: AsyncIterable<BridgeEvent>) => {
    const seen: BridgeEvent[] = [];
    for await (const e of iter) seen.push(e);
    return seen;
  };

  const pa = collectAll(a);
  const pb = collectAll(b);

  bus.emit({ type: "session.started", sessionId: "s1" });
  bus.close();

  const [seenA, seenB] = await Promise.all([pa, pb]);
  expect(seenA).toHaveLength(1);
  expect(seenB).toHaveLength(1);
});

test("events emitted before subscribers iterate are buffered per subscriber", async () => {
  const bus = new EventBus();
  const sub = bus.subscribe();

  bus.emit({ type: "session.started", sessionId: "s1" });
  bus.emit({ type: "agent.progress", sessionId: "s1", content: "hi" });

  const out = await collect(sub, 2);
  expect(out).toHaveLength(2);
  expect(out[0]?.type).toBe("session.started");
  expect(out[1]?.type).toBe("agent.progress");

  bus.close();
});
