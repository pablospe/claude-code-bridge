import type { BridgeEvent } from "@ccb/core";

export type Formatter = (event: BridgeEvent) => string;

export const formatJson: Formatter = (event) => JSON.stringify(event);

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
      return `[tool.event] ${JSON.stringify(event.payload)}`;
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
