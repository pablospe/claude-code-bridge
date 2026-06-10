// packages/http/src/response.ts
import type { ToolCall } from "./openai-types.ts";
import type { ParsedReply } from "./tool-call-parser.ts";

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<ToolCall>;
}

export interface ChatCompletion {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly index: 0;
    readonly message: AssistantMessage;
    readonly finish_reason: "stop" | "tool_calls";
  }>;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

export function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

export function buildCompletion(input: {
  model: string;
  prompt: string;
  parsed: ParsedReply;
}): ChatCompletion {
  const { model, prompt, parsed } = input;
  const message: AssistantMessage =
    parsed.kind === "text"
      ? { role: "assistant", content: parsed.content }
      : { role: "assistant", content: null, tool_calls: parsed.calls };
  const completionText = parsed.kind === "text" ? parsed.content : JSON.stringify(parsed.calls);
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(completionText);
  return {
    id: newCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: parsed.kind === "text" ? "stop" : "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export interface ChatChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly index: 0;
    readonly delta: {
      readonly role?: "assistant";
      readonly content?: string;
      readonly tool_calls?: ReadonlyArray<ToolCall & { readonly index: number }>;
    };
    readonly finish_reason: "stop" | "tool_calls" | null;
  }>;
}

export function buildChunk(input: {
  id: string;
  model: string;
  delta: ChatChunk["choices"][number]["delta"];
  finishReason?: "stop" | "tool_calls";
}): ChatChunk {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [{ index: 0, delta: input.delta, finish_reason: input.finishReason ?? null }],
  };
}
