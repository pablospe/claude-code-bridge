import type { ClaudeCodeBridge } from "@ccb/core";
import type {
  AcpRuntime,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurn,
  AcpRuntimeTurnInput,
  AcpRuntimeTurnResult,
} from "./acp-contract.ts";
import { translateBridgeEvent } from "./translator.ts";

export const CLAUDE_BRIDGE_BACKEND_ID = "claude-bridge";

/**
 * Single-consumer async channel for one turn's events. The router pushes
 * translated events as ccb emits them; the ACP consumer drains them via the
 * async iterator. `finish` ends the stream and resolves the terminal result.
 */
class TurnChannel {
  #queue: AcpRuntimeEvent[] = [];
  #waiting: ((r: IteratorResult<AcpRuntimeEvent>) => void) | null = null;
  #ended = false;
  #resolveResult!: (r: AcpRuntimeTurnResult) => void;
  readonly result: Promise<AcpRuntimeTurnResult>;

  constructor() {
    this.result = new Promise((resolve) => {
      this.#resolveResult = resolve;
    });
  }

  get ended(): boolean {
    return this.#ended;
  }

  push(ev: AcpRuntimeEvent): void {
    if (this.#ended) return;
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w({ value: ev, done: false });
      return;
    }
    this.#queue.push(ev);
  }

