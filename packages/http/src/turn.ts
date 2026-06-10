import type { ClaudeCodeBridge } from "@ccb/core";

export interface RunTurnOptions {
  readonly bridge: ClaudeCodeBridge;
  readonly sessionId: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  /** Invoked for each progress/partial-reply delta as it arrives. */
  readonly onDelta?: (delta: string) => void;
}

export interface TurnResult {
  /** Final reply content; empty string if the turn ended via agent.done only. */
  readonly content: string;
}

/**
 * Run exactly one turn against an open session. Subscribes to the live event
 * stream BEFORE sending so no event is missed, then resolves on the first
 * turn-terminal event: agent.reply{final:true} or agent.done (both must be
 * handled — agent.done is the only signal for a no-reply turn).
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { bridge, sessionId, prompt, timeoutMs, onDelta } = options;
  const events = bridge.events(sessionId);

  const turn = (async (): Promise<TurnResult> => {
    await bridge.sendMessage(sessionId, prompt);
    let finalContent = "";
    for await (const ev of events) {
      if (ev.type === "agent.progress") {
        onDelta?.(ev.content);
        continue;
      }
      if (ev.type === "agent.reply") {
        onDelta?.(ev.content);
        if (ev.final) return { content: ev.content };
        finalContent += ev.content;
        continue;
      }
      if (ev.type === "agent.done") return { content: finalContent };
      if (ev.type === "session.ended") {
        throw new Error(`session ended mid-turn${ev.reason ? `: ${ev.reason}` : ""}`);
      }
    }
    throw new Error("event stream closed without a terminal event");
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`turn timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([turn, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
