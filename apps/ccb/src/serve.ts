import { join } from "node:path";
import {
  Bridge,
  type BridgeEvent,
  dispatchBridgeTool,
  emitCrashEvents,
  type Supervisor,
  type SupervisorContext,
} from "@ccb/core";
import { ControlServer } from "@ccb/mcp-channel";
import { formatJson, formatPretty } from "./format.ts";

export type ServeFormat = "json" | "pretty";

export interface ServeReadyInfo {
  readonly endpoint: string;
  readonly host: string;
  readonly port: number;
  readonly sessionId: string;
  /** Send a user message to the bridge; resolves to the assigned messageId. */
  readonly inject: (content: string) => Promise<string>;
}

export interface ServeOptions {
  /** host:port to bind. Use 127.0.0.1:0 for an ephemeral port. */
  readonly endpoint: string;
  readonly sessionId: string;
  readonly storeDir: string;
  readonly format: ServeFormat;
  /** Optional abort signal that triggers a clean shutdown. */
  readonly signal?: AbortSignal;
  /** Sink invoked for every bridge event; defaults to writing to stdout. */
  readonly onEvent?: (event: BridgeEvent) => void;
  /** Invoked once the control server is bound and the bridge has started. */
  readonly onReady?: (info: ServeReadyInfo) => void;
  /** Stdout writer override; defaults to process.stdout.write. */
  readonly stdout?: (line: string) => void;
  /** Stderr writer override; defaults to process.stderr.write. */
  readonly stderr?: (line: string) => void;
}

const ENDPOINT_PATTERN = /^[^\s:]+:\d+$/;

