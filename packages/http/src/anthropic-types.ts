// packages/http/src/anthropic-types.ts
import {
  type ChatMessage,
  FUNCTION_NAME_PATTERN,
  type ToolCall,
  type ToolChoice,
  type ToolDef,
  type Validated,
} from "./openai-types.ts";

/**
 * Translated Anthropic request expressed in the facade's INTERNAL shapes, so
 * the existing renderer / tool-call parser are reused verbatim.
 */
export interface TranslatedRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools: ReadonlyArray<ToolDef>;
  readonly tool_choice: ToolChoice;
  readonly stream: boolean;
}

const ANTHROPIC_ROLES = new Set(["user", "assistant", "system"]);

/** Join an Anthropic text-block array (or a bare string) into plain text. */
function blocksToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, unknown>;
          if (p.type === "text" && typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** Translate the optional `system` field into a single internal text string. */
function systemToText(system: unknown): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) =>
        typeof b === "object" && b !== null && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .join("\n\n");
  }
  return undefined;
}

/** Map Anthropic `tool_choice` to the internal `ToolChoice`. */
function parseAnthropicToolChoice(value: unknown): Validated<ToolChoice> {
  if (value === undefined) return { ok: true, value: "auto" };
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "tool_choice must be an object with a 'type' field" };
  }
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "auto":
      return { ok: true, value: "auto" };
    case "any":
      return { ok: true, value: "required" };
    case "none":
      return { ok: true, value: "none" };
    case "tool": {
      if (typeof v.name !== "string" || v.name.length === 0) {
        return { ok: false, error: "tool_choice {type:'tool'} requires a non-empty 'name'" };
      }
      return { ok: true, value: { type: "function", function: { name: v.name } } };
    }
    default:
      return {
        ok: false,
        error: "tool_choice.type must be 'auto', 'any', 'none', or 'tool'",
      };
  }
}

/** Translate Anthropic `tools` into internal function tool defs. */
function translateTools(rawTools: unknown): Validated<ReadonlyArray<ToolDef>> {
  if (!Array.isArray(rawTools)) return { ok: true, value: [] };
  const out: ToolDef[] = [];
  for (const t of rawTools) {
    if (typeof t !== "object" || t === null) {
      return { ok: false, error: "every tool must be an object" };
    }
    const o = t as Record<string, unknown>;
    if (typeof o.name !== "string" || !FUNCTION_NAME_PATTERN.test(o.name)) {
      return {
        ok: false,
        error: `every tool needs a 'name' matching ${FUNCTION_NAME_PATTERN.source}`,
      };
    }
    const fn: ToolDef["function"] = {
      name: o.name,
      ...(typeof o.description === "string" ? { description: o.description } : {}),
      ...(o.input_schema !== undefined ? { parameters: o.input_schema } : {}),
    };
    out.push({ type: "function", function: fn });
  }
  return { ok: true, value: out };
}

/**
 * Translate one Anthropic message into zero or more internal ChatMessages.
 * - assistant: text blocks form the content; tool_use blocks become tool_calls.
 * - user: tool_result blocks become role:"tool" messages (emitted first), and
 *   any remaining text becomes a single user message after them.
 */
function translateMessage(role: "user" | "assistant" | "system", content: unknown): ChatMessage[] {
  // Mid-conversation system message (beta mid-conversation-system-2026-04-07):
  // join its text into a single internal system ChatMessage at its position.
  if (role === "system") {
    return [{ role: "system", content: blocksToText(content) }];
  }

  // Bare string content: a single message of the same role.
  if (typeof content === "string") {
    return [{ role, content }];
  }
  if (!Array.isArray(content)) {
    return [{ role, content: "" }];
  }

  if (role === "assistant") {
    const toolCalls: ToolCall[] = [];
    const texts: string[] = [];
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as Record<string, unknown>;
      if (p.type === "tool_use" && typeof p.id === "string" && typeof p.name === "string") {
        toolCalls.push({
          id: p.id,
          type: "function",
          function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) },
        });
      } else if (p.type === "text" && typeof p.text === "string") {
        texts.push(p.text);
      }
    }
    const text = texts.join("");
    if (toolCalls.length > 0) {
      return [{ role: "assistant", content: text.length > 0 ? text : null, tool_calls: toolCalls }];
    }
    return [{ role: "assistant", content: text }];
  }

  // role === "user": tool_result messages first, then remaining text.
  const toolMessages: ChatMessage[] = [];
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (p.type === "tool_result" && typeof p.tool_use_id === "string") {
      toolMessages.push({
        role: "tool",
        tool_call_id: p.tool_use_id,
        content: blocksToText(p.content),
      });
    } else if (p.type === "text" && typeof p.text === "string") {
      texts.push(p.text);
    }
  }
  const out: ChatMessage[] = [...toolMessages];
  const text = texts.join("");
  if (text.length > 0 || toolMessages.length === 0) {
    out.push({ role: "user", content: text });
  }
  return out;
}

/**
 * Validate an Anthropic Messages request and translate it into the internal
 * request shape. Validation mirrors the OpenAI dialect's rigor: messages must
 * be a non-empty array of user|assistant messages; a forced/`any` tool_choice
 * requires a non-empty tools array; a forced tool name must be present in tools
 * and match the function-name pattern.
 */
export function validateAnthropicRequest(body: unknown): Validated<TranslatedRequest> {
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
    if (typeof role !== "string" || !ANTHROPIC_ROLES.has(role)) {
      return { ok: false, error: "every message needs a role of user|assistant|system" };
    }
  }

  const toolChoice = parseAnthropicToolChoice(b.tool_choice);
  if (!toolChoice.ok) {
    return { ok: false, error: toolChoice.error };
  }
  const translatedTools = translateTools(b.tools);
  if (!translatedTools.ok) {
    return { ok: false, error: translatedTools.error };
  }
  const tools = translatedTools.value;

  // Cross-field checks mirroring validateChatRequest.
  const choice = toolChoice.value;
  const isForced = typeof choice === "object";
  if ((choice === "required" || isForced) && tools.length === 0) {
    return {
      ok: false,
      error: "tool_choice 'any' or a forced tool requires a non-empty tools array",
    };
  }
  if (isForced) {
    const name = choice.function.name;
    if (!FUNCTION_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        error: `tool_choice function name '${name}' must match ${FUNCTION_NAME_PATTERN.source}`,
      };
    }
    if (!tools.some((t) => t.function?.name === name)) {
      return { ok: false, error: `tool_choice function '${name}' is not present in tools` };
    }
  }

  const messages: ChatMessage[] = [];
  const systemText = systemToText(b.system);
  if (systemText !== undefined) {
    messages.push({ role: "system", content: systemText });
  }
  for (const m of b.messages) {
    const mm = m as { role: "user" | "assistant" | "system"; content: unknown };
    messages.push(...translateMessage(mm.role, mm.content));
  }

  return {
    ok: true,
    value: {
      model: typeof b.model === "string" ? b.model : "ccb-claude",
      messages,
      tools,
      tool_choice: choice,
      stream: b.stream === true,
    },
  };
}
