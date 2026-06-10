import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge, type Supervisor, type SupervisorContext } from "@ccb/core";
import { runTurn } from "./turn.ts";

// A supervisor that never emits a terminal event, so the turn timeout always
// wins. This makes the timeout assertion deterministic.
class SilentSupervisor implements Supervisor {
  async start(): Promise<void> {}
  async sendMessage(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

// A supervisor that stores the SupervisorContext from start() and replays a
// scripted sequence of events on sendMessage, so a test can pin exact turn
// semantics without a real channel.
class ScriptedSupervisor implements Supervisor {
  #ctx: SupervisorContext | undefined;
  constructor(private readonly script: (ctx: SupervisorContext) => void) {}
  async start(ctx: SupervisorContext): Promise<void> {
    this.#ctx = ctx;
  }
  async sendMessage(): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) throw new Error("supervisor not started");
    this.script(ctx);
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

const storeDir = `/tmp/ccb-turn-test-${crypto.randomUUID()}`;
afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("runTurn", () => {
  test("collects deltas and the final content", async () => {
    const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
    const { id } = await bridge.startSession({});
    const deltas: string[] = [];
    const result = await runTurn({
      bridge,
      sessionId: id,
      prompt: "ping",
      timeoutMs: 10_000,
      onDelta: (d) => deltas.push(d),
    });
    // MockSupervisor emits progress "thinking" then reply "echo: <content>".
    expect(result.content).toBe("echo: ping");
    expect(deltas).toEqual(["thinking", "echo: ping"]);
    await bridge.close(id);
  });

  test("times out when no terminal event arrives", async () => {
    const bridge = new Bridge({ storeDir, supervisorFactory: () => new SilentSupervisor() });
    const { id } = await bridge.startSession({});
    await expect(runTurn({ bridge, sessionId: id, prompt: "ping", timeoutMs: 50 })).rejects.toThrow(
      /turn timed out after 50ms/,
    );
    await bridge.close(id);
  });

  test("concatenates non-final and final reply chunks", async () => {
    const bridge = new Bridge({
      storeDir,
      supervisorFactory: () =>
        new ScriptedSupervisor((ctx) => {
          const sessionId = ctx.sessionId;
          ctx.emit({ type: "agent.reply", sessionId, content: "Hello, ", final: false });
          ctx.emit({ type: "agent.reply", sessionId, content: "world", final: true });
        }),
    });
    const { id } = await bridge.startSession({});
    const deltas: string[] = [];
    const result = await runTurn({
      bridge,
      sessionId: id,
      prompt: "ping",
      timeoutMs: 10_000,
      onDelta: (d) => deltas.push(d),
    });
    expect(result.content).toBe("Hello, world");
    expect(deltas).toEqual(["Hello, ", "world"]);
    await bridge.close(id);
  });

  test("returns empty content for a done-only turn", async () => {
    const bridge = new Bridge({
      storeDir,
      supervisorFactory: () =>
        new ScriptedSupervisor((ctx) => {
          ctx.emit({ type: "agent.done", sessionId: ctx.sessionId });
        }),
    });
    const { id } = await bridge.startSession({});
    const result = await runTurn({ bridge, sessionId: id, prompt: "ping", timeoutMs: 10_000 });
    expect(result.content).toBe("");
    await bridge.close(id);
  });

  test("rejects when the session ends mid-turn", async () => {
    const bridge = new Bridge({
      storeDir,
      supervisorFactory: () =>
        new ScriptedSupervisor((ctx) => {
          ctx.emit({ type: "session.ended", sessionId: ctx.sessionId, reason: "crash" });
        }),
    });
    const { id } = await bridge.startSession({});
    await expect(
      runTurn({ bridge, sessionId: id, prompt: "ping", timeoutMs: 10_000 }),
    ).rejects.toThrow(/session ended mid-turn: crash/);
    await bridge.close(id);
  });

  test("isolates sequential turns on a single session", async () => {
    // A stale trailing agent.done from turn 1 must not terminate turn 2: each
    // runTurn subscribes its own iterator and disposes it on completion.
    const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
    const { id } = await bridge.startSession({});
    const first = await runTurn({ bridge, sessionId: id, prompt: "one", timeoutMs: 10_000 });
    expect(first.content).toBe("echo: one");
    const second = await runTurn({ bridge, sessionId: id, prompt: "two", timeoutMs: 10_000 });
    expect(second.content).toBe("echo: two");
    await bridge.close(id);
  });
});
