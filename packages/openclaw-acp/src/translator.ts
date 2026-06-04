import {
  type BridgeEvent,
  CRASH_AGENT_DONE_REASON,
  CRASH_SESSION_ENDED_REASON,
} from "@ccb/core";
import type { AcpRuntimeEvent, AcpRuntimeTurnResult } from "./acp-contract.ts";

/**
 * Result of translating one ccb BridgeEvent into the ACP runtime surface.
 *
 * `events` are streamed to the ACP consumer in order. `terminal` is non-null
 * only on the event that ends a turn (final reply, agent.done, or an abnormal
 * session end) — the adapter resolves the turn result from it. ccb emits
 * MESSAGE-level chunks (not tokens), so each maps to one whole text_delta.
 */
export type TranslateResult = {
  events: AcpRuntimeEvent[];
  terminal: AcpRuntimeTurnResult | null;
};

const EMPTY: TranslateResult = { events: [], terminal: null };

function toolName(data: unknown): string {
  if (data && typeof data === "object" && "tool_name" in data) {
    const name = (data as { tool_name?: unknown }).tool_name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return "tool";
}

export function translateBridgeEvent(ev: BridgeEvent): TranslateResult {
  switch (ev.type) {
    // Session/message lifecycle echoes carry no turn content.
    case "session.started":
    case "message.sent":
      return EMPTY;

    // Whole-chunk assistant text. Not token-level.
    case "agent.progress":
      return {
        events: [
          {
            type: "text_delta",
            text: ev.content,
            stream: "output",
            tag: "agent_message_chunk",
          },
        ],
        terminal: null,
      };

    case "agent.reply": {
      const events: AcpRuntimeEvent[] = [
        {
          type: "text_delta",
          text: ev.content,
          stream: "output",
          tag: "agent_message_chunk",
        },
      ];
      if (ev.final) {
        // A final reply closes the turn; emit an in-stream done for runTurn
        // consumers and a terminal result for startTurn consumers.
        events.push({ type: "done" });
        return { events, terminal: { status: "completed" } };
      }
      return { events, terminal: null };
    }

    // Explicit turn close. ccb synthesizes this with a crash reason on
    // supervisor crash / channel disconnect — surface that as a failure.
    case "agent.done": {
      if (ev.reason === CRASH_AGENT_DONE_REASON) {
        return {
          events: [{ type: "error", message: ev.reason, retryable: true }],
          terminal: { status: "failed", error: { message: ev.reason, retryable: true } },
        };
      }
      return {
        events: [{ type: "done", stopReason: ev.reason }],
        terminal: { status: "completed", stopReason: ev.reason },
      };
    }

    // Observational hook relay (PreToolUse / PostToolUse / Stop).
    case "tool.event": {
      const name = toolName(ev.payload.data);
      if (ev.payload.event === "PreToolUse") {
        return {
          events: [
            { type: "tool_call", text: name, status: "in_progress", title: name, tag: "tool_call" },
          ],
          terminal: null,
        };
      }
      if (ev.payload.event === "PostToolUse") {
        return {
          events: [
            {
              type: "tool_call",
              text: name,
              status: "completed",
              title: name,
              tag: "tool_call_update",
            },
          ],
          terminal: null,
        };
      }
      // Stop and any other hook events have no canonical ACP mapping.
      return EMPTY;
    }

    // Reserved for a future elicitation relay; ccb does not mint it today.
    case "agent.input_requested":
      return EMPTY;

    case "session.ended": {
      if (ev.reason === CRASH_SESSION_ENDED_REASON) {
        const message = ev.reason;
        return {
          events: [{ type: "error", message, retryable: true }],
          terminal: { status: "failed", error: { message, retryable: true } },
        };
      }
      return {
        events: [{ type: "done", stopReason: ev.reason }],
        terminal: { status: "completed", stopReason: ev.reason },
      };
    }

    default:
      return EMPTY;
  }
}
