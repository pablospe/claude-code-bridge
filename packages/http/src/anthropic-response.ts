// packages/http/src/anthropic-response.ts
import { estimateTokens } from "./response.ts";
import type { ParsedReply } from "./tool-call-parser.ts";

export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    };

export interface AnthropicMessageResponse {
  readonly id: string;
  readonly type: "message";
  readonly role: "assistant";
  readonly model: string;
  readonly content: ReadonlyArray<AnthropicContentBlock>;
  readonly stop_reason: "end_turn" | "tool_use";
  readonly stop_sequence: null;
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

export function newAnthropicMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * Parse tool-call arguments JSON into a plain object for a tool_use block's
 * `input`. Anthropic requires `input` to be an object; any non-object result
 * (string, array, null) or parse error falls back to {}.
 */
export function toolUseInput(argumentsJson: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export function buildAnthropicMessage(input: {
  model: string;
  prompt: string;
  parsed: ParsedReply;
}): AnthropicMessageResponse {
  const { model, prompt, parsed } = input;
  const content: AnthropicContentBlock[] =
    parsed.kind === "text"
      ? [{ type: "text", text: parsed.content }]
      : parsed.calls.map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.function.name,
          input: toolUseInput(c.function.arguments),
        }));
  const completionText = parsed.kind === "text" ? parsed.content : JSON.stringify(content);
  return {
    id: newAnthropicMessageId(),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: parsed.kind === "text" ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: estimateTokens(prompt),
      output_tokens: estimateTokens(completionText),
    },
  };
}

export function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function messageStartEvent(id: string, model: string, promptTokens: number): string {
  return sseEvent("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: promptTokens, output_tokens: 0 },
    },
  });
}

export function textBlockStartEvent(index: number): string {
  return sseEvent("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
}

export function textDeltaEvent(index: number, text: string): string {
  return sseEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

export function toolUseBlockStartEvent(index: number, id: string, name: string): string {
  return sseEvent("content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} },
  });
}

export function inputJsonDeltaEvent(index: number, partialJson: string): string {
  return sseEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

export function blockStopEvent(index: number): string {
  return sseEvent("content_block_stop", { type: "content_block_stop", index });
}

export function messageDeltaEvent(
  stopReason: "end_turn" | "tool_use",
  outputTokens: number,
): string {
  return sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

export function messageStopEvent(): string {
  return sseEvent("message_stop", { type: "message_stop" });
}
