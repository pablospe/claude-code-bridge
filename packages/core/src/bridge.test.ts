import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, type BridgeEventStore } from "./bridge.ts";
import type { BridgeEvent } from "./events.ts";
import { JsonlEventStore } from "./store.ts";
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

  // No leftover internal session: sending to any id must reject as unknown.
  await expect(b.sendMessage("any-id", "x")).rejects.toThrow(/unknown session/);

  // No jsonl file should be left on disk.
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".jsonl"),
  );
  expect(files).toHaveLength(0);
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

test("close() drains pending appends and tears down even if supervisor.close throws", async () => {
  class BurstThenFailCloseSupervisor implements Supervisor {
    ctx: SupervisorContext | undefined;
    async start(ctx: SupervisorContext): Promise<void> {
      this.ctx = ctx;
      for (let i = 0; i < 5; i++) {
        ctx.emit({ type: "agent.progress", sessionId: ctx.sessionId, content: `tick-${i}` });
      }
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {
      throw new Error("supervisor close boom");
    }
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new BurstThenFailCloseSupervisor(),
  });
  const handle = await b.startSession({});

  await expect(b.close(handle.id)).rejects.toThrow("supervisor close boom");

  // events(id) returns an empty/closed iterable after close
  const seen: BridgeEvent[] = [];
  for await (const e of b.events(handle.id)) seen.push(e);
  expect(seen).toEqual([]);

  // second close is a no-op
  await expect(b.close(handle.id)).resolves.toBeUndefined();

  // JSONL is fully flushed: session.started + 5 progress + session.ended
  const stored = await b.readStoredEvents(handle.id);
  expect(stored[0]?.type).toBe("session.started");
  expect(stored.at(-1)?.type).toBe("session.ended");
  const progress = stored.filter((e) => e.type === "agent.progress");
  expect(progress).toHaveLength(5);
});

test("concurrent close() calls only emit session.ended once and call supervisor.close once", async () => {
  const handle = await bridge.startSession({});
  await Promise.all([bridge.close(handle.id), bridge.close(handle.id)]);

  expect(supervisor.closed).toEqual([handle.id]);
  const stored = await bridge.readStoredEvents(handle.id);
  const endedCount = stored.filter((e) => e.type === "session.ended").length;
  expect(endedCount).toBe(1);
});

test("sendMessage during close rejects with 'closing' and does not append after session.ended", async () => {
  class SlowCloseSupervisor implements Supervisor {
    async start(): Promise<void> {}
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new SlowCloseSupervisor(),
  });
  const handle = await b.startSession({});

  const closing = b.close(handle.id);
  // yield so close sets state to "closing"
  await new Promise((r) => setTimeout(r, 5));
  await expect(b.sendMessage(handle.id, "late")).rejects.toThrow(/closing/);
  await closing;

  const stored = await b.readStoredEvents(handle.id);
  expect(stored.at(-1)?.type).toBe("session.ended");
  expect(stored.find((e) => e.type === "message.sent")).toBeUndefined();
});

test("interrupt during close rejects with 'closing'", async () => {
  class SlowCloseSupervisor implements Supervisor {
    async start(): Promise<void> {}
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {
      await new Promise((r) => setTimeout(r, 30));
    }
  }
  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new SlowCloseSupervisor(),
  });
  const handle = await b.startSession({});

  const closing = b.close(handle.id);
  await new Promise((r) => setTimeout(r, 5));
  await expect(b.interrupt(handle.id)).rejects.toThrow(/closing/);
  await closing;
});

test("startSession with a supervisor that emits then throws leaves no jsonl file", async () => {
  class PartialEmitFailingSupervisor implements Supervisor {
    async start(ctx: SupervisorContext): Promise<void> {
      ctx.emit({ type: "agent.progress", sessionId: ctx.sessionId, content: "before-throw" });
      throw new Error("partial boom");
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new PartialEmitFailingSupervisor(),
  });
  await expect(b.startSession({})).rejects.toThrow("partial boom");
  // Give microtasks a chance to settle any straggling rejections.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) =>
    f.endsWith(".jsonl"),
  );
  expect(files).toHaveLength(0);
});

test("close() still runs supervisor.close even when session.ended persistence rejects", async () => {
  // Store wrapper that delegates to a real JsonlEventStore but rejects the
  // append for session.ended. supervisor.close MUST still be called and the
  // bus/store/map MUST still be torn down. The first error wins.
  class FailEndedStore implements BridgeEventStore {
    readonly #real: JsonlEventStore;
    constructor(path: string) {
      this.#real = new JsonlEventStore(path);
    }
    append(event: BridgeEvent): Promise<void> {
      if (event.type === "session.ended") {
        return Promise.reject(new Error("store append boom"));
      }
      return this.#real.append(event);
    }
    readAll(): Promise<BridgeEvent[]> {
      return this.#real.readAll();
    }
    close(): Promise<void> {
      return this.#real.close();
    }
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
    storeFactory: (_id, path) => new FailEndedStore(path),
  });

  const handle = await b.startSession({});
  await expect(b.close(handle.id)).rejects.toThrow("store append boom");

  // Resource cleanup happened despite the persistence failure.
  expect(supervisor.closed).toEqual([handle.id]);

  // Bus is closed: events(id) ends immediately.
  const seen: BridgeEvent[] = [];
  for await (const e of b.events(handle.id)) seen.push(e);
  expect(seen).toEqual([]);

  // Session removed from the map: second close is a no-op.
  await expect(b.close(handle.id)).resolves.toBeUndefined();
});

test("concurrent close() shares the in-flight teardown promise", async () => {
  class SlowCloseSupervisor implements Supervisor {
    closedAt: number | undefined;
    closeCalls = 0;
    async start(): Promise<void> {}
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {
      this.closeCalls++;
      await new Promise((r) => setTimeout(r, 50));
      this.closedAt = Date.now();
    }
  }
  const sup = new SlowCloseSupervisor();
  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => sup,
  });

  const handle = await b.startSession({});

  const p1 = b.close(handle.id);
  const p2 = b.close(handle.id);

  // Both must resolve at essentially the same time, because the second
  // call MUST await the same underlying teardown — not return early.
  const t1Promise = p1.then(() => Date.now());
  const t2Promise = p2.then(() => Date.now());
  const [t1, t2] = await Promise.all([t1Promise, t2Promise]);
  expect(Math.abs(t2 - t1)).toBeLessThan(5);

  expect(sup.closeCalls).toBe(1);
  const stored = await b.readStoredEvents(handle.id);
  const endedCount = stored.filter((e) => e.type === "session.ended").length;
  expect(endedCount).toBe(1);
});

test("supervisor events with wrong sessionId are dropped and logged", async () => {
  class WrongIdSupervisor implements Supervisor {
    ctx: SupervisorContext | undefined;
    async start(ctx: SupervisorContext): Promise<void> {
      this.ctx = ctx;
      ctx.emit({ type: "agent.progress", sessionId: "not-the-session", content: "leaked" });
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const originalError = console.error;
  let errorCalls = 0;
  console.error = () => {
    errorCalls++;
  };
  try {
    const b = new Bridge({
      storeDir: dir,
      supervisorFactory: () => new WrongIdSupervisor(),
    });
    const handle = await b.startSession({});
    await b.close(handle.id);

    const stored = await b.readStoredEvents(handle.id);
    expect(stored.find((e) => e.type === "agent.progress")).toBeUndefined();
    expect(errorCalls).toBeGreaterThanOrEqual(1);
  } finally {
    console.error = originalError;
  }
});
