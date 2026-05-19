import type { BridgeEvent } from "@ccb/core";

export type Formatter = (event: BridgeEvent) => string;

export const formatJson: Formatter = (event) => JSON.stringify(event);

const truncateShort = (s: string, maxChars = 60): string =>
  s.length <= maxChars ? s : `${s.slice(0, maxChars - 1)}…`;

const summarizeToolInput = (toolName: string, toolInput: unknown): string => {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  let raw: string;
  if (toolName === "Bash" && typeof input.command === "string") {
    raw = JSON.stringify(input.command);
  } else if (
    (toolName === "Read" || toolName === "Write" || toolName === "Edit") &&
    typeof input.file_path === "string"
  ) {
    raw = JSON.stringify(input.file_path);
  } else {
    raw = JSON.stringify(toolInput ?? {});
  }
  return truncateShort(raw);
};

const summarizeToolResult = (toolResult: unknown): string => {
  if (toolResult === undefined) return "ok";
  const bytes = Buffer.byteLength(JSON.stringify(toolResult ?? ""), "utf8");
  if (bytes < 1024) return `(${bytes} B)`;
  return `(${(bytes / 1024).toFixed(1)}KB)`;
};

const formatToolEvent = (payload: { event: string; data: unknown }): string => {
  const { event, data } = payload;
  const d = (data ?? {}) as Record<string, unknown>;
  const truncatedFields = Array.isArray(d.truncated_fields) ? (d.truncated_fields as string[]) : [];
  const toolName = typeof d.tool_name === "string" ? d.tool_name : "";
  if (event === "PreToolUse") {
    const summary = summarizeToolInput(toolName, d.tool_input);
    const suffix = truncatedFields.includes("tool_input") ? " (truncated)" : "";
    return `[tool.event] PreToolUse ${toolName} ${summary}${suffix}`;
  }
  if (event === "PostToolUse") {
    const summary = summarizeToolResult(d.tool_result);
    const suffix = truncatedFields.includes("tool_result") ? " (truncated)" : "";
    return `[tool.event] PostToolUse ${toolName} ${summary}${suffix}`;
  }
  if (event === "Stop") {
    return "[tool.event] Stop (per-message)";
  }
  return `[tool.event] ${event} ${truncateShort(JSON.stringify(data ?? {}))}`;
};

export const formatPretty: Formatter = (event) => {
  switch (event.type) {
    case "session.started":
      return `[session.started] ${event.sessionId}`;
    case "message.sent":
      return `[message.sent] ${event.messageId} ${JSON.stringify(event.content)}`;
    case "agent.progress":
      return event.messageId !== undefined
        ? `[agent.progress] ${event.messageId} ${JSON.stringify(event.content)}`
        : `[agent.progress] ${JSON.stringify(event.content)}`;
    case "agent.reply":
      return event.messageId !== undefined
        ? `[agent.reply final=${event.final}] ${event.messageId} ${JSON.stringify(event.content)}`
        : `[agent.reply final=${event.final}] ${JSON.stringify(event.content)}`;
    case "agent.done": {
      const parts: string[] = [];
      if (event.messageId !== undefined) parts.push(event.messageId);
      if (event.reason !== undefined) parts.push(`reason=${event.reason}`);
      return parts.length === 0 ? "[agent.done]" : `[agent.done] ${parts.join(" ")}`;
    }
    case "agent.input_requested":
      return `[agent.input_requested] ${event.requestId} ${JSON.stringify(event.prompt)}`;
    case "tool.event":
      return formatToolEvent(event.payload);
    case "session.ended":
      return event.reason !== undefined
        ? `[session.ended] reason=${event.reason}`
        : "[session.ended]";
    default: {
      const _exhaustive: never = event;
      throw new Error(`unknown event: ${String(_exhaustive)}`);
    }
  }
};
