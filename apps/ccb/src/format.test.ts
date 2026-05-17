import { expect, test } from "bun:test";
import type { BridgeEvent } from "@ccb/core";
import { formatJson, formatPretty } from "./format.ts";

const samples: ReadonlyArray<{ name: string; event: BridgeEvent }> = [
  { name: "session.started", event: { type: "session.started", sessionId: "s1" } },
  {
    name: "message.sent",
    event: { type: "message.sent", sessionId: "s1", messageId: "m1", content: "hello" },
  },
  {
    name: "agent.progress",
    event: { type: "agent.progress", sessionId: "s1", content: "thinking" },
  },
  {
    name: "agent.reply final=true",
    event: { type: "agent.reply", sessionId: "s1", content: "echo: hello", final: true },
  },
  {
    name: "agent.reply final=false",
    event: { type: "agent.reply", sessionId: "s1", content: "partial", final: false },
  },
  {
    name: "agent.done no fields",
    event: { type: "agent.done", sessionId: "s1" },
  },
  {
    name: "agent.done messageId only",
    event: { type: "agent.done", sessionId: "s1", messageId: "m1" },
  },
  {
    name: "agent.done reason only",
    event: { type: "agent.done", sessionId: "s1", reason: "complete" },
  },
  {
    name: "agent.done messageId and reason",
    event: { type: "agent.done", sessionId: "s1", messageId: "m1", reason: "complete" },
  },
  {
    name: "agent.input_requested",
    event: { type: "agent.input_requested", sessionId: "s1", requestId: "r1", prompt: "name?" },
  },
  {
    name: "tool.event",
    event: { type: "tool.event", sessionId: "s1", payload: { foo: 1 } },
  },
  {
    name: "session.ended no reason",
    event: { type: "session.ended", sessionId: "s1" },
  },
  {
    name: "session.ended with reason",
    event: { type: "session.ended", sessionId: "s1", reason: "closed" },
  },
];

test("formatJson roundtrips each BridgeEvent variant", () => {
  for (const { event } of samples) {
    const line = formatJson(event);
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(event);
  }
});

test("formatPretty produces the expected human-readable shapes", () => {
  expect(formatPretty({ type: "session.started", sessionId: "s1" })).toBe("[session.started] s1");
  expect(
    formatPretty({ type: "message.sent", sessionId: "s1", messageId: "m1", content: "hello" }),
  ).toBe('[message.sent] m1 "hello"');
  expect(formatPretty({ type: "agent.progress", sessionId: "s1", content: "thinking" })).toBe(
    '[agent.progress] "thinking"',
  );
  expect(
    formatPretty({
      type: "agent.progress",
      sessionId: "s1",
      messageId: "m1",
      content: "thinking",
    }),
  ).toBe('[agent.progress] m1 "thinking"');
  expect(
    formatPretty({ type: "agent.reply", sessionId: "s1", content: "echo: hello", final: true }),
  ).toBe('[agent.reply final=true] "echo: hello"');
  expect(
    formatPretty({
      type: "agent.reply",
      sessionId: "s1",
      messageId: "m1",
      content: "echo: hello",
      final: true,
    }),
  ).toBe('[agent.reply final=true] m1 "echo: hello"');
  expect(
    formatPretty({ type: "agent.reply", sessionId: "s1", content: "partial", final: false }),
  ).toBe('[agent.reply final=false] "partial"');
  expect(formatPretty({ type: "agent.done", sessionId: "s1" })).toBe("[agent.done]");
  expect(formatPretty({ type: "agent.done", sessionId: "s1", messageId: "m1" })).toBe(
    "[agent.done] m1",
  );
  expect(formatPretty({ type: "agent.done", sessionId: "s1", reason: "complete" })).toBe(
    "[agent.done] reason=complete",
  );
  expect(
    formatPretty({ type: "agent.done", sessionId: "s1", messageId: "m1", reason: "complete" }),
  ).toBe("[agent.done] m1 reason=complete");
  expect(
    formatPretty({
      type: "agent.input_requested",
      sessionId: "s1",
      requestId: "r1",
      prompt: "name?",
    }),
  ).toBe('[agent.input_requested] r1 "name?"');
  expect(formatPretty({ type: "tool.event", sessionId: "s1", payload: { foo: 1 } })).toBe(
    '[tool.event] {"foo":1}',
  );
  expect(formatPretty({ type: "session.ended", sessionId: "s1" })).toBe("[session.ended]");
  expect(formatPretty({ type: "session.ended", sessionId: "s1", reason: "closed" })).toBe(
    "[session.ended] reason=closed",
  );
});

test("formatters do not throw for any sample", () => {
  for (const { event } of samples) {
    expect(() => formatJson(event)).not.toThrow();
    expect(() => formatPretty(event)).not.toThrow();
  }
});
