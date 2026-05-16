import { Bridge, type BridgeEvent, type SupervisorFactory } from "@ccb/core";
import { type Formatter, formatJson, formatPretty } from "./format.ts";

export type DemoFormat = "json" | "pretty" | "stream";

export interface DemoOptions {
  readonly input: string;
  readonly supervisorFactory: SupervisorFactory;
  readonly format: DemoFormat;
  readonly storeDir: string;
  readonly timeoutMs: number;
  /**
   * Optional per-event sink invoked as each event arrives with the formatted
   * line. Tests omit this to collect events silently.
   */
  readonly onEvent?: (event: BridgeEvent, formatted: string) => void;
  /** Optional formatter override; defaults to the format-driven choice. */
  readonly formatter?: Formatter;
}

export interface DemoResult {
  readonly sessionId: string;
  readonly events: readonly BridgeEvent[];
}

class DemoTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`demo timed out after ${timeoutMs}ms`);
    this.name = "DemoTimeoutError";
  }
}

function pickFormatter(format: DemoFormat): Formatter {
  if (format === "pretty") return formatPretty;
  return formatJson;
}

export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const formatter = opts.formatter ?? pickFormatter(opts.format);
  const bridge = new Bridge({
    storeDir: opts.storeDir,
    supervisorFactory: opts.supervisorFactory,
  });

  const handle = await bridge.startSession({});
  const sessionId = handle.id;

  // Surface session.started immediately; live subscription begins on the
  // next tick and would otherwise miss the head of the lifecycle.
  const startedEvent: BridgeEvent = { type: "session.started", sessionId };
  opts.onEvent?.(startedEvent, formatter(startedEvent));

  const subscription = bridge.events(sessionId);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DemoTimeoutError(opts.timeoutMs));
    }, opts.timeoutMs);
    timer.unref?.();
  });

  const collect = (async () => {
    for await (const ev of subscription) {
      opts.onEvent?.(ev, formatter(ev));
      if (ev.type === "agent.reply" && ev.final) {
        break;
      }
    }
  })();

  try {
    await bridge.sendMessage(sessionId, opts.input);
    await Promise.race([collect, timeoutPromise]);
  } catch (err) {
    await bridge.close(sessionId).catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  await bridge.close(sessionId);

  // session.ended is appended during close; surface it for stream mode and
  // include it in the returned event list.
  const endedEvent: BridgeEvent = { type: "session.ended", sessionId };
  opts.onEvent?.(endedEvent, formatter(endedEvent));

  // Pull the authoritative ordered record from JSONL so the returned list
  // reflects the full lifecycle.
  const stored = await bridge.readStoredEvents(sessionId);
  return { sessionId, events: stored };
}
