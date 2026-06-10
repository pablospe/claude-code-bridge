// packages/http/src/response.test.ts
import { describe, expect, test } from "bun:test";
import { buildChunk, buildCompletion, estimateTokens } from "./response.ts";

describe("estimateTokens", () => {
  test("~chars/4, minimum 1 for non-empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(10))).toBe(3);
  });
});

describe("buildCompletion", () => {
  test("text result shape", () => {
    const r = buildCompletion({
      model: "ccb-claude",
      prompt: "p".repeat(40),
      parsed: { kind: "text", content: "hello" },
    });
    expect(r.object).toBe("chat.completion");
    expect(r.id).toMatch(/^chatcmpl-/);
    expect(r.choices[0]?.message).toEqual({ role: "assistant", content: "hello" });
    expect(r.choices[0]?.finish_reason).toBe("stop");
    expect(r.usage.prompt_tokens).toBe(10);
    expect(r.usage.completion_tokens).toBe(2);
    expect(r.usage.total_tokens).toBe(12);
  });

  test("tool_calls result shape", () => {
    const r = buildCompletion({
      model: "m",
      prompt: "p",
      parsed: {
        kind: "tool_calls",
        calls: [{ id: "call_x", type: "function", function: { name: "f", arguments: "{}" } }],
      },
    });
    expect(r.choices[0]?.finish_reason).toBe("tool_calls");
    expect(r.choices[0]?.message.content).toBeNull();
    expect(r.choices[0]?.message.tool_calls?.[0]?.id).toBe("call_x");
  });
});

describe("buildChunk", () => {
  test("delta chunk and final chunk", () => {
    const delta = buildChunk({ id: "chatcmpl-1", model: "m", delta: { content: "hi" } });
    expect(delta.object).toBe("chat.completion.chunk");
    expect(delta.choices[0]?.delta).toEqual({ content: "hi" });
    expect(delta.choices[0]?.finish_reason).toBeNull();
    const final = buildChunk({ id: "chatcmpl-1", model: "m", delta: {}, finishReason: "stop" });
    expect(final.choices[0]?.finish_reason).toBe("stop");
  });
});
