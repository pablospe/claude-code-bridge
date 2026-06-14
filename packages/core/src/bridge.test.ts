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
  readonly responded: Array<{ sessionId: string; requestId: string; behavior: "allow" | "deny" }> =
    [];

  async start(ctx: SupervisorContext): Promise<void> {
    this.ctx = ctx;
  }

  async respond(sessionId: string, requestId: string, behavior: "allow" | "deny"): Promise<void> {
    this.responded.push({ sessionId, requestId, behavior });
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

test("close bounds supervisor.close with closeTimeoutMs and still tears down", async () => {
  class HangingCloseSupervisor implements Supervisor {
    async start(): Promise<void> {}
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {
      return new Promise<void>(() => {});
    }
  }

  const originalError = console.error;
  console.error = () => {};
  try {
    const b = new Bridge({
      storeDir: dir,
      supervisorFactory: () => new HangingCloseSupervisor(),
      closeTimeoutMs: 100,
    });
    const handle = await b.startSession({});

    const start = Date.now();
    await b.close(handle.id);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(800);

    // Bus is closed; events(id) ends immediately.
    const seen: BridgeEvent[] = [];
    for await (const e of b.events(handle.id)) seen.push(e);
    expect(seen).toEqual([]);
  } finally {
    console.error = originalError;
  }
});

test("close: late-rejecting supervisor.close after timeout does not produce an unhandledRejection", async () => {
  // Supervisor.close rejects AFTER the timeout fires. The bridge must attach a
  // catch handler to the in-flight promise before racing so the late rejection
  // does not surface as a process-level unhandledRejection.
  class LateRejectSupervisor implements Supervisor {
    async start(): Promise<void> {}
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {
      return new Promise<void>((_resolve, reject) => {
        const t = setTimeout(() => reject(new Error("late close failure")), 200);
        t.unref?.();
      });
    }
  }

  const originalError = console.error;
  console.error = () => {};
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const b = new Bridge({
      storeDir: dir,
      supervisorFactory: () => new LateRejectSupervisor(),
      closeTimeoutMs: 100,
    });
    const handle = await b.startSession({});
    await b.close(handle.id);
    // Wait long enough for the late rejection to settle.
    await new Promise((r) => setTimeout(r, 500));
    expect(unhandled.length).toBe(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    console.error = originalError;
  }
});

test("close: classifies timeout via sentinel, not message string", async () => {
  // A supervisor.close rejection whose message HAPPENS to match the current
  // bridge timeout text must NOT be treated as the timeout sentinel. With the
  // brittle message-equality classifier this case is silently swallowed
  // (logged, never rethrown) — a real error vanishes. The sentinel-based
  // classifier surfaces the actual rejection.
  class TrickyMessageSupervisor implements Supervisor {
    async start(): Promise<void> {}
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {
      throw new Error("supervisor.close timed out after 100ms");
    }
  }

  const originalError = console.error;
  console.error = () => {};
  try {
    const b = new Bridge({
      storeDir: dir,
      supervisorFactory: () => new TrickyMessageSupervisor(),
      closeTimeoutMs: 100,
    });
    const handle = await b.startSession({});
    await expect(b.close(handle.id)).rejects.toThrow("supervisor.close timed out after 100ms");
  } finally {
    console.error = originalError;
  }
});

test("emit path surfaces persistent store failures as agent.done with reason", async () => {
  class AlwaysFailStore implements BridgeEventStore {
    append(event: BridgeEvent): Promise<void> {
      if (event.type === "agent.progress") {
        return Promise.reject(new Error("store kaput"));
      }
      return Promise.resolve();
    }
    async readAll(): Promise<BridgeEvent[]> {
      return [];
    }
    async close(): Promise<void> {}
  }

  class LaterBurstSupervisor implements Supervisor {
    ctx: SupervisorContext | undefined;
    async start(ctx: SupervisorContext): Promise<void> {
      this.ctx = ctx;
    }
    async sendMessage(_sid: string, _mid: string, _c: string): Promise<void> {
      const ctx = this.ctx;
      if (!ctx) return;
      for (let i = 0; i < 5; i++) {
        ctx.emit({ type: "agent.progress", sessionId: ctx.sessionId, content: `tick-${i}` });
      }
    }
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const originalError = console.error;
  console.error = () => {};
  try {
    const b = new Bridge({
      storeDir: dir,
      supervisorFactory: () => new LaterBurstSupervisor(),
      storeFactory: () => new AlwaysFailStore(),
    });
    const seen: BridgeEvent[] = [];
    const handle = await b.startSession({});
    const drain = (async () => {
      for await (const e of b.events(handle.id)) seen.push(e);
    })();
    // sendMessage triggers the burst AFTER subscription is live so the bus
    // delivers the resulting agent.done to the drain.
    await b.sendMessage(handle.id, "go");
    // Yield enough microtasks for the rejected appends to settle and the
    // third failure to emit agent.done.
    await new Promise((r) => setTimeout(r, 20));
    await b.close(handle.id);
    await drain;

    const done = seen.find((e) => e.type === "agent.done");
    expect(done).toBeDefined();
    if (done?.type === "agent.done") {
      expect(done.reason).toBe("store-error");
    }
  } finally {
    console.error = originalError;
  }
});

test("emit path: consecutive store failures escalate regardless of error message", async () => {
  // Three failures with DIFFERENT error messages must still escalate to
  // agent.done — the threshold is consecutive failures, not consecutive
  // identical messages.
  const messages = ["EIO", "ENOSPC", "EIO"];
  class VariedErrorStore implements BridgeEventStore {
    #i = 0;
    append(event: BridgeEvent): Promise<void> {
      if (event.type === "agent.progress") {
        const msg = messages[this.#i] ?? "unknown";
        this.#i++;
        return Promise.reject(new Error(msg));
      }
      return Promise.resolve();
    }
    async readAll(): Promise<BridgeEvent[]> {
      return [];
    }
    async close(): Promise<void> {}
  }

  class BurstSupervisor implements Supervisor {
    ctx: SupervisorContext | undefined;
    async start(ctx: SupervisorContext): Promise<void> {
      this.ctx = ctx;
    }
    async sendMessage(): Promise<void> {
      const ctx = this.ctx;
      if (!ctx) return;
      for (let i = 0; i < 3; i++) {
        ctx.emit({ type: "agent.progress", sessionId: ctx.sessionId, content: `tick-${i}` });
      }
    }
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const originalError = console.error;
  console.error = () => {};
  try {
    const b = new Bridge({
      storeDir: dir,
      supervisorFactory: () => new BurstSupervisor(),
      storeFactory: () => new VariedErrorStore(),
    });
    const seen: BridgeEvent[] = [];
    const handle = await b.startSession({});
    const drain = (async () => {
      for await (const e of b.events(handle.id)) seen.push(e);
    })();
    await b.sendMessage(handle.id, "go");
    await new Promise((r) => setTimeout(r, 20));
    await b.close(handle.id);
    await drain;

    const done = seen.find((e) => e.type === "agent.done");
    expect(done).toBeDefined();
    if (done?.type === "agent.done") {
      expect(done.reason).toBe("store-error");
    }
  } finally {
    console.error = originalError;
  }
});

test("emit path: storeErrorNotified re-arms after a successful append", async () => {
  // Pattern: 3 fails -> success -> 3 fails. Each burst-of-3 must emit its own
  // agent.done, because the success in the middle re-arms the latch.
  let phase: "fail" | "ok" = "fail";
  class ToggleStore implements BridgeEventStore {
    append(event: BridgeEvent): Promise<void> {
      if (event.type !== "agent.progress") return Promise.resolve();
      if (phase === "fail") return Promise.reject(new Error("boom"));
      return Promise.resolve();
    }
    async readAll(): Promise<BridgeEvent[]> {
      return [];
    }
    async close(): Promise<void> {}
  }

  class CtrlSupervisor implements Supervisor {
    ctx: SupervisorContext | undefined;
    async start(ctx: SupervisorContext): Promise<void> {
      this.ctx = ctx;
    }
    async sendMessage(_sid: string, _mid: string, content: string): Promise<void> {
      const ctx = this.ctx;
      if (!ctx) return;
      const n = Number(content);
      for (let i = 0; i < n; i++) {
        ctx.emit({ type: "agent.progress", sessionId: ctx.sessionId, content: `tick-${i}` });
      }
    }
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  const originalError = console.error;
  console.error = () => {};
  try {
    const b = new Bridge({
      storeDir: dir,
      supervisorFactory: () => new CtrlSupervisor(),
      storeFactory: () => new ToggleStore(),
    });
    const seen: BridgeEvent[] = [];
    const handle = await b.startSession({});
    const drain = (async () => {
      for await (const e of b.events(handle.id)) seen.push(e);
    })();

    // 3 failing appends.
    phase = "fail";
    await b.sendMessage(handle.id, "3");
    await new Promise((r) => setTimeout(r, 20));

    // 1 successful append to re-arm the latch and reset the counter.
    phase = "ok";
    await b.sendMessage(handle.id, "1");
    await new Promise((r) => setTimeout(r, 20));

    // Another 3 failing appends.
    phase = "fail";
    await b.sendMessage(handle.id, "3");
    await new Promise((r) => setTimeout(r, 20));

    await b.close(handle.id);
    await drain;

    const dones = seen.filter((e) => e.type === "agent.done");
    expect(dones.length).toBe(2);
    for (const d of dones) {
      if (d.type === "agent.done") {
        expect(d.reason).toBe("store-error");
      }
    }
  } finally {
    console.error = originalError;
  }
});

test("supervisor-emitted session.ended and user close() dedup: supervisor.close runs once", async () => {
  // Race scenario from the M2 review pass:
  //
  //   1. supervisor.start resolves; bridge transitions to "open".
  //   2. Supervisor schedules ctx.emit({type:"session.ended"}) via setImmediate.
  //   3. User awaits a microtask and calls bridge.close(id) ~simultaneously.
  //
  // Whoever wins the race must claim the teardown; the loser must dedup on
  // session.closingPromise. supervisor.close runs once, session.ended appears
  // in the JSONL once, both call paths resolve to the same outcome.
  let emit: ((e: BridgeEvent) => void) | undefined;
  const closeCalls: string[] = [];
  class TerminalEmitSupervisor implements Supervisor {
    async start(ctx: SupervisorContext): Promise<void> {
      emit = ctx.emit;
      setImmediate(() => {
        emit?.({ type: "session.ended", sessionId: ctx.sessionId });
      });
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(sessionId: string): Promise<void> {
      closeCalls.push(sessionId);
    }
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new TerminalEmitSupervisor(),
  });

  const handle = await b.startSession({});

  // Kick off both close paths in adjacent microtasks. The supervisor-emitted
  // session.ended will fire on the next macrotask (setImmediate); the user
  // close is invoked synchronously inline. Whichever wins, both must dedup.
  const userClose = b.close(handle.id);
  // Wait long enough for the setImmediate-driven supervisor emission to land
  // and for any race window inside the bridge to surface.
  await new Promise((r) => setTimeout(r, 20));
  const secondClose = b.close(handle.id);

  const [a, c] = await Promise.all([userClose, secondClose]);
  expect(a).toBeUndefined();
  expect(c).toBeUndefined();

  // supervisor.close called exactly once across all paths.
  expect(closeCalls).toEqual([handle.id]);

  // session.ended persisted exactly once.
  const stored = await b.readStoredEvents(handle.id);
  const endedCount = stored.filter((e) => e.type === "session.ended").length;
  expect(endedCount).toBe(1);
});

test("supervisor-initiated close re-entrancy: closingPromise set before supervisor.close runs", async () => {
  // Synchronous re-entrancy window in the supervisor-initiated close path.
  // When the supervisor emits session.ended, the bridge synchronously calls
  // session.supervisor.close() inside #runClose. If supervisor.close re-enters
  // bridge.close (e.g. a fan-out handler), session.closingPromise MUST already
  // be set — otherwise the re-entrant call falls through, runs a second
  // #runClose pass, and supervisor.close fires twice.
  //
  // Repro: ReentrantSupervisor emits session.ended via setImmediate, and its
  // close() synchronously calls bridge.close(id). The second call must dedup.
  let bridgeRef: Bridge | undefined;
  let sessionRef: string | undefined;
  const closeCalls: string[] = [];
  class ReentrantSupervisor implements Supervisor {
    async start(ctx: SupervisorContext): Promise<void> {
      setImmediate(() => {
        ctx.emit({ type: "session.ended", sessionId: ctx.sessionId });
      });
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(sessionId: string): Promise<void> {
      closeCalls.push(sessionId);
      // Synchronously re-enter bridge.close while close is mid-flight.
      // closingPromise must already be set on the session at this point.
      if (bridgeRef && sessionRef) {
        bridgeRef.close(sessionRef).catch(() => undefined);
      }
    }
  }

  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => new ReentrantSupervisor(),
  });
  bridgeRef = b;
  const handle = await b.startSession({});
  sessionRef = handle.id;

  // Let the supervisor-emitted session.ended drive teardown end-to-end.
  await new Promise((r) => setTimeout(r, 50));

  // supervisor.close fired exactly once even with re-entrant bridge.close.
  expect(closeCalls).toEqual([handle.id]);

  // session.ended persisted exactly once.
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

function pushPermissionRequest(
  sup: StubSupervisor,
  sessionId: string,
  requestId: string,
  toolName = "Bash",
): void {
  sup.push({
    type: "permission.requested",
    sessionId,
    requestId,
    toolName,
    description: "d",
    inputPreview: "{}",
  });
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

test("respond(allow) persists permission.resolved before forwarding to the supervisor", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");

  await bridge.respond(handle.id, "abcde", "allow");

  expect(supervisor.responded).toEqual([
    { sessionId: handle.id, requestId: "abcde", behavior: "allow" },
  ]);

  const stored = await bridge.readStoredEvents(handle.id);
  const reqIdx = stored.findIndex(
    (e) => e.type === "permission.requested" && e.requestId === "abcde",
  );
  const resIdx = stored.findIndex(
    (e) => e.type === "permission.resolved" && e.requestId === "abcde" && e.outcome === "allow",
  );
  expect(reqIdx).toBeGreaterThanOrEqual(0);
  expect(resIdx).toBeGreaterThan(reqIdx);

  await bridge.close(handle.id);
});

test("respond(deny) records approver metadata", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "fghij");

  await bridge.respond(handle.id, "fghij", "deny", { approver: { userId: "u1" } });

  const stored = await bridge.readStoredEvents(handle.id);
  const resolved = stored.find((e) => e.type === "permission.resolved" && e.requestId === "fghij");
  expect(resolved).toEqual({
    type: "permission.resolved",
    sessionId: handle.id,
    requestId: "fghij",
    outcome: "deny",
    approver: { userId: "u1" },
  });

  await bridge.close(handle.id);
});

test("respond rejects an unknown requestId without touching the wire", async () => {
  const handle = await bridge.startSession({});

  await expect(bridge.respond(handle.id, "never-opened", "allow")).rejects.toThrow(
    /no open permission request/,
  );
  expect(supervisor.responded).toEqual([]);

  await bridge.close(handle.id);
});

test("respond is exactly-once under a concurrent double answer", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");

  const results = await Promise.allSettled([
    bridge.respond(handle.id, "abcde", "allow"),
    bridge.respond(handle.id, "abcde", "deny"),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(supervisor.responded).toHaveLength(1);

  await bridge.close(handle.id);
});

test("respond rejects when the supervisor has no respond method", async () => {
  class NoRespondSupervisor implements Supervisor {
    ctx: SupervisorContext | undefined;
    async start(ctx: SupervisorContext): Promise<void> {
      this.ctx = ctx;
    }
    async sendMessage(): Promise<void> {}
    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
    push(event: BridgeEvent): void {
      if (!this.ctx) throw new Error("supervisor not started");
      this.ctx.emit(event);
    }
  }

  const sup = new NoRespondSupervisor();
  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => sup,
  });
  const handle = await b.startSession({});
  sup.push({
    type: "permission.requested",
    sessionId: handle.id,
    requestId: "abcde",
    toolName: "Bash",
    description: "d",
    inputPreview: "{}",
  });

  await expect(b.respond(handle.id, "abcde", "allow")).rejects.toThrow(
    /supervisor does not support respond/,
  );

  await b.close(handle.id);
});

test("unanswered request ages out: resolved unanswered-remotely, no verdict sent", async () => {
  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
    permissionTimeoutMs: 50,
  });
  const handle = await b.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");

  await new Promise((r) => setTimeout(r, 120));

  expect(supervisor.responded).toEqual([]);
  const stored = await b.readStoredEvents(handle.id);
  const resolved = stored.find((e) => e.type === "permission.resolved" && e.requestId === "abcde");
  expect(resolved?.type === "permission.resolved" && resolved.outcome).toBe("unanswered-remotely");

  await expect(b.respond(handle.id, "abcde", "allow")).rejects.toThrow(
    /no open permission request/,
  );

  await b.close(handle.id);
});

test("open requests are flushed as aborted on close, timers cleared", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");
  pushPermissionRequest(supervisor, handle.id, "fghij");

  await bridge.close(handle.id);

  const stored = await bridge.readStoredEvents(handle.id);
  for (const id of ["abcde", "fghij"]) {
    const resolved = stored.find(
      (e) => e.type === "permission.resolved" && e.requestId === id && e.outcome === "aborted",
    );
    expect(resolved).toBeDefined();
  }

  // Every permission.requested has a matching resolved.
  const requested = stored.filter((e) => e.type === "permission.requested");
  for (const req of requested) {
    if (req.type !== "permission.requested") continue;
    const match = stored.find(
      (e) => e.type === "permission.resolved" && e.requestId === req.requestId,
    );
    expect(match).toBeDefined();
  }
});

