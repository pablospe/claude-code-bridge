/**
 * PTY launcher. This is the only file in the workspace that imports the
 * native PTY module — `@homebridge/node-pty-prebuilt-multiarch`, a community
 * fork of node-pty that ships prebuilt binaries for darwin, win32, and linux
 * (including linux-x64 / linux-arm64) so loading does not require a C++
 * toolchain on the host. The module may still fail to load if the prebuilt
 * binary's NAPI ABI is incompatible with the running runtime; callers that
 * hit that path get a typed `LauncherUnavailableError` with a pointer at
 * `docs/SMOKE.md`'s manual fallback.
 */

import { createRequire } from "node:module";

/** Public error type for the node-pty-unavailable path. */
export class LauncherUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "node-pty failed to load; managed launch is unavailable. " +
        "See docs/SMOKE.md (Advanced fallback) for the manual three-terminal procedure. " +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "LauncherUnavailableError";
    this.cause = cause;
  }
}

export interface LaunchOpts {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface KillOpts {
  /**
   * Bytes written to the child's PTY during the graceful step. The launcher
   * does not assume a specific application — callers pass the right keystroke
   * for their target child (e.g. `"exit\n"` for bash, `"/exit\n"` for claude).
   */
  gracefulInput?: string;
}

export interface LauncherHandle {
  readonly pid: number;
  write(data: string): void;
  kill(mode: "graceful" | "signal", opts?: KillOpts): Promise<void>;
  /**
   * Deliver a single POSIX signal to the child without escalation. Used by
   * supervisors that need a Ctrl-C analog ("SIGINT") distinct from the
   * SIGTERM-first behavior of `kill("signal")`. No-op after exit.
   */
  sendSignal(signal: NodeJS.Signals): void;
  waitExit(): Promise<{ code: number; signal?: string }>;
  onData(cb: (chunk: string) => void): () => void;
  onExit(cb: (exit: { code: number; signal?: string }) => void): () => void;
}

/**
 * Minimal slice of node-pty's IPty surface the launcher relies on. Captured as
 * a local interface so the only place we depend on node-pty's typings is
 * inside `loadNodePty()`.
 */
interface PtyTerminal {
  readonly pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(cb: (chunk: string) => void): { dispose: () => void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose: () => void };
}

interface PtyModule {
  spawn(
    command: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; cols?: number; rows?: number },
  ): PtyTerminal;
}

/**
 * Kill-ladder timings, fixed per M2.md §1. Total budget 5s = 1s + 1.5s + 1.5s
 * (bounded waits) + 1s of slack to absorb signal-delivery latency. Not
 * configurable: the supervisor caller has a hard 5s teardown budget that
 * matches these numbers.
 */
const GRACEFUL_WAIT_MS = 1_000;
const SIGINT_WAIT_MS = 1_500;
const SIGTERM_WAIT_MS = 1_500;

/**
 * `term.kill(signal)` may throw if the child has raced us to exit. The kill
 * ladder treats every escalation as best-effort: a swallowed throw means the
 * next `waitForExit` either observes the existing exit (returns true) or
 * times out and the ladder steps forward.
 */
function safeKill(term: PtyTerminal, signal: string): void {
  try {
    term.kill(signal);
  } catch {
    /* swallow: see safeKill doc comment. */
  }
}

// Bun exposes `require` in ESM transparently; Node ESM does not. Build a
// CJS-compatible require bound to this module's URL so the same `launch()`
// implementation works under both runtimes. Top-level so the module load
// itself surfaces a problem (rather than the first `launch()` call).
const _require = createRequire(import.meta.url);

function loadNodePty(): PtyModule {
  try {
    return _require("@homebridge/node-pty-prebuilt-multiarch") as PtyModule;
  } catch (err) {
    throw new LauncherUnavailableError(err);
  }
}