function parseEndpointSpec(spec: string): { host: string; port: number } {
  if (!ENDPOINT_PATTERN.test(spec)) {
    throw new Error(`invalid endpoint format: expected host:port, got ${spec}`);
  }
  const idx = spec.lastIndexOf(":");
  const host = spec.slice(0, idx);
  const port = Number(spec.slice(idx + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid endpoint port: ${spec}`);
  }
  return { host, port };
}

/**
 * Supervisor that hosts a real ControlServer for an external channel server
 * (typically the ccb-channel-server spawned by `claude`). It does not spawn
 * `claude` itself; the human (or scripts/smoke-manual.sh) is responsible for
 * launching the claude process and pointing it at this endpoint.
 */
class ServeSupervisor implements Supervisor {
  readonly #host: string;
  readonly #port: number;
  readonly #wireSessionId: string;
  readonly #onListening: (info: { host: string; port: number; endpoint: string }) => void;
  #server: ControlServer | undefined;
  #ctx: SupervisorContext | undefined;

  constructor(
    host: string,
    port: number,
    wireSessionId: string,
    onListening: (info: { host: string; port: number; endpoint: string }) => void,
  ) {
    this.#host = host;
    this.#port = port;
    this.#wireSessionId = wireSessionId;
    this.#onListening = onListening;
  }

  async start(ctx: SupervisorContext): Promise<void> {
    if (this.#server) throw new Error("supervisor already started");
    this.#ctx = ctx;
    const wireId = this.#wireSessionId;
    const server = new ControlServer();
    try {
      const info = await server.listen({ host: this.#host, port: this.#port });
      this.#server = server;
      server.on("tool", (sid, name, args) => {
        if (sid !== wireId) return;
        this.#dispatchTool(name, args);
      });
      server.on("peer-close", (sid) => {
        if (sid !== wireId) return;
        this.#handlePeerClose();
      });
      this.#onListening(info);
    } catch (err) {
      try {
        await server.close();
      } catch {
        // best effort
      }
      throw err;
    }
  }

  async sendMessage(sessionId: string, messageId: string, content: string): Promise<void> {
    const server = this.#server;
    if (!server) throw new Error("supervisor not started");
    if (sessionId !== this.#ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    await server.deliver(this.#wireSessionId, content, { messageId });
  }

  async interrupt(_sessionId: string): Promise<void> {
    // no-op
  }

  async close(_sessionId: string): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#ctx = undefined;
    if (!server) return;
    try {
      await server.close();
    } catch (err) {
      console.error(`ServeSupervisor: server close failed: ${String(err)}`);
    }
  }

  #dispatchTool(name: string, args: Record<string, unknown>): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    dispatchBridgeTool(ctx, name, args);
  }

  /**
   * Channel-server peer dropped its TCP control connection (crash, kill -9).
   * Synthesize the crash event pair so the bridge transitions the session
   * out of "open" and live consumers see the disconnect.
   */
  #handlePeerClose(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    emitCrashEvents(ctx);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Host a bridge instance for a manual real-claude smoke. Returns when the
 * abort signal fires (or never, until SIGINT). Tests pass `signal` to drive a
 * deterministic shutdown.
 */
export async function runServe(opts: ServeOptions): Promise<void> {
  if (!UUID_RE.test(opts.sessionId)) {
    throw new Error(`invalid sessionId: ${opts.sessionId}`);
  }
  const { host, port } = parseEndpointSpec(opts.endpoint);
  const stdoutWrite = opts.stdout ?? ((line) => process.stdout.write(line));
  const stderrWrite = opts.stderr ?? ((line) => process.stderr.write(line));
  const formatter = opts.format === "pretty" ? formatPretty : formatJson;

  const readyDeferred = Promise.withResolvers<{
    endpoint: string;
    host: string;
    port: number;
  }>();

  const supervisor = new ServeSupervisor(host, port, opts.sessionId, (info) => {
    readyDeferred.resolve(info);
  });

  const bridge = new Bridge({
    storeDir: opts.storeDir,
    supervisorFactory: () => supervisor,
  });

  let handleId: string | undefined;
  try {
    const handle = await bridge.startSession({});
    handleId = handle.id;
  } catch (err) {
    readyDeferred.promise.catch(() => undefined);
    throw err;
  }

  const sessionId = handleId;
  const bound = await readyDeferred.promise;

  const inject = async (content: string): Promise<string> => {
    return bridge.sendMessage(sessionId, content);
  };

  const eventSink = opts.onEvent;
  const writeEvent = (ev: BridgeEvent): void => {
    eventSink?.(ev);
    if (opts.stdout || !eventSink) {
      stdoutWrite(`${formatter(ev)}\n`);
    }
  };

  // Surface session.started immediately; live subscription starts on the next
  // tick and would otherwise miss the head of the lifecycle.
  writeEvent({ type: "session.started", sessionId });

  const readerDone = Promise.withResolvers<void>();
  (async () => {
    try {
      for await (const ev of bridge.events(sessionId)) {
        writeEvent(ev);
        if (ev.type === "session.ended") break;
      }
    } finally {
      readerDone.resolve();
    }
  })().catch(() => undefined);

  stderrWrite(
    `listening on ${bound.endpoint}; session_id=${opts.sessionId}; waiting for channel server to connect...\n`,
  );
  stderrWrite(`bridge_uuid: ${sessionId}\n`);
  stderrWrite(`jsonl: ${join(opts.storeDir, `${sessionId}.jsonl`)}\n`);

  opts.onReady?.({
    endpoint: bound.endpoint,
    host: bound.host,
    port: bound.port,
    sessionId: opts.sessionId,
    inject,
  });

  const stdinReader = startStdinReader(inject, stderrWrite);

  const shutdown = Promise.withResolvers<void>();
  const signal = opts.signal;
  const onAbort = (): void => {
    shutdown.resolve();
  };
  if (signal) {
    if (signal.aborted) {
      shutdown.resolve();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  const sigHandler = (): void => {
    shutdown.resolve();
  };
  if (!signal) {
    process.on("SIGINT", sigHandler);
    process.on("SIGTERM", sigHandler);
  }

  try {
    await shutdown.promise;
  } finally {
    stdinReader.stop();
    if (signal) signal.removeEventListener("abort", onAbort);
    if (!signal) {
      process.off("SIGINT", sigHandler);
      process.off("SIGTERM", sigHandler);
    }
    try {
      await bridge.close(sessionId);
    } catch (err) {
      stderrWrite(`ccb: bridge.close failed: ${String(err)}\n`);
    }
    await readerDone.promise;
  }
}

interface StdinReaderHandle {
  stop(): void;
}

function startStdinReader(
  inject: (content: string) => Promise<string>,
  stderrWrite: (line: string) => void,
): StdinReaderHandle {
  let stopped = false;
  let buffer = "";
  const onData = (chunk: Buffer | string): void => {
    if (stopped) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (line.length > 0) {
        inject(line).catch((err: unknown) => {
          stderrWrite(`ccb: inject failed: ${String(err)}\n`);
        });
      }
      nl = buffer.indexOf("\n");
    }
  };
  // Only attach when stdin is readable; avoid pinning the loop in tests where
  // stdin is "ignore"/already paused.
  const stdin = process.stdin;
  if (stdin && typeof stdin.on === "function" && stdin.readable) {
    stdin.on("data", onData);
  }
  return {
    stop(): void {
      stopped = true;
      if (stdin && typeof stdin.off === "function") {
        stdin.off("data", onData);
      }
    },
  };
}