test("close resolves every open request exactly once (no dangling requested)", async () => {
  // Invariant guard for the abort flush: after close, the number of terminating
  // permission.resolved events equals the number of permission.requested, and
  // each id resolves exactly once. The age-out-during-close fix (timer no-ops
  // while state !== "open") preserves this even if a pending timer fires during
  // teardown, since it leaves its entry for this flush instead of deleting it
  // and dropping the resolved via the closing-state early-return.
  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
    permissionTimeoutMs: 100,
  });
  const handle = await b.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");
  pushPermissionRequest(supervisor, handle.id, "fghij");

  await b.close(handle.id);
  // Give any (no-opped) age-out timer a chance to have fired after close.
  await new Promise((r) => setTimeout(r, 150));

  const stored = await b.readStoredEvents(handle.id);
  const requested = stored.filter((e) => e.type === "permission.requested");
  const resolved = stored.filter((e) => e.type === "permission.resolved");
  // Exactly one terminating resolved per requested; no dangling requests and no
  // spurious extra resolved from a leaked timer firing post-close.
  expect(resolved).toHaveLength(requested.length);
  for (const req of requested) {
    if (req.type !== "permission.requested") continue;
    const matches = stored.filter(
      (e) => e.type === "permission.resolved" && e.requestId === req.requestId,
    );
    expect(matches).toHaveLength(1);
  }
});

