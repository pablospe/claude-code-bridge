// packages/http/src/renderer.ts
import type { ChatMessage, ToolDef } from "./openai-types.ts";

export const TOOL_CALL_INSTRUCTION =
  "If you need a tool, reply with ONLY a fenced json block of the shape " +
  '{"tool_call": {"name": "<tool name>", "arguments": {...}}} — or ' +
  '{"tool_calls": [...]} for multiple calls. Otherwise reply normally.';

/**
 * Normalize an OpenAI message `content` field to plain text. Accepts a string,
 * a content-parts array (joining the `text` of each text part, dropping non-text
 * parts like images), or null/anything else (empty string).
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "object" && part !== null) {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function renderMessage(m: ChatMessage): string {
  if (m.role === "tool") {
    return `[tool result for ${m.tool_call_id ?? "unknown"}]\n${contentToText(m.content)}`;
  }
  if (m.role === "assistant" && m.tool_calls !== undefined && m.tool_calls.length > 0) {
    const calls = m.tool_calls
      .map((c) => `[assistant tool_call ${c.id}]\n${c.function.name}(${c.function.arguments})`)
      .join("\n\n");
    const text = contentToText(m.content);
    return text.length > 0 ? `[assistant]\n${text}\n\n${calls}` : calls;
  }
  return `[${m.role}]\n${contentToText(m.content)}`;
}

/**
 * Render a stateless OpenAI messages array into a single prompt for one
 * bridge turn. System messages form a preamble; everything else becomes
 * labeled turns; tool schemas (if any) are appended with the call protocol.
 */
export function renderTranscript(
  messages: ReadonlyArray<ChatMessage>,
  tools: ReadonlyArray<ToolDef>,
): string {
  const parts: string[] = [];
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  if (system.length > 0) {
    parts.push(system.map((m) => contentToText(m.content)).join("\n\n"));
  }
  if (rest.length > 0) {
    parts.push(rest.map(renderMessage).join("\n\n"));
  }
  if (tools.length > 0) {
    const schemas = tools.map((t) => JSON.stringify(t.function, null, 2)).join("\n");
    parts.push(`[available tools]\n${schemas}\n\n${TOOL_CALL_INSTRUCTION}`);
  }
  parts.push("Respond to the conversation above.");
  return parts.join("\n\n");
}
