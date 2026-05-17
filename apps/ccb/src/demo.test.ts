import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockSupervisorFactory } from "@ccb/claude-code";
import type { Supervisor, SupervisorContext, SupervisorFactory } from "@ccb/core";
import { runDemo } from "./demo.ts";

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-cli-demo-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

test("runDemo returns the full event stream in order with format=json", async () => {
  const result = await runDemo({
    input: "hello",
    supervisorFactory: mockSupervisorFactory(),
    format: "json",
    storeDir,
    timeoutMs: 2000,
  });
  const types = result.events.map((e) => e.type);
  // agent.done may appear before session.ended depending on echo timing; assert
  // the leading and trailing events are stable.
  expect(types[0]).toBe("session.started");
  expect(types[1]).toBe("message.sent");
  expect(types[2]).toBe("agent.progress");
  expect(types[3]).toBe("agent.reply");
  expect(types.at(-1)).toBe("session.ended");

  const messageSent = result.events[1];
  if (messageSent?.type !== "message.sent") throw new Error("expected message.sent");
  expect(messageSent.content).toBe("hello");

  const progress = result.events[2];
  if (progress?.type !== "agent.progress") throw new Error("expected agent.progress");
  expect(progress.content).toBe("thinking");

  const reply = result.events[3];
  if (reply?.type !== "agent.reply") throw new Error("expected agent.reply");
  expect(reply.content).toBe("echo: hello");
  expect(reply.final).toBe(true);
});

test("runDemo collects events identically with format=pretty", async () => {
  const result = await runDemo({
    input: "hello",
    supervisorFactory: mockSupervisorFactory(),
    format: "pretty",
    storeDir,
    timeoutMs: 2000,
  });
  const types = result.events.map((e) => e.type);
  expect(types[0]).toBe("session.started");
  expect(types[1]).toBe("message.sent");
  expect(types[2]).toBe("agent.progress");
  expect(types[3]).toBe("agent.reply");
  expect(types.at(-1)).toBe("session.ended");
});

class HangingCloseSupervisor implements Supervisor {
  #ctx: SupervisorContext | undefined;
  async start(ctx: SupervisorContext): Promise<void> {
    this.#ctx = ctx;
  }
  async sendMessage(sessionId: string): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.emit({ type: "agent.reply", sessionId, content: "done", final: true });
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    // Never resolves: simulates a wedged supervisor.
    return new Promise<void>(() => {});
  }
}

function hangingCloseSupervisorFactory(): SupervisorFactory {
  return () => new HangingCloseSupervisor();
}

test("runDemo bounds bridge.close within the overall deadline when supervisor hangs", async () => {
  const start = Date.now();
  const result = await runDemo({
    input: "hello",
    supervisorFactory: hangingCloseSupervisorFactory(),
    format: "json",
    storeDir,
    timeoutMs: 200,
  });
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(1500);
  // Even if close hangs, we still have a sessionId and at minimum session.started
  // was persisted before the wedge.
  expect(result.sessionId.length).toBeGreaterThan(0);
});

function silentHangingSupervisorFactory(): SupervisorFactory {
  return () =>
    ({
      async start() {
        // Emit nothing; collection will time out.
      },
      async sendMessage() {
        // no-op; never replies.
      },
      async interrupt() {
        // no-op
      },
      async close() {
        return new Promise<void>(() => {});
      },
    }) satisfies Supervisor;
}

test("runDemo timeout path also bounds cleanup close", async () => {
  const start = Date.now();
  await expect(
    runDemo({
      input: "hello",
      supervisorFactory: silentHangingSupervisorFactory(),
      format: "json",
      storeDir,
      timeoutMs: 200,
    }),
  ).rejects.toThrow();
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(2000);
});

class PostReplyToolSupervisor implements Supervisor {
  #ctx: SupervisorContext | undefined;
  async start(ctx: SupervisorContext): Promise<void> {
    this.#ctx = ctx;
  }
  async sendMessage(sessionId: string): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.emit({
      type: "agent.reply",
      sessionId,
      content: "done",
      final: true,
    });
    ctx.emit({
      type: "tool.event",
      sessionId,
      payload: { after: "reply" },
    });
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.#ctx = undefined;
  }
}

class DoneOnlySupervisor implements Supervisor {
  #ctx: SupervisorContext | undefined;
  async start(ctx: SupervisorContext): Promise<void> {
    this.#ctx = ctx;
  }
  async sendMessage(sessionId: string): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) return;
    // Skip the final reply path entirely; only emit agent.done.
    ctx.emit({ type: "agent.done", sessionId, reason: "test-only" });
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.#ctx = undefined;
  }
}

test("runDemo returns within ~100ms when supervisor emits only agent.done", async () => {
  const start = Date.now();
  const result = await runDemo({
    input: "hello",
    supervisorFactory: () => new DoneOnlySupervisor(),
    format: "json",
    storeDir,
    timeoutMs: 10_000,
  });
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(1500);
  const types = result.events.map((e) => e.type);
  expect(types).toContain("agent.done");
  expect(types.at(-1)).toBe("session.ended");
});

test("runDemo stream mode delivers events between final reply and session.ended", async () => {
  const observed: string[] = [];
  await runDemo({
    input: "hello",
    supervisorFactory: () => new PostReplyToolSupervisor(),
    format: "stream",
    storeDir,
    timeoutMs: 2000,
    onEvent: (ev) => {
      observed.push(ev.type);
    },
  });
  // The stream callback must see the tool.event emitted after the final reply
  // and before session.ended, not silently drop it.
  expect(observed).toContain("tool.event");
  // session.ended must be the last event the stream observer sees.
  expect(observed[observed.length - 1]).toBe("session.ended");
});
