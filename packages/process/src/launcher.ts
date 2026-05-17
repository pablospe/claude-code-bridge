/**
 * node-pty launcher. This is the only file in the workspace that imports
 * `node-pty` — a native module that may fail to load at runtime if the
 * prebuilt binary is missing or built against an incompatible ABI. Callers
 * that hit that path get a typed `LauncherUnavailableError` with a pointer at
 * `docs/SMOKE.md`'s manual fallback.
 */

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

function loadNodePty(): PtyModule {
  try {
    // `require` (vs dynamic import) keeps `launch()` synchronous and surfaces
    // a native-load failure as a thrown error we can wrap. Bun and Node both
    // resolve `node-pty` from the package's own node_modules.
    return require("node-pty") as PtyModule;
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

  const handle: LauncherHandle = {
    get pid() {
      return term.pid;
    },
    write(data) {
      if (exit) return;
      term.write(data);
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
    async kill(_mode, _killOpts) {
      // Kill ladder lands in the next commit.
      throw new Error("kill() not implemented yet");
    },
  };

  return handle;
}
