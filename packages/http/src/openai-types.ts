// packages/http/src/openai-types.ts
export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | ReadonlyArray<{ type: string; text?: string }> | null;
  readonly tool_calls?: ReadonlyArray<ToolCall>;
  readonly tool_call_id?: string;
}

export interface ToolDef {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly function: { readonly name: string } };

export interface ChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools: ReadonlyArray<ToolDef>;
  readonly stream: boolean;
  readonly tool_choice: ToolChoice;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const TOOL_CHOICE_LITERALS = new Set(["auto", "none", "required"]);

/**
 * Parse the optional `tool_choice` field. Accepts the three string literals
 * ("auto" | "none" | "required") and the forced-function object form
 * ({ type: "function", function: { name } }), defaulting to "auto" when absent.
 */
function parseToolChoice(value: unknown): Validated<ToolChoice> {
  if (value === undefined) return { ok: true, value: "auto" };
  if (typeof value === "string" && TOOL_CHOICE_LITERALS.has(value)) {
    return { ok: true, value: value as ToolChoice };
  }
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    const fn = v.function as Record<string, unknown> | undefined;
    if (v.type === "function" && typeof fn?.name === "string" && fn.name.length > 0) {
      return { ok: true, value: { type: "function", function: { name: fn.name } } };
    }
  }
  return { ok: false, error: "unsupported tool_choice" };
}

/**
 * Validate the request envelope. Only each message's `role` is checked here;
 * `content` (string or content-parts array) and `tool_calls` shapes are
 * normalized or tolerated downstream by the renderer, not enforced here.
 */
export function validateChatRequest(body: unknown): Validated<ChatRequest> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, error: "'messages' must be a non-empty array" };
  }
  for (const m of b.messages) {
    if (typeof m !== "object" || m === null) {
      return { ok: false, error: "every message must be an object" };
    }
    const role = (m as Record<string, unknown>).role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      return { ok: false, error: "every message needs a role of system|user|assistant|tool" };
    }
  }
  const toolChoice = parseToolChoice(b.tool_choice);
  if (!toolChoice.ok) {
    return { ok: false, error: toolChoice.error };
  }
  return {
    ok: true,
    value: {
      model: typeof b.model === "string" ? b.model : "ccb-claude",
      messages: b.messages as ReadonlyArray<ChatMessage>,
      tools: Array.isArray(b.tools) ? (b.tools as ReadonlyArray<ToolDef>) : [],
      stream: b.stream === true,
      tool_choice: toolChoice.value,
    },
  };
}
