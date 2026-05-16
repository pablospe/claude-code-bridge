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
      return `[agent.progress] ${JSON.stringify(event.content)}`;
    case "agent.reply":
      return `[agent.reply final=${event.final}] ${JSON.stringify(event.content)}`;
    case "agent.input_requested":
      return `[agent.input_requested] ${event.requestId} ${JSON.stringify(event.prompt)}`;
    case "tool.event":
      return `[tool.event] ${JSON.stringify(event.payload)}`;
    case "session.ended":
      return `[session.ended] reason=${event.reason ?? ""}`;
    default: {
      const _exhaustive: never = event;
      throw new Error(`unknown event: ${String(_exhaustive)}`);
    }
  }
};
