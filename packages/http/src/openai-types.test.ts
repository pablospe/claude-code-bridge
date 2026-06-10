// packages/http/src/openai-types.test.ts
import { describe, expect, test } from "bun:test";
import { validateChatRequest } from "./openai-types.ts";

describe("validateChatRequest", () => {
  test("accepts a minimal valid request", () => {
    const r = validateChatRequest({
      model: "ccb-claude",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages).toHaveLength(1);
      expect(r.value.stream).toBe(false);
    }
  });

  test("accepts tools, tool messages and stream flag", () => {
    const r = validateChatRequest({
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temp":18}' },
      ],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stream).toBe(true);
  });

  test("rejects missing messages", () => {
    const r = validateChatRequest({ model: "m" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("messages");
  });

  test("rejects message without role", () => {
    const r = validateChatRequest({ model: "m", messages: [{ content: "x" }] });
    expect(r.ok).toBe(false);
  });

  test("rejects empty messages array", () => {
    const r = validateChatRequest({ model: "m", messages: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("messages");
  });

  test("absent tool_choice defaults to auto", () => {
    const r = validateChatRequest({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tool_choice).toBe("auto");
  });

  test("accepts the string literal tool_choice values", () => {
    for (const tc of ["auto", "none", "required"] as const) {
      const r = validateChatRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tool_choice: tc,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.tool_choice).toBe(tc);
    }
  });

  test("accepts the forced-function object and preserves the name", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "function", function: { name: "extract" } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tool_choice).toEqual({ type: "function", function: { name: "extract" } });
    }
  });

  test("rejects a forced-function object without a name", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "function" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tool_choice");
  });

  test("rejects garbage tool_choice values", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "bogus",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tool_choice");
  });
});
