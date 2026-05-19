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
  | { type: "agent.done"; sessionId: string; messageId?: string; reason?: string }
  | { type: "agent.input_requested"; sessionId: string; requestId: string; prompt: string }
  | {
      type: "tool.event";
      sessionId: string;
      /**
       * `event` is the hook event name verbatim (e.g. "PreToolUse"). `data`
       * carries claude's hook payload after per-field 64 KB truncation; when
       * `tool_input` or `tool_result` is truncated, the field name appears in
       * `data.truncated_fields`.
       */
      payload: { event: string; data: unknown };
    }
  | { type: "session.ended"; sessionId: string; reason?: string };