  finish(result: AcpRuntimeTurnResult): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#resolveResult(result);
    if (this.#waiting) {
      const w = this.#waiting;
      this.#waiting = null;
      w({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
    return {
      next: (): Promise<IteratorResult<AcpRuntimeEvent>> => {
        if (this.#queue.length > 0) {
          return Promise.resolve({ value: this.#queue.shift() as AcpRuntimeEvent, done: false });
        }
        if (this.#ended) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}

type SessionState = {
  ccbId: string;
  /** Currently in-flight turn's channel, or null between turns. */
  activeTurn: TurnChannel | null;
  closed: boolean;
  pump: Promise<void>;
};

export type ClaudeBridgeRuntimeOptions = {
  bridge: ClaudeCodeBridge;
  /** Registry backend id reported on the handle. Defaults to "claude-bridge". */
  backendId?: string;
};

/**
 * Build an OpenClaw `AcpRuntime` backed by a ccb `Bridge`. The bridge owns the
 * interactive `claude` process (the reasoner, spending the Max subscription's
 * interactive quota); this adapter only translates between ACP turns and ccb's
 * channel-in / MCP-tools-out event surface.
 */
export function createClaudeBridgeRuntime(options: ClaudeBridgeRuntimeOptions): AcpRuntime {
  const { bridge } = options;
  const backendId = options.backendId ?? CLAUDE_BRIDGE_BACKEND_ID;
  const sessions = new Map<string, SessionState>();

  // One long-lived events() subscription per ccb session. ccb's events() is a
  // live tail from subscribe-time forward, so we subscribe in ensureSession
  // (before any sendMessage) to avoid missing a turn's first events. Each
  // event is routed to the active turn; terminal events resolve + clear it.
  async function pumpEvents(state: SessionState): Promise<void> {
    try {
      for await (const ev of bridge.events(state.ccbId)) {
        const { events, terminal } = translateBridgeEvent(ev);
        const turn = state.activeTurn;
        if (turn) {
          for (const out of events) turn.push(out);
          if (terminal) {
            turn.finish(terminal);
            state.activeTurn = null;
          }
        }
        if (state.closed) break;
      }
    } catch {
      // events() ended or the bridge tore down; surface as a failed terminal
      // to any waiting turn so the consumer never hangs.
      const turn = state.activeTurn;
      if (turn && !turn.ended) {
        turn.finish({ status: "failed", error: { message: "bridge event stream ended" } });
        state.activeTurn = null;
      }
    }
  }

  function handleFor(sessionKey: string, ccbId: string): AcpRuntimeHandle {
    return {
      sessionKey,
      backend: backendId,
      runtimeSessionName: ccbId,
      backendSessionId: ccbId,
    };
  }

  function requireOpen(sessionKey: string): SessionState | null {
    const state = sessions.get(sessionKey);
    if (!state || state.closed) return null;
    return state;
  }

  return {
    async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
      // Idempotent: OpenClaw may call ensureSession repeatedly for one session
      // key. Reuse the live ccb session so we don't spawn a second claude.
      const existing = requireOpen(input.sessionKey);
      if (existing) return handleFor(input.sessionKey, existing.ccbId);

      const handle = await bridge.startSession({});
      const state: SessionState = {
        ccbId: handle.id,
        activeTurn: null,
        closed: false,
        pump: Promise.resolve(),
      };
      state.pump = pumpEvents(state);
      sessions.set(input.sessionKey, state);
      return handleFor(input.sessionKey, handle.id);
    },

    startTurn(input: AcpRuntimeTurnInput): AcpRuntimeTurn {
      const state = requireOpen(input.handle.sessionKey);
      const channel = new TurnChannel();

      if (!state) {
        channel.finish({
          status: "failed",
          error: { message: `no open claude-bridge session for ${input.handle.sessionKey}` },
        });
        return {
          requestId: input.requestId,
          events: channel,
          result: channel.result,
          cancel: async () => {},
          closeStream: async () => {},
        };
      }

      // Set the active turn BEFORE sending so reply events route to it.
      state.activeTurn = channel;
      void bridge.sendMessage(state.ccbId, input.text).catch((err) => {
        if (!channel.ended) {
          const message = err instanceof Error ? err.message : String(err);
          channel.finish({ status: "failed", error: { message } });
          if (state.activeTurn === channel) state.activeTurn = null;
        }
      });

      const stop = (status: "cancelled") => {
        if (!channel.ended) {
          channel.finish({ status });
          if (state.activeTurn === channel) state.activeTurn = null;
        }
      };

      return {
        requestId: input.requestId,
        events: channel,
        result: channel.result,
        cancel: async () => {
          await bridge.interrupt(state.ccbId).catch(() => {});
          stop("cancelled");
        },
        closeStream: async () => {
          stop("cancelled");
        },
      };
    },

    async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
      // Fallback turn API: delegate to startTurn and relay its event stream.
      // The in-stream `done`/`error` event terminates iteration.
      const turn = this.startTurn?.(input);
      if (!turn) {
        yield { type: "error", message: "startTurn unavailable" };
        return;
      }
      yield* turn.events;
    },

    getCapabilities() {
      // We do not support runtime mode/config switching on a bridged session.
      return { controls: [] };
    },

    async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
      const state = requireOpen(input.handle.sessionKey);
      return {
        summary: state ? "claude-bridge session open" : "claude-bridge session closed",
        backendSessionId: input.handle.backendSessionId,
      };
    },

    async cancel(input: { handle: AcpRuntimeHandle }): Promise<void> {
      const state = requireOpen(input.handle.sessionKey);
      if (!state) return;
      await bridge.interrupt(state.ccbId).catch(() => {});
      if (state.activeTurn && !state.activeTurn.ended) {
        state.activeTurn.finish({ status: "cancelled" });
        state.activeTurn = null;
      }
    },

    async close(input: { handle: AcpRuntimeHandle }): Promise<void> {
      const state = sessions.get(input.handle.sessionKey);
      if (!state) return;
      state.closed = true;
      if (state.activeTurn && !state.activeTurn.ended) {
        state.activeTurn.finish({ status: "cancelled" });
        state.activeTurn = null;
      }
      await bridge.close(state.ccbId).catch(() => {});
      await state.pump.catch(() => {});
      sessions.delete(input.handle.sessionKey);
    },

    async doctor(): Promise<AcpRuntimeDoctorReport> {
      return { ok: true, message: "claude-bridge runtime ready" };
    },
  };
}
