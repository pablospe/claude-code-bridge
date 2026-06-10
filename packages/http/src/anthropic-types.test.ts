// packages/http/src/anthropic-types.test.ts
import { describe, expect, test } from "bun:test";
import { validateAnthropicRequest } from "./anthropic-types.ts";

describe("validateAnthropicRequest — translation", () => {
  test("minimal request: user string → ChatMessage", () => {
    const r = validateAnthropicRequest({
      model: "claude-3",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.model).toBe("claude-3");
      expect(r.value.stream).toBe(false);
      expect(r.value.tool_choice).toBe("auto");
      expect(r.value.tools).toEqual([]);
      expect(r.value.messages).toEqual([{ role: "user", content: "hi" }]);
    }
  });

  test("stream flag is preserved", () => {
    const r = validateAnthropicRequest({
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stream).toBe(true);
  });

  test("system string prepends a system message", () => {
    const r = validateAnthropicRequest({
      model: "m",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages[0]).toEqual({ role: "system", content: "be terse" });
      expect(r.value.messages[1]).toEqual({ role: "user", content: "hi" });
    }
  });

  test("system blocks join with \\n\\n and prepend", () => {
    const r = validateAnthropicRequest({
      model: "m",
      system: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages[0]).toEqual({ role: "system", content: "one\n\ntwo" });
    }
  });

  test("user text blocks join into a content string", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.messages[0]).toEqual({ role: "user", content: "ab" });
  });

  test("non-text user blocks (image) are dropped silently", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { data: "xxx" } },
            { type: "text", text: "describe" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.messages[0]).toEqual({ role: "user", content: "describe" });
  });

  test("assistant tool_use → tool_calls with stringified arguments", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "SF" } },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const asst = r.value.messages[1];
      expect(asst?.role).toBe("assistant");
      expect(asst?.content).toBe("let me check");
      expect(asst?.tool_calls).toEqual([
        {
          id: "tu_1",
          type: "function",
          function: { name: "get_weather", arguments: JSON.stringify({ city: "SF" }) },
        },
      ]);
    }
  });

  test("assistant tool_use with no text → content null", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "f", input: {} }],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const asst = r.value.messages[1];
      expect(asst?.content).toBeNull();
      expect(asst?.tool_calls).toHaveLength(1);
    }
  });

  test("tool_result (string) → role:tool with tool_call_id", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: '{"temp":18}' }],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages[0]).toEqual({
        role: "tool",
        tool_call_id: "tu_1",
        content: '{"temp":18}',
      });
    }
  });

  test("tool_result array content joins text blocks", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: [
                { type: "text", text: "x" },
                { type: "text", text: "y" },
              ],
            },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages[0]).toEqual({
        role: "tool",
        tool_call_id: "tu_1",
        content: "xy",
      });
    }
  });

  test("user message mixing tool_result and text: tool first, then user text after", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "done" },
            { type: "text", text: "thanks" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages[0]).toEqual({
        role: "tool",
        tool_call_id: "tu_1",
        content: "done",
      });
      expect(r.value.messages[1]).toEqual({ role: "user", content: "thanks" });
    }
  });

  test("mid-conversation role:system message → system ChatMessage at its position", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "Terse mode." },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages[0]).toEqual({ role: "user", content: "hi" });
      expect(r.value.messages[1]).toEqual({ role: "system", content: "Terse mode." });
    }
  });

  test("mid-conversation system with text blocks joins into content", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "system",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages[1]).toEqual({ role: "system", content: "ab" });
    }
  });

  test("tool without input_schema yields function def with no parameters key", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "no_schema", description: "d" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const def = r.value.tools[0];
      expect(def).toBeDefined();
      if (def) {
        expect("parameters" in def.function).toBe(false);
        expect(def.function.name).toBe("no_schema");
      }
    }
  });

  test("interleaved text-before-tool_result: tool message first, text user message after", () => {
    // Documents the chosen reordering: even when text appears BEFORE the
    // tool_result in the content array, the tool message is emitted first and
    // the text becomes a separate user message after it.
    const r = validateAnthropicRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "here:" },
            { type: "tool_result", tool_use_id: "t1", content: "42" },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages[0]).toEqual({
        role: "tool",
        tool_call_id: "t1",
        content: "42",
      });
      expect(r.value.messages[1]).toEqual({ role: "user", content: "here:" });
    }
  });

  test("tools map to internal function defs", () => {
    const r = validateAnthropicRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "get_weather",
          description: "weather",
          input_schema: { type: "object", properties: {} },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tools).toEqual([
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "weather",
            parameters: { type: "object", properties: {} },
          },
        },
      ]);
    }
  });

  describe("tool_choice mapping", () => {
    const tools = [{ name: "f", input_schema: {} }];
    test("absent → auto", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
      });
      expect(r.ok && r.value.tool_choice).toBe("auto");
    });
    test("auto → auto", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tool_choice: { type: "auto" },
      });
      expect(r.ok && r.value.tool_choice).toBe("auto");
    });
    test("any → required", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tools,
        tool_choice: { type: "any" },
      });
      expect(r.ok && r.value.tool_choice).toBe("required");
    });
    test("none → none", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tool_choice: { type: "none" },
      });
      expect(r.ok && r.value.tool_choice).toBe("none");
    });
    test("tool → forced function", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tools,
        tool_choice: { type: "tool", name: "f" },
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.tool_choice).toEqual({ type: "function", function: { name: "f" } });
    });
  });

  describe("validation rejections", () => {
    test("not an object", () => {
      expect(validateAnthropicRequest(null).ok).toBe(false);
    });
    test("empty messages", () => {
      expect(validateAnthropicRequest({ model: "m", messages: [] }).ok).toBe(false);
    });
    test("missing messages", () => {
      expect(validateAnthropicRequest({ model: "m" }).ok).toBe(false);
    });
    test("bad role", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "tool", content: "x" }],
      });
      expect(r.ok).toBe(false);
    });
    test("'any' with empty tools rejected", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tool_choice: { type: "any" },
      });
      expect(r.ok).toBe(false);
    });
    test("'tool' without name rejected", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tools: [{ name: "f", input_schema: {} }],
        tool_choice: { type: "tool" },
      });
      expect(r.ok).toBe(false);
    });
    test("forced tool name not present in tools rejected", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tools: [{ name: "f", input_schema: {} }],
        tool_choice: { type: "tool", name: "g" },
      });
      expect(r.ok).toBe(false);
    });
    test("forced tool name with bad chars rejected", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tools: [{ name: "bad name!", input_schema: {} }],
        tool_choice: { type: "tool", name: "bad name!" },
      });
      expect(r.ok).toBe(false);
    });
    test("unknown tool_choice shape rejected", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tool_choice: { type: "bogus" },
      });
      expect(r.ok).toBe(false);
    });
    test("tool with empty/missing name rejected, error mentions name", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tools: [{}],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("name");
    });
    test("null tool element rejected", () => {
      const r = validateAnthropicRequest({
        model: "m",
        messages: [{ role: "user", content: "h" }],
        tools: [null],
      });
      expect(r.ok).toBe(false);
    });
  });
});
