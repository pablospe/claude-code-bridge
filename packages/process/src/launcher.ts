/**
 * node-pty launcher. Exists as the only file in the workspace that imports
 * `node-pty` — a native module that may fail to build on a host without a
 * C++ toolchain. Callers that hit that path get a typed
 * `LauncherUnavailableError` with a pointer at the manual fallback in
 * `docs/SMOKE.md`.
 */

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

export function launch(_command: string, _args: string[], _opts?: LaunchOpts): LauncherHandle {
  throw new Error("launch() not implemented yet");
}
