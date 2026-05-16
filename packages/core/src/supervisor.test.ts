import { expect, test } from "bun:test";
import type { BridgeEvent } from "./events.ts";
import type { Supervisor, SupervisorContext } from "./supervisor.ts";
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
