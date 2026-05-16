import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, type BridgeEvent } from "@ccb/core";
import { mockSupervisorFactory } from "./index.ts";

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-mock-supervisor-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

async function collect(
  iter: AsyncIterable<BridgeEvent>,
  predicate: (e: BridgeEvent) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<BridgeEvent[]> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const events: BridgeEvent[] = [];
  const start = Date.now();
  for await (const ev of iter) {
    events.push(ev);
    if (predicate(ev)) return events;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`collect: timeout after ${timeoutMs}ms`);
    }
  }
  return events;
}

test("MockSupervisor echoes input via channel + control loop", async () => {
  const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
  const { id } = await bridge.startSession({});

  const collected = collect(bridge.events(id), (e) => e.type === "agent.reply");

  await bridge.sendMessage(id, "hello world");
  const events = await collected;

  expect(events.map((e) => e.type)).toEqual(["message.sent", "agent.progress", "agent.reply"]);
  const progress = events[1];
  if (progress?.type !== "agent.progress") throw new Error("expected agent.progress");
  expect(progress.content).toBe("thinking");

  const reply = events[2];
  if (reply?.type !== "agent.reply") throw new Error("expected agent.reply");
  expect(reply.content).toBe("echo: hello world");
  expect(reply.final).toBe(true);

  await bridge.close(id);

  const stored = await bridge.readStoredEvents(id);
  expect(stored[stored.length - 1]?.type).toBe("session.ended");
});

test("MockSupervisor handles multiple messages in a single session", async () => {
  const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
  const { id } = await bridge.startSession({});

  const replies: string[] = [];
  const iterator = bridge.events(id);

  const collector = (async () => {
    for await (const ev of iterator) {
      if (ev.type === "agent.reply") {
        replies.push(ev.content);
        if (replies.length === 2) return;
      }
    }
  })();

  await bridge.sendMessage(id, "first");
  await bridge.sendMessage(id, "second");
  await collector;

  expect(replies).toEqual(["echo: first", "echo: second"]);

  await bridge.close(id);
});

test("MockSupervisor close completes promptly", async () => {
  const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
  const { id } = await bridge.startSession({});

  const start = Date.now();
  await bridge.close(id);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(500);
});
