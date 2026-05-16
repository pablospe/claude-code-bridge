import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bridge, type BridgeEvent, type SupervisorContext } from "@ccb/core";
import { ControlServer } from "@ccb/mcp-channel";
import { MockSupervisor, mockSupervisorFactory } from "./index.ts";

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`collect: timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  const loop = (async () => {
    for await (const ev of iter) {
      events.push(ev);
      if (predicate(ev)) return events;
    }
    return events;
  })();
  try {
    return await Promise.race([loop, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

test("MockSupervisor throws on double start", async () => {
  const sup = new MockSupervisor();
  const ctx: SupervisorContext = {
    sessionId: "00000000-0000-0000-0000-00000000000a",
    emit: () => {},
  };
  await sup.start(ctx);
  await expect(sup.start(ctx)).rejects.toThrow("supervisor already started");
  await sup.close(ctx.sessionId);
  const probe = new ControlServer();
  const endpoint = await probe.listen({ host: "127.0.0.1", port: 0 });
  await probe.close();
  expect(endpoint.port).toBeGreaterThan(0);
});

test("MockSupervisor echoes back-to-back messages in submission order", async () => {
  const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
  const { id } = await bridge.startSession({});

  const replies: string[] = [];
  const iterator = bridge.events(id);

  const collector = (async () => {
    for await (const ev of iterator) {
      if (ev.type === "agent.reply") {
        replies.push(ev.content);
        if (replies.length === 3) return;
      }
    }
  })();

  // Submit three messages in the same tick to exercise echo ordering.
  await Promise.all([
    bridge.sendMessage(id, "a"),
    bridge.sendMessage(id, "b"),
    bridge.sendMessage(id, "c"),
  ]);
  await collector;

  expect(replies).toEqual(["echo: a", "echo: b", "echo: c"]);
  await bridge.close(id);
});

test("MockSupervisor.sendMessage rejects unknown session ids", async () => {
  const sup = new MockSupervisor();
  const ctx: SupervisorContext = {
    sessionId: "00000000-0000-0000-0000-00000000000b",
    emit: () => {},
  };
  await sup.start(ctx);
  await expect(sup.sendMessage("not-the-session", "m1", "hi")).rejects.toThrow(/unknown session/);
  await sup.close(ctx.sessionId);
});

test("collect helper rejects when stream stays silent", async () => {
  const iter: AsyncIterable<BridgeEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<BridgeEvent>> {
          return new Promise(() => {});
        },
      };
    },
  };
  const start = Date.now();
  await expect(collect(iter, () => true, { timeoutMs: 50 })).rejects.toThrow(
    /collect: timeout after 50ms/,
  );
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(500);
});
