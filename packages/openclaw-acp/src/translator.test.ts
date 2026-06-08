import { expect, test } from "bun:test";
import type { BridgeEvent } from "@ccb/core";
import { translateBridgeEvent } from "./translator.ts";

const SID = "11111111-1111-1111-1111-111111111111";

test("session.started and message.sent produce nothing", () => {
  expect(translateBridgeEvent({ type: "session.started", sessionId: SID })).toEqual({
    events: [],
    terminal: null,
  });
  expect(
    translateBridgeEvent({
      type: "message.sent",
      sessionId: SID,
      messageId: "m1",
      content: "hi",
    }),
  ).toEqual({ events: [], terminal: null });
});

test("agent.progress maps to a non-terminal output text_delta", () => {
  const r = translateBridgeEvent({
    type: "agent.progress",
    sessionId: SID,
    content: "thinking...",
  });
  expect(r.terminal).toBeNull();
  expect(r.events).toEqual([
    { type: "text_delta", text: "thinking...", stream: "output", tag: "agent_message_chunk" },
  ]);
});

test("non-final agent.reply is a text_delta with no terminal", () => {
  const r = translateBridgeEvent({
    type: "agent.reply",
    sessionId: SID,
    content: "partial",
    final: false,
  });
  expect(r.terminal).toBeNull();
  expect(r.events).toEqual([
    { type: "text_delta", text: "partial", stream: "output", tag: "agent_message_chunk" },
  ]);
});

test("final agent.reply emits text_delta + done and a completed terminal", () => {
  const r = translateBridgeEvent({
    type: "agent.reply",
    sessionId: SID,
    content: "121",
    final: true,
  });
  expect(r.events).toEqual([
    { type: "text_delta", text: "121", stream: "output", tag: "agent_message_chunk" },
    { type: "done" },
  ]);
  expect(r.terminal).toEqual({ status: "completed" });
});

test("clean agent.done is a done event + completed terminal", () => {
  const r = translateBridgeEvent({ type: "agent.done", sessionId: SID });
  expect(r.events).toEqual([{ type: "done", stopReason: undefined }]);
  expect(r.terminal).toEqual({ status: "completed", stopReason: undefined });
});

test("crash agent.done (channel-disconnected) is an error + failed terminal", () => {
  const r = translateBridgeEvent({
    type: "agent.done",
    sessionId: SID,
    reason: "channel-disconnected",
  });
  expect(r.events).toEqual([
    { type: "error", message: "channel-disconnected", retryable: true },
  ]);
  expect(r.terminal).toEqual({
    status: "failed",
    error: { message: "channel-disconnected", retryable: true },
  });
});

test("PreToolUse tool.event maps to in_progress tool_call with the tool name", () => {
  const r = translateBridgeEvent({
    type: "tool.event",
    sessionId: SID,
    payload: { event: "PreToolUse", data: { tool_name: "Bash" } },
  });
  expect(r.terminal).toBeNull();
  expect(r.events).toEqual([
    { type: "tool_call", text: "Bash", status: "in_progress", title: "Bash", tag: "tool_call" },
  ]);
});

test("PostToolUse tool.event maps to completed tool_call", () => {
  const r = translateBridgeEvent({
    type: "tool.event",
    sessionId: SID,
    payload: { event: "PostToolUse", data: { tool_name: "Edit" } },
  });
  expect(r.events).toEqual([
    { type: "tool_call", text: "Edit", status: "completed", title: "Edit", tag: "tool_call_update" },
  ]);
});

test("tool.event with missing tool_name falls back to 'tool'", () => {
  const r = translateBridgeEvent({
    type: "tool.event",
    sessionId: SID,
    payload: { event: "PreToolUse", data: {} },
  });
  expect((r.events[0] as { title: string }).title).toBe("tool");
});

test("Stop hook event produces nothing", () => {
  const r = translateBridgeEvent({
    type: "tool.event",
    sessionId: SID,
    payload: { event: "Stop", data: {} },
  });
  expect(r).toEqual({ events: [], terminal: null });
});

test("agent.input_requested is ignored in phase 1", () => {
  const r = translateBridgeEvent({
    type: "agent.input_requested",
    sessionId: SID,
    requestId: "r1",
    prompt: "pick one",
  });
  expect(r).toEqual({ events: [], terminal: null });
});

test("clean session.ended is a done + completed terminal", () => {
  const r = translateBridgeEvent({ type: "session.ended", sessionId: SID, reason: "closed" });
  expect(r.events).toEqual([{ type: "done", stopReason: "closed" }]);
  expect(r.terminal).toEqual({ status: "completed", stopReason: "closed" });
});

test("crash session.ended (supervisor crashed) is an error + failed terminal", () => {
  const r = translateBridgeEvent({
    type: "session.ended",
    sessionId: SID,
    reason: "supervisor crashed",
  });
  expect(r.events).toEqual([
    { type: "error", message: "supervisor crashed", retryable: true },
  ]);
  expect(r.terminal).toEqual({
    status: "failed",
    error: { message: "supervisor crashed", retryable: true },
  });
});

// Type-completeness guard: every BridgeEvent variant must be handled without
// throwing. If ccb adds a variant, this fails loudly via the union below.
test("handles every BridgeEvent variant without throwing", () => {
  const samples: BridgeEvent[] = [
    { type: "session.started", sessionId: SID },
    { type: "message.sent", sessionId: SID, messageId: "m", content: "c" },
    { type: "agent.progress", sessionId: SID, content: "c" },
    { type: "agent.reply", sessionId: SID, content: "c", final: true },
    { type: "agent.done", sessionId: SID },
    { type: "agent.input_requested", sessionId: SID, requestId: "r", prompt: "p" },
    { type: "tool.event", sessionId: SID, payload: { event: "PreToolUse", data: {} } },
    { type: "session.ended", sessionId: SID },
  ];
  for (const ev of samples) {
    expect(() => translateBridgeEvent(ev)).not.toThrow();
  }
});
