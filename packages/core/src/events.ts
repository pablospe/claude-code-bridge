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
  | { type: "session.ended"; sessionId: string; reason?: string }
  | {
      type: "permission.requested";
      sessionId: string;
      requestId: string;
      toolName: string;
      /** Human-readable summary of the call (claude's `description`). */
      description: string;
      /** Tool args as a JSON string, truncated to 200 chars by the platform. */
      inputPreview: string;
    }
  | {
      type: "permission.resolved";
      sessionId: string;
      requestId: string;
      /**
       * "allow" / "deny" — a consumer verdict the bridge sent over the wire.
       * "unanswered-remotely" — the bridge stopped waiting; the real outcome is
       *   unknown (read the subsequent tool.event).
       * "aborted" — the session ended with the request still open.
       * "terminal" — RESERVED, never emitted today (no platform signal exists
       *   for the local terminal winning the race).
       */
      outcome: "allow" | "deny" | "unanswered-remotely" | "aborted" | "terminal";
      /** Optional audit metadata persisted locally; never crosses the wire. */
      approver?: { userId: string; displayName?: string };
    };
