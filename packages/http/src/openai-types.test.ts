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
    // "required" needs a non-empty tools array to pass cross-field validation.
    for (const tc of ["auto", "none", "required"] as const) {
      const r = validateChatRequest({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "get_weather" } }],
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
      tools: [{ type: "function", function: { name: "extract" } }],
      tool_choice: { type: "function", function: { name: "extract" } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tool_choice).toEqual({ type: "function", function: { name: "extract" } });
    }
  });

  test("rejects tool_choice 'required' with an empty tools array", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: "required",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-empty tools array");
  });

  test("rejects a forced-function object with an empty tools array", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "function", function: { name: "extract" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-empty tools array");
  });

  test("rejects a forced name not present in tools", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather" } }],
      tool_choice: { type: "function", function: { name: "extract" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("'extract' is not present in tools");
  });

  test("rejects a forced name with invalid characters", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "bad name!" } }],
      tool_choice: { type: "function", function: { name: "bad name!" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tool_choice");
  });

  test("accepts a forced name present in tools", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "extract" } }],
      tool_choice: { type: "function", function: { name: "extract" } },
    });
    expect(r.ok).toBe(true);
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

  test("rejects a tools array with a null element (400, not a crash)", () => {
    const r = validateChatRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [null],
      tool_choice: { type: "function", function: { name: "extract" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("every tool must be an object");
  });
});