test("a duplicate requestId clears the stale timer so it cannot resolve a later request", async () => {
  const b = new Bridge({
    storeDir: dir,
    supervisorFactory: () => supervisor,
    permissionTimeoutMs: 40,
  });
  const handle = await b.startSession({});

  // First request opens timer1 (fires ~t=40). A duplicate with the SAME id
  // arrives before timer1 fires: without clearing it, timer1 is orphaned (the
  // map now points at timer2) and will still fire ~t=40.
  pushPermissionRequest(supervisor, handle.id, "abcde");
  pushPermissionRequest(supervisor, handle.id, "abcde");

  // Answer the current entry (clears timer2, deletes the entry).
  await b.respond(handle.id, "abcde", "allow");

  // Delay, then open a FRESH request reusing the same id (timer3, fires ~t=65).
  await new Promise((r) => setTimeout(r, 25));
  pushPermissionRequest(supervisor, handle.id, "abcde");

  // Wait until ~t=50: the orphaned timer1 has fired (t=40) but timer3 has not
  // legitimately aged out yet (t=65). Pre-fix, timer1 finds the live third
  // entry and wrongly resolves it as unanswered-remotely.
  await new Promise((r) => setTimeout(r, 25));

  const stored = await b.readStoredEvents(handle.id);
  // Pre-fix: orphaned timer1 fires, finds the live entry, and wrongly resolves
  // the still-open third request as unanswered-remotely. Post-fix: timer1 was
  // cleared at the duplicate, so the only resolved so far is the explicit allow.
  const resolved = stored.filter(
    (e) => e.type === "permission.resolved" && e.requestId === "abcde",
  );
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.type === "permission.resolved" && resolved[0].outcome).toBe("allow");
  expect(
    stored.some(
      (e) =>
        e.type === "permission.resolved" &&
        e.requestId === "abcde" &&
        e.outcome === "unanswered-remotely",
    ),
  ).toBe(false);

  await b.close(handle.id);
});

