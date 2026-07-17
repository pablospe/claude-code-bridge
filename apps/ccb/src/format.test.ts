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
    event: {
      type: "tool.event",
      sessionId: "s1",
      payload: {
        event: "PreToolUse",
        data: { tool_name: "Bash", tool_input: { command: "git status" } },
      },
    },
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
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: {
        event: "PreToolUse",
        data: { tool_name: "Bash", tool_input: { command: "git status" } },
      },
    }),
  ).toBe('[tool.event] PreToolUse Bash "git status"');
  expect(formatPretty({ type: "session.ended", sessionId: "s1" })).toBe("[session.ended]");
  expect(formatPretty({ type: "session.ended", sessionId: "s1", reason: "closed" })).toBe(
    "[session.ended] reason=closed",
  );
});

test("formatPretty renders tool.event PreToolUse with tool input summary", () => {
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: {
        event: "PreToolUse",
        data: { tool_name: "Read", tool_input: { file_path: "/tmp/foo.ts" } },
      },
    }),
  ).toBe('[tool.event] PreToolUse Read "/tmp/foo.ts"');
});

test("formatPretty truncates long PreToolUse inputs to 60 chars with ellipsis", () => {
  const longCommand = "a".repeat(120);
  const line = formatPretty({
    type: "tool.event",
    sessionId: "s1",
    payload: {
      event: "PreToolUse",
      data: { tool_name: "Bash", tool_input: { command: longCommand } },
    },
  });
  // 60-char short-input: 59 chars of payload + "…"
  const expectedShort = `"${"a".repeat(58)}…`;
  expect(line).toBe(`[tool.event] PreToolUse Bash ${expectedShort}`);
  expect(line.length).toBeLessThan(120);
});

test("formatPretty appends (truncated) to PreToolUse when tool_input is truncated", () => {
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: {
        event: "PreToolUse",
        data: {
          tool_name: "Bash",
          tool_input: { command: "ls -la" },
          truncated_fields: ["tool_input"],
        },
      },
    }),
  ).toBe('[tool.event] PreToolUse Bash "ls -la" (truncated)');
});

test("formatPretty renders PostToolUse size in KB for results >=1024 bytes", () => {
  // 1232-char ASCII string -> JSON.stringify wraps in quotes -> 1234 bytes -> 1.2KB
  const body = "x".repeat(1232);
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: {
        event: "PostToolUse",
        data: { tool_name: "Read", tool_result: body },
      },
    }),
  ).toBe("[tool.event] PostToolUse Read (1.2KB)");
});

test("formatPretty renders PostToolUse size in bytes for results <1024 bytes", () => {
  // 798-char ASCII string -> JSON.stringify wraps in quotes -> 800 bytes
  const body = "y".repeat(798);
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: {
        event: "PostToolUse",
        data: { tool_name: "Read", tool_result: body },
      },
    }),
  ).toBe("[tool.event] PostToolUse Read (800 B)");
});

test("formatPretty appends (truncated) to PostToolUse when tool_result is truncated", () => {
  const body = "z".repeat(1232);
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: {
        event: "PostToolUse",
        data: {
          tool_name: "Read",
          tool_result: body,
          truncated_fields: ["tool_result"],
        },
      },
    }),
  ).toBe("[tool.event] PostToolUse Read (1.2KB) (truncated)");
});

test("formatPretty renders PostToolUse with missing tool_result as ok", () => {
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: {
        event: "PostToolUse",
        data: { tool_name: "Bash" },
      },
    }),
  ).toBe("[tool.event] PostToolUse Bash ok");
});

test("formatPretty renders Stop as the per-message literal", () => {
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: { event: "Stop", data: { hook_event_name: "Stop" } },
    }),
  ).toBe("[tool.event] Stop (per-message)");
});

test("formatPretty falls back to JSON for unknown tool.event names", () => {
  expect(
    formatPretty({
      type: "tool.event",
      sessionId: "s1",
      payload: { event: "Notification", data: { message: "hi" } },
    }),
  ).toBe('[tool.event] Notification {"message":"hi"}');
});

test("formatters do not throw for any sample", () => {
  for (const { event } of samples) {
    expect(() => formatJson(event)).not.toThrow();
    expect(() => formatPretty(event)).not.toThrow();
  }
});

test("formatPretty renders permission.requested", () => {
  expect(
    formatPretty({
      type: "permission.requested",
      sessionId: "s",
      requestId: "abcde",
      toolName: "Bash",
      description: "run ls",
      inputPreview: '{"command":"ls"}',
    }),
  ).toBe('[permission.requested] abcde Bash "run ls"');
});

test("formatPretty renders permission.resolved", () => {
  expect(
    formatPretty({
      type: "permission.resolved",
      sessionId: "s",
      requestId: "abcde",
      outcome: "allow",
    }),
  ).toBe("[permission.resolved] abcde allow");
});
