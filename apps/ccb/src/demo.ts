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

const CLEANUP_CLOSE_TIMEOUT_MS = 1_000;

function pickFormatter(format: DemoFormat): Formatter {
  if (format === "pretty") return formatPretty;
  return formatJson;
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.reject(new Error(`${label} timed out`));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out`));
    }, timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runDemo(opts: DemoOptions): Promise<DemoResult> {
  const formatter = opts.formatter ?? pickFormatter(opts.format);
  const bridge = new Bridge({
    storeDir: opts.storeDir,
    supervisorFactory: opts.supervisorFactory,
  });

  const handle = await bridge.startSession({});
  const sessionId = handle.id;

  const deadlineMs = Date.now() + opts.timeoutMs;
  const remaining = (): number => Math.max(0, deadlineMs - Date.now());

  // Surface session.started immediately; live subscription begins on the
  // next tick and would otherwise miss the head of the lifecycle.
  const startedEvent: BridgeEvent = { type: "session.started", sessionId };
  opts.onEvent?.(startedEvent, formatter(startedEvent));

  const subscription = bridge.events(sessionId);

  let closePromise: Promise<void> | undefined;
  const triggerClose = (): void => {
    if (closePromise !== undefined) return;
    closePromise = bridge.close(sessionId);
  };

  const collectP = (async () => {
    for await (const ev of subscription) {
      opts.onEvent?.(ev, formatter(ev));
      if (ev.type === "agent.reply" && ev.final) {
        triggerClose();
      }
      if (ev.type === "session.ended") {
        break;
      }
    }
  })();

  try {
    await bridge.sendMessage(sessionId, opts.input);
    await raceWithTimeout(collectP, remaining(), "demo").catch((err) => {
      if (err instanceof Error && err.message === "demo timed out") {
        throw new DemoTimeoutError(opts.timeoutMs);
      }
      throw err;
    });
  } catch (err) {
    triggerClose();
    await collectP.catch(() => undefined);
    const cleanupBudget = Math.min(CLEANUP_CLOSE_TIMEOUT_MS, Math.max(remaining(), 50));
    const cleanupClose = closePromise ?? bridge.close(sessionId);
    await raceWithTimeout(cleanupClose, cleanupBudget, "bridge.close cleanup").catch(
      (closeErr: unknown) => {
        const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
        process.stderr.write(`ccb: ${msg}\n`);
      },
    );
    throw err;
  }

  const closeBudget = Math.max(remaining(), 50);
  const closeWait = closePromise ?? bridge.close(sessionId);
  await raceWithTimeout(closeWait, closeBudget, "bridge.close").catch((closeErr: unknown) => {
    const msg = closeErr instanceof Error ? closeErr.message : String(closeErr);
    process.stderr.write(`ccb: ${msg}\n`);
  });

  // Pull the authoritative ordered record from JSONL so the returned list
  // reflects the full lifecycle.
  const stored = await bridge.readStoredEvents(sessionId);
  return { sessionId, events: stored };
}
