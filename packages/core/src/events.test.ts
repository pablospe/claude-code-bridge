import { expect, test } from "bun:test";
import type { BridgeEvent } from "./events.ts";

function describeEvent(event: BridgeEvent): string {
  switch (event.type) {
    case "session.started":
      return `started:${event.sessionId}`;
    case "message.sent":
      return `sent:${event.sessionId}:${event.messageId}:${event.content}`;
    case "agent.progress":
      return `progress:${event.sessionId}:${event.content}`;
    case "agent.reply":
      return `reply:${event.sessionId}:${event.content}:${String(event.final)}`;
    case "agent.input_requested":
      return `input:${event.sessionId}:${event.requestId}:${event.prompt}`;
    case "tool.event":
      return `tool:${event.sessionId}`;
    case "session.ended":
      return `ended:${event.sessionId}:${event.reason ?? ""}`;
    default: {
      const exhaustive: never = event;
      throw new Error(`unhandled ${String(exhaustive)}`);
    }
  }
}

test("BridgeEvent discriminated union is exhaustive over type", () => {
  const events: BridgeEvent[] = [
    { type: "session.started", sessionId: "s1" },
    { type: "message.sent", sessionId: "s1", messageId: "m1", content: "hi" },
    { type: "agent.progress", sessionId: "s1", content: "thinking" },
    { type: "agent.reply", sessionId: "s1", content: "ok", final: true },
    { type: "agent.input_requested", sessionId: "s1", requestId: "r1", prompt: "name?" },
    { type: "tool.event", sessionId: "s1", payload: { name: "x" } },
    { type: "session.ended", sessionId: "s1", reason: "done" },
  ];

  const out = events.map(describeEvent);
  expect(out).toHaveLength(7);
  expect(out[0]).toBe("started:s1");
  expect(out[3]).toBe("reply:s1:ok:true");
});

test("agent.reply carries content and final flag", () => {
  const event: BridgeEvent = {
    type: "agent.reply",
    sessionId: "s1",
    messageId: "m1",
    content: "hello",
    final: false,
  };
  if (event.type !== "agent.reply") throw new Error("type narrowing failed");
  expect(event.final).toBe(false);
  expect(event.messageId).toBe("m1");
  expect(event.content).toBe("hello");
});

test("session.ended makes reason optional", () => {
  const event: BridgeEvent = { type: "session.started", sessionId: "s1" };
  if (event.type !== "session.started") throw new Error("type narrowing failed");
  expect(event.sessionId).toBe("s1");
});
