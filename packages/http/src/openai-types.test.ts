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
        { role: "tool", tool_call_id: "call_1", content: "{\"temp\":18}" },
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
});
