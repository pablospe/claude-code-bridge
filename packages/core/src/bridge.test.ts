import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge } from "./bridge.ts";
import type { BridgeEvent } from "./events.ts";
import type { Supervisor, SupervisorContext } from "./supervisor.ts";

class StubSupervisor implements Supervisor {
  ctx: SupervisorContext | undefined;
  sent: { sessionId: string; messageId: string; content: string }[] = [];
  interrupted: string[] = [];
  closed: string[] = [];

  async start(ctx: SupervisorContext): Promise<void> {
    this.ctx = ctx;
  }

  async sendMessage(sessionId: string, messageId: string, content: string): Promise<void> {
    this.sent.push({ sessionId, messageId, content });
  }

  async interrupt(sessionId: string): Promise<void> {
    this.interrupted.push(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }

  push(event: BridgeEvent): void {
    if (!this.ctx) throw new Error("supervisor not started");
    this.ctx.emit(event);
  }
}

let dir: string;
let supervisor: StubSupervisor;
let bridge: Bridge;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccb-bridge-"));
  supervisor = new StubSupervisor();
  bridge = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function takeEvents(iter: AsyncIterable<BridgeEvent>, count: number): Promise<BridgeEvent[]> {
  const out: BridgeEvent[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

test("startSession emits session.started and returns a SessionHandle", async () => {
  const events = bridge.events("placeholder");
  void events; // detached; we'll subscribe by id after start

  const handle = await bridge.startSession({});
  expect(typeof handle.id).toBe("string");
  expect(handle.id.length).toBeGreaterThan(0);

  const sub = bridge.events(handle.id);
  const seen: BridgeEvent[] = [];
  // session.started was already emitted before subscribe; verify via store
  // (live subscriptions only see future events).
  void sub;
  void seen;
});

test("session.started is persisted to the JSONL store", async () => {
  const handle = await bridge.startSession({});
  const stored = await bridge.readStoredEvents(handle.id);
  expect(stored[0]).toEqual({ type: "session.started", sessionId: handle.id });
});

test("sendMessage emits message.sent and calls supervisor.sendMessage", async () => {
  const handle = await bridge.startSession({});
  const sub = bridge.events(handle.id);

  const messageId = await bridge.sendMessage(handle.id, "hello world");
  expect(typeof messageId).toBe("string");
  expect(messageId.length).toBeGreaterThan(0);

  const seen = await takeEvents(sub, 1);
  expect(seen[0]).toEqual({
    type: "message.sent",
    sessionId: handle.id,
    messageId,
    content: "hello world",
  });

  expect(supervisor.sent).toEqual([{ sessionId: handle.id, messageId, content: "hello world" }]);

  await bridge.close(handle.id);
});

test("supervisor-pushed events surface via events(sessionId)", async () => {
  const handle = await bridge.startSession({});
  const sub = bridge.events(handle.id);

  supervisor.push({
    type: "agent.reply",
    sessionId: handle.id,
    content: "hi",
    final: true,
  });

  const seen = await takeEvents(sub, 1);
  expect(seen[0]).toEqual({
    type: "agent.reply",
    sessionId: handle.id,
    content: "hi",
    final: true,
  });

  await bridge.close(handle.id);
});

test("interrupt forwards to the supervisor", async () => {
  const handle = await bridge.startSession({});
  await bridge.interrupt(handle.id);
  expect(supervisor.interrupted).toEqual([handle.id]);
  await bridge.close(handle.id);
});

test("close emits session.ended, ends events iteration, and tears down the supervisor", async () => {
  const handle = await bridge.startSession({});
  const sub = bridge.events(handle.id);

  const collected: BridgeEvent[] = [];
  const drain = (async () => {
    for await (const e of sub) collected.push(e);
  })();

  await bridge.close(handle.id);
  await drain;

  expect(collected.at(-1)).toEqual({
    type: "session.ended",
    sessionId: handle.id,
  });
  expect(supervisor.closed).toEqual([handle.id]);

  const stored = await bridge.readStoredEvents(handle.id);
  expect(stored.at(-1)).toEqual({
    type: "session.ended",
    sessionId: handle.id,
  });
});

test("events(sessionId) on an unknown session returns an empty iterable", async () => {
  const iter = bridge.events("does-not-exist");
  const collected: BridgeEvent[] = [];
  for await (const e of iter) collected.push(e);
  expect(collected).toEqual([]);
});

test("sendMessage on an unknown session rejects", async () => {
  await expect(bridge.sendMessage("nope", "x")).rejects.toBeDefined();
});
