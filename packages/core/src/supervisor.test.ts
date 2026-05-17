import { expect, test } from "bun:test";
import type { BridgeEvent } from "./events.ts";
import { dispatchBridgeTool, type Supervisor, type SupervisorContext } from "./supervisor.ts";
import type { ClaudeCodeBridge, SendOptions, StartSessionOptions } from "./types.ts";

test("Supervisor can be implemented with the documented surface", async () => {
  const seen: BridgeEvent[] = [];

  class StubSupervisor implements Supervisor {
    async start(ctx: SupervisorContext): Promise<void> {
      ctx.emit({ type: "agent.progress", sessionId: "s1", content: "ready" });
    }
    async sendMessage(_sessionId: string, _messageId: string, _content: string): Promise<void> {}
    async interrupt(_sessionId: string): Promise<void> {}
    async close(_sessionId: string): Promise<void> {}
  }

  const supervisor: Supervisor = new StubSupervisor();
  await supervisor.start({
    sessionId: "s1",
    emit: (event) => {
      seen.push(event);
    },
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.type).toBe("agent.progress");
});

test("StartSessionOptions and SendOptions are usable shapes", () => {
  const start: StartSessionOptions = {};
  const send: SendOptions = {};
  expect(start).toEqual({});
  expect(send).toEqual({});
});

test("ClaudeCodeBridge interface has the documented method shape", () => {
  type Method = keyof ClaudeCodeBridge;
  const required: Method[] = ["startSession", "sendMessage", "events", "interrupt", "close"];
  expect(required).toHaveLength(5);
});

test("dispatchBridgeTool emits agent.reply for bridge_reply", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s1", emit: (e) => events.push(e) };
  dispatchBridgeTool(ctx, "bridge_reply", { content: "hi", final: true, messageId: "m1" });
  expect(events).toEqual([
    { type: "agent.reply", sessionId: "s1", content: "hi", final: true, messageId: "m1" },
  ]);
});

test("dispatchBridgeTool emits agent.progress for bridge_progress", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s1", emit: (e) => events.push(e) };
  dispatchBridgeTool(ctx, "bridge_progress", { content: "working" });
  expect(events).toEqual([{ type: "agent.progress", sessionId: "s1", content: "working" }]);
});

test("dispatchBridgeTool emits agent.done for bridge_done with optional reason", () => {
  const a: BridgeEvent[] = [];
  dispatchBridgeTool({ sessionId: "s1", emit: (e) => a.push(e) }, "bridge_done", {
    reason: "finished",
  });
  expect(a).toEqual([{ type: "agent.done", sessionId: "s1", reason: "finished" }]);

  const b: BridgeEvent[] = [];
  dispatchBridgeTool({ sessionId: "s2", emit: (e) => b.push(e) }, "bridge_done", {});
  expect(b).toEqual([{ type: "agent.done", sessionId: "s2" }]);
});

test("dispatchBridgeTool drops malformed payloads silently", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s1", emit: (e) => events.push(e) };
  dispatchBridgeTool(ctx, "bridge_reply", { content: "x" });
  dispatchBridgeTool(ctx, "bridge_progress", {});
  dispatchBridgeTool(ctx, "unknown_tool", {});
  expect(events).toEqual([]);
});
