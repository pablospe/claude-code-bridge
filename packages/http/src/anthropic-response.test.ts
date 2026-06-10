// packages/http/src/anthropic-response.test.ts
import { describe, expect, test } from "bun:test";
import {
  blockStopEvent,
  buildAnthropicMessage,
  inputJsonDeltaEvent,
  messageDeltaEvent,
  messageStartEvent,
  messageStopEvent,
  newAnthropicMessageId,
  sseEvent,
  textBlockStartEvent,
  textDeltaEvent,
  toolUseBlockStartEvent,
} from "./anthropic-response.ts";
import { estimateTokens } from "./response.ts";

describe("newAnthropicMessageId", () => {
  test("msg_ prefix, no dashes", () => {
    const id = newAnthropicMessageId();
    expect(id).toMatch(/^msg_[0-9a-f]{32}$/);
  });
});

describe("buildAnthropicMessage", () => {
  test("text result shape", () => {
    const prompt = "p".repeat(40);
    const r = buildAnthropicMessage({
      model: "claude-3",
      prompt,
      parsed: { kind: "text", content: "hello" },
    });
    expect(r.id).toMatch(/^msg_/);
    expect(r.type).toBe("message");
    expect(r.role).toBe("assistant");
    expect(r.model).toBe("claude-3");
    expect(r.content).toEqual([{ type: "text", text: "hello" }]);
    expect(r.stop_reason).toBe("end_turn");
    expect(r.stop_sequence).toBeNull();
    expect(r.usage.input_tokens).toBe(estimateTokens(prompt));
    expect(r.usage.output_tokens).toBe(estimateTokens("hello"));
  });

  test("tool_use result: input parsed to object, stop_reason tool_use", () => {
    const r = buildAnthropicMessage({
      model: "m",
      prompt: "p",
      parsed: {
        kind: "tool_calls",
        calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          },
        ],
      },
    });
    expect(r.content).toEqual([
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "SF" } },
    ]);
    expect(r.stop_reason).toBe("tool_use");
  });

  test("tool_use with invalid arguments JSON falls back to {}", () => {
    const r = buildAnthropicMessage({
      model: "m",
      prompt: "p",
      parsed: {
        kind: "tool_calls",
        calls: [{ id: "c", type: "function", function: { name: "f", arguments: "not json" } }],
      },
    });
    expect(r.content[0]).toEqual({ type: "tool_use", id: "c", name: "f", input: {} });
  });

  test("output_tokens for tool_calls uses JSON.stringify(calls)", () => {
    const calls = [
      { id: "c", type: "function" as const, function: { name: "f", arguments: "{}" } },
    ];
    const r = buildAnthropicMessage({
      model: "m",
      prompt: "p",
      parsed: { kind: "tool_calls", calls },
    });
    expect(r.usage.output_tokens).toBe(estimateTokens(JSON.stringify(calls)));
  });
});

describe("sse framing helpers", () => {
  function parse(frame: string): { type: string; data: unknown } {
    const lines = frame.split("\n");
    expect(lines[0]).toMatch(/^event: /);
    const eventType = lines[0]?.slice("event: ".length) ?? "";
    const dataLine = lines.find((l) => l.startsWith("data: "));
    const data = JSON.parse(dataLine?.slice("data: ".length) ?? "null");
    return { type: eventType, data };
  }

  test("sseEvent format", () => {
    const frame = sseEvent("ping", { ok: true });
    expect(frame).toBe('event: ping\ndata: {"ok":true}\n\n');
  });

  test("messageStartEvent embeds usage.input_tokens", () => {
    const frame = messageStartEvent("msg_1", "claude-3", 42);
    const { type, data } = parse(frame);
    expect(type).toBe("message_start");
    const d = data as { type: string; message: Record<string, unknown> };
    expect(d.type).toBe("message_start");
    const msg = d.message as Record<string, unknown>;
    expect(msg.id).toBe("msg_1");
    expect(msg.model).toBe("claude-3");
    expect((msg.usage as Record<string, number>).input_tokens).toBe(42);
    expect((msg.usage as Record<string, number>).output_tokens).toBe(0);
    expect(msg.content).toEqual([]);
    expect(msg.stop_reason).toBeNull();
  });

  test("textBlockStartEvent", () => {
    const { type, data } = parse(textBlockStartEvent(0));
    expect(type).toBe("content_block_start");
    const d = data as { type: string; index: number; content_block: Record<string, unknown> };
    expect(d.type).toBe("content_block_start");
    expect(d.index).toBe(0);
    expect(d.content_block).toEqual({ type: "text", text: "" });
  });

  test("textDeltaEvent", () => {
    const { type, data } = parse(textDeltaEvent(0, "hi"));
    expect(type).toBe("content_block_delta");
    const d = data as { type: string; index: number; delta: Record<string, unknown> };
    expect(d.index).toBe(0);
    expect(d.delta).toEqual({ type: "text_delta", text: "hi" });
  });

  test("toolUseBlockStartEvent", () => {
    const { type, data } = parse(toolUseBlockStartEvent(1, "tu_1", "f"));
    expect(type).toBe("content_block_start");
    const d = data as { index: number; content_block: Record<string, unknown> };
    expect(d.index).toBe(1);
    expect(d.content_block).toEqual({ type: "tool_use", id: "tu_1", name: "f", input: {} });
  });

  test("inputJsonDeltaEvent", () => {
    const { type, data } = parse(inputJsonDeltaEvent(1, '{"a":1}'));
    expect(type).toBe("content_block_delta");
    const d = data as { index: number; delta: Record<string, unknown> };
    expect(d.index).toBe(1);
    expect(d.delta).toEqual({ type: "input_json_delta", partial_json: '{"a":1}' });
  });

  test("blockStopEvent", () => {
    const { type, data } = parse(blockStopEvent(2));
    expect(type).toBe("content_block_stop");
    const d = data as { type: string; index: number };
    expect(d.type).toBe("content_block_stop");
    expect(d.index).toBe(2);
  });

  test("messageDeltaEvent", () => {
    const { type, data } = parse(messageDeltaEvent("tool_use", 7));
    expect(type).toBe("message_delta");
    const d = data as {
      type: string;
      delta: Record<string, unknown>;
      usage: Record<string, number>;
    };
    expect(d.type).toBe("message_delta");
    expect(d.delta).toEqual({ stop_reason: "tool_use", stop_sequence: null });
    expect(d.usage).toEqual({ output_tokens: 7 });
  });

  test("messageStopEvent", () => {
    const { type, data } = parse(messageStopEvent());
    expect(type).toBe("message_stop");
    expect((data as { type: string }).type).toBe("message_stop");
  });
});
