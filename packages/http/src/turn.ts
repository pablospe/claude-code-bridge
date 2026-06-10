import type { ClaudeCodeBridge } from "@ccb/core";

/** Thrown when a turn exceeds its time budget without a terminal event. */
export class TurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`turn timed out after ${timeoutMs}ms`);
    this.name = "TurnTimeoutError";
  }
}

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
 *
 * Non-final agent.reply events are partial chunks; the final reply is the last
 * chunk. The turn's content is their concatenation, mirroring how the SSE
 * deltas concatenate client-side.
 *
 * The event iterator is hoisted and disposed in a finally so an abandoned turn
 * (timeout) or a completed turn releases its EventBus subscriber promptly.
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { bridge, sessionId, prompt, timeoutMs, onDelta } = options;
  const events = bridge.events(sessionId);
  const it = events[Symbol.asyncIterator]();

  const turn = (async (): Promise<TurnResult> => {
    await bridge.sendMessage(sessionId, prompt);
    let finalContent = "";
    while (true) {
      const { value: ev, done } = await it.next();
      if (done) throw new Error("event stream closed without a terminal event");
      if (ev.type === "agent.progress") {
        onDelta?.(ev.content);
        continue;
      }
      if (ev.type === "agent.reply") {
        onDelta?.(ev.content);
        if (ev.final) return { content: finalContent + ev.content };
        finalContent += ev.content;
        continue;
      }
      if (ev.type === "agent.done") return { content: finalContent };
      if (ev.type === "session.ended") {
        throw new Error(`session ended mid-turn${ev.reason ? `: ${ev.reason}` : ""}`);
      }
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TurnTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([turn, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void it.return?.(undefined);
  }
}
