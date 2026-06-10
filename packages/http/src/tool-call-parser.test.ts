// packages/http/src/tool-call-parser.test.ts
import { describe, expect, test } from "bun:test";
import { parseReply } from "./tool-call-parser.ts";

describe("parseReply", () => {
  test("plain prose is text", () => {
    const r = parseReply("It is sunny in Paris.");
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.content).toBe("It is sunny in Paris.");
  });

  test("fenced single tool_call parses", () => {
    const r = parseReply(
      '```json\n{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}\n```',
    );
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.function.name).toBe("get_weather");
      expect(JSON.parse(r.calls[0]?.function.arguments ?? "")).toEqual({ city: "Paris" });
      expect(r.calls[0]?.id).toMatch(/^call_/);
    }
  });

  test("bare (unfenced) tool_call object parses", () => {
    const r = parseReply('{"tool_call": {"name": "f", "arguments": {}}}');
    expect(r.kind).toBe("tool_calls");
  });

  test("tool_calls array parses to multiple calls", () => {
    const r = parseReply(
      '```json\n{"tool_calls": [{"name": "a", "arguments": {}}, {"name": "b", "arguments": {"x": 1}}]}\n```',
    );
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") expect(r.calls.map((c) => c.function.name)).toEqual(["a", "b"]);
  });

  test("malformed JSON degrades to text, never throws", () => {
    const raw = '```json\n{"tool_call": {"name": broken}\n```';
    const r = parseReply(raw);
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.content).toBe(raw);
  });

  test("JSON without tool_call key degrades to text", () => {
    const raw = '```json\n{"answer": 42}\n```';
    expect(parseReply(raw).kind).toBe("text");
  });
});
