import { afterEach, beforeEach, expect, test } from "bun:test";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
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

test("startSession returns a SessionHandle and persists session.started", async () => {
  const handle = await bridge.startSession({});
  expect(typeof handle.id).toBe("string");
  expect(handle.id.length).toBeGreaterThan(0);

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

test("session.started is persisted before any supervisor-emitted events", async () => {
  class EarlyEmitSupervisor implements Supervisor {
    async start(ctx: SupervisorContext): Promise<void> {
      ctx.emit({ type: "agent.progress", sessionId: ctx.sessionId, content: "early" });
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new EarlyEmitSupervisor(),
  });
  const handle = await b.startSession({});
  await b.close(handle.id);

  const stored = await b.readStoredEvents(handle.id);
  expect(stored[0]).toEqual({ type: "session.started", sessionId: handle.id });
  expect(stored[1]).toEqual({
    type: "agent.progress",
    sessionId: handle.id,
    content: "early",
  });
});

test("startSession cleans up when supervisor.start throws", async () => {
  class FailingSupervisor implements Supervisor {
    async start(): Promise<void> {
      throw new Error("boom");
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new FailingSupervisor(),
  });

  await expect(b.startSession({})).rejects.toThrow("boom");

  // Pick up the most recent jsonl file if any, and confirm no leftover state
  // by sending to a presumed-known id — the bridge should not have it.
  await expect(b.sendMessage("any-id", "x")).rejects.toThrow(/unknown session/);

  // No completed JSONL file should remain with a session.started in it.
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const text = await Bun.file(join(dir, f)).text();
    expect(text).toBe("");
  }
});

test("readStoredEvents rejects sessionIds that are not UUIDs", async () => {
  const handle = await bridge.startSession({});
  // sanity: valid UUID returns events
  const valid = await bridge.readStoredEvents(handle.id);
  expect(valid.length).toBeGreaterThan(0);

  await expect(bridge.readStoredEvents("../etc/passwd")).rejects.toThrow(/invalid sessionId/);
  await expect(bridge.readStoredEvents("foo/bar")).rejects.toThrow(/invalid sessionId/);

  // well-formed unknown UUID returns []
  const empty = await bridge.readStoredEvents("00000000-0000-0000-0000-000000000000");
  expect(empty).toEqual([]);

  await bridge.close(handle.id);
});

test("events emitted after close are dropped (no bus, no store)", async () => {
  const handle = await bridge.startSession({});
  const seen: BridgeEvent[] = [];
  const sub = bridge.events(handle.id);
  const drain = (async () => {
    for await (const e of sub) seen.push(e);
  })();

  await bridge.close(handle.id);
  await drain;

  // Supervisor pushes after close — should be silently dropped.
  supervisor.push({
    type: "agent.progress",
    sessionId: handle.id,
    content: "late",
  });

  // Give microtasks a chance to settle.
  await new Promise((resolve) => setTimeout(resolve, 10));

  // No "late" event should have hit the bus.
  expect(seen.find((e) => e.type === "agent.progress" && e.content === "late")).toBeUndefined();

  // No "late" event should be persisted either.
  const stored = await bridge.readStoredEvents(handle.id);
  expect(stored.find((e) => e.type === "agent.progress" && e.content === "late")).toBeUndefined();
});

test("close drains in-flight supervisor-emitted appends before tearing down", async () => {
  class BurstSupervisor implements Supervisor {
    ctx: SupervisorContext | undefined;
    async start(ctx: SupervisorContext): Promise<void> {
      this.ctx = ctx;
      for (let i = 0; i < 20; i++) {
        ctx.emit({ type: "agent.progress", sessionId: ctx.sessionId, content: `tick-${i}` });
      }
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new BurstSupervisor(),
  });
  const handle = await b.startSession({});
  await b.close(handle.id);

  const stored = await b.readStoredEvents(handle.id);
  // 1 session.started + 20 progress + 1 session.ended
  expect(stored).toHaveLength(22);
  expect(stored[0]?.type).toBe("session.started");
  expect(stored.at(-1)?.type).toBe("session.ended");
  const progress = stored.filter((e) => e.type === "agent.progress");
  expect(progress).toHaveLength(20);
});

test("startSession does not leave a file behind when supervisor.start rejects", async () => {
  class FailingSupervisor implements Supervisor {
    async start(): Promise<void> {
      throw new Error("nope");
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new FailingSupervisor(),
  });

  await expect(b.startSession({})).rejects.toThrow();
  // any jsonl files must be empty (no session.started leaked)
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".jsonl"),
  );
  for (const f of files) {
    const stat = await access(join(dir, f))
      .then(() => true)
      .catch(() => false);
    expect(stat).toBe(true);
    const text = await Bun.file(join(dir, f)).text();
    expect(text).toBe("");
  }
});
