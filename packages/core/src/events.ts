export type BridgeEvent =
  | { type: "session.started"; sessionId: string }
  | { type: "message.sent"; sessionId: string; messageId: string; content: string }
  | { type: "agent.progress"; sessionId: string; messageId?: string; content: string }
  | {
      type: "agent.reply";
      sessionId: string;
      messageId?: string;
      content: string;
      final: boolean;
    }
  | { type: "agent.input_requested"; sessionId: string; requestId: string; prompt: string }
  | { type: "tool.event"; sessionId: string; payload: unknown }
  | { type: "session.ended"; sessionId: string; reason?: string };