test("supervisor-initiated session end aborts open requests", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");

  supervisor.push({ type: "session.ended", sessionId: handle.id, reason: "crash" });

  await waitFor(async () => {
    const stored = await bridge.readStoredEvents(handle.id);
    return stored.some(
      (e) => e.type === "permission.resolved" && e.requestId === "abcde" && e.outcome === "aborted",
    );
  });
});

test("respond rejects after a store append failure and sends no verdict", async () => {
  // Store wrapper that delegates to a real JsonlEventStore but rejects the
  // append for permission.resolved events, mirroring the FailEndedStore seam.
  class FailResolvedStore implements BridgeEventStore {
    readonly #real: JsonlEventStore;
    constructor(path: string) {
      this.#real = new JsonlEventStore(path);
    }
    append(event: BridgeEvent): Promise<void> {
      if (event.type === "permission.resolved") {
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

  const originalError = console.error;
  console.error = () => {};
  try {
    const b = new Bridge({
      storeDir: dir,
      supervisorFactory: () => supervisor,
      storeFactory: (_id, path) => new FailResolvedStore(path),
    });
    const handle = await b.startSession({});
    pushPermissionRequest(supervisor, handle.id, "abcde");

    await expect(b.respond(handle.id, "abcde", "allow")).rejects.toThrow("store append boom");
    expect(supervisor.responded).toEqual([]);

    await b.close(handle.id).catch(() => undefined);
  } finally {
    console.error = originalError;
  }
});

test("permission.requested arriving during teardown does not open a timer", async () => {
  const handle = await bridge.startSession({});

  // Drive the session into closing/closed via a supervisor-initiated end.
  supervisor.push({ type: "session.ended", sessionId: handle.id, reason: "crash" });
  await waitFor(async () => {
    const stored = await bridge.readStoredEvents(handle.id);
    return stored.some((e) => e.type === "session.ended");
  });

  // A late permission request must be dropped by the closing/closed guard
  // before any timer/registry entry is opened.
  pushPermissionRequest(supervisor, handle.id, "late-id");

  await new Promise((r) => setTimeout(r, 30));

  const stored = await bridge.readStoredEvents(handle.id);
  expect(
    stored.find((e) => e.type === "permission.resolved" && e.requestId === "late-id"),
  ).toBeUndefined();
  expect(
    stored.find((e) => e.type === "permission.requested" && e.requestId === "late-id"),
  ).toBeUndefined();
});