export function launch(command: string, args: string[], opts?: LaunchOpts): LauncherHandle {
  const pty = loadNodePty();
  let term: PtyTerminal;
  try {
    term = pty.spawn(command, args, {
      cwd: opts?.cwd,
      env: opts?.env,
      cols: opts?.cols ?? 80,
      rows: opts?.rows ?? 24,
    });
  } catch (err) {
    throw new LauncherUnavailableError(err);
  }

  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(e: { code: number; signal?: string }) => void>();
  let exit: { code: number; signal?: string } | undefined;
  const exitWaiters: Array<(e: { code: number; signal?: string }) => void> = [];
  /**
   * In-flight kill ladder. Concurrent `kill()` callers share this promise so
   * the escalation ladder runs exactly once; without it each caller would
   * walk the ladder independently and re-fire signals at each step.
   */
  let killPromise: Promise<void> | undefined;

  term.onData((chunk) => {
    for (const cb of dataListeners) cb(chunk);
  });
  term.onExit((e) => {
    exit = {
      code: e.exitCode,
      signal: e.signal !== undefined && e.signal !== null ? String(e.signal) : undefined,
    };
    for (const cb of exitListeners) cb(exit);
    for (const w of exitWaiters.splice(0)) w(exit);
  });

  /**
   * Resolves true if the child exits within `timeoutMs`, false on timeout.
   * Local helper used by each step of the kill ladder; consumes one slot in
   * `exitWaiters` per call and cleans up that slot on timeout so a late exit
   * does not try to resolve a dropped promise.
   */
  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    if (exit) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      exitWaiters.push(onExit);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const idx = exitWaiters.indexOf(onExit);
        if (idx >= 0) exitWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
  };

  const runKill = async (
    mode: "graceful" | "signal",
    killOpts: KillOpts | undefined,
  ): Promise<void> => {
    if (exit) return;
    if (mode === "signal") {
      // Single-signal teardown: SIGTERM, then SIGKILL if SIGTERM is ignored
      // within the standard 1.5s window. Caller did not opt into the
      // graceful-input step, so no bytes are written to the PTY.
      safeKill(term, "SIGTERM");
      if (await waitForExit(SIGTERM_WAIT_MS)) return;
      safeKill(term, "SIGKILL");
      return;
    }
    // Graceful ladder: gracefulInput → 1s wait → SIGINT (1.5s) → SIGTERM
    // (1.5s) → SIGKILL. Total of 4s of bounded waits within the 5s budget
    // the supervisor allots for teardown; the 1s slack absorbs the kernel
    // delivering the final signal and the child emitting its exit event.
    const gracefulInput = killOpts?.gracefulInput;
    if (gracefulInput !== undefined && gracefulInput.length > 0) {
      try {
        term.write(gracefulInput);
      } catch {
        /* swallow: child may have raced us to closed stdin. */
      }
    }
    if (await waitForExit(GRACEFUL_WAIT_MS)) return;
    safeKill(term, "SIGINT");
    if (await waitForExit(SIGINT_WAIT_MS)) return;
    safeKill(term, "SIGTERM");
    if (await waitForExit(SIGTERM_WAIT_MS)) return;
    safeKill(term, "SIGKILL");
  };

  const handle: LauncherHandle = {
    get pid() {
      return term.pid;
    },
    write(data) {
      if (exit) return;
      term.write(data);
    },
    sendSignal(signal) {
      if (exit) return;
      safeKill(term, signal);
    },
    onData(cb) {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onExit(cb) {
      if (exit) {
        cb(exit);
        return () => undefined;
      }
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
    waitExit() {
      if (exit) return Promise.resolve(exit);
      return new Promise((resolve) => {
        exitWaiters.push(resolve);
      });
    },
    kill(mode, killOpts) {
      if (exit) return Promise.resolve();
      // Share the in-flight ladder with concurrent callers so each escalation
      // step fires exactly once. The cached promise is retained for the
      // lifetime of the handle; after exit, the early-return above short-
      // circuits before this point.
      if (killPromise) return killPromise;
      killPromise = runKill(mode, killOpts);
      return killPromise;
    },
  };

  return handle;
}
