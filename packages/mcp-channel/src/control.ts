import { EventEmitter } from "node:events";
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import * as z from "zod/v4";
import { validateWireMeta } from "./meta-validation.ts";

const HelloMessageSchema = z.object({
  type: z.literal("hello"),
  sessionId: z.string(),
});
const HelloAckMessageSchema = z.object({
  type: z.literal("hello_ack"),
});
const DeliverMessageSchema = z.object({
  type: z.literal("deliver"),
  content: z.string(),
  messageId: z.string().optional(),
  meta: z.record(z.string(), z.string()).optional(),
});
const ToolMessageSchema = z.object({
  type: z.literal("tool"),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});
const CloseMessageSchema = z.object({
  type: z.literal("close"),
});

const ControlMessageSchema = z.discriminatedUnion("type", [
  HelloMessageSchema,
  HelloAckMessageSchema,
  DeliverMessageSchema,
  ToolMessageSchema,
  CloseMessageSchema,
]);

type DeliverMessage = z.infer<typeof DeliverMessageSchema>;
type ControlMessage = z.infer<typeof ControlMessageSchema>;

export interface ControlServerListenOptions {
  readonly host?: string;
  readonly port?: number;
  readonly helloTimeoutMs?: number;
}

export interface ControlServerEndpoint {
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
}

export interface DeliverWireOptions {
  readonly messageId?: string;
  readonly meta?: Record<string, string>;
  /**
   * When `deliver()` is called for a session whose control socket has not yet
   * arrived (channel server is still booting, hello not seen), block on the
   * `hello` event for this session up to `deliverWaitMs` before failing. Zero
   * disables the wait. On timeout, the same `"no connected client for session
   * <id>"` error is thrown that today's deliver throws, so callers don't need
   * to handle a new error type.
   */
  readonly deliverWaitMs?: number;
}

export interface ControlServerEvents {
  hello: (sessionId: string) => void;
  tool: (sessionId: string, name: string, args: Record<string, unknown>) => void;
  /**
   * Per-session peer socket closed. Fires once per session, after a successful
   * hello, when the remote end of the control connection goes away
   * (channel-server crash, network drop). Does NOT fire during the cooperative
   * close path driven by ControlServer.close().
   */
  "peer-close": (sessionId: string) => void;
}

const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 1_000;
const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
/**
 * How long `deliver()` waits for the channel server's `hello` to arrive when
 * the per-session socket is not yet registered. Matches `Bridge.startTimeoutMs`
 * (the default upper bound on session startup), so a deliver fired immediately
 * after `startSession` resolves has up to a full startup window to land.
 */
const DEFAULT_DELIVER_WAIT_MS = 30_000;

/**
 * Per-call lookup so tests can flip the env between calls. Falls back to the
 * default when the value is missing or unparseable.
 */
function writeTimeoutMs(): number {
  const raw = process.env.CCB_WRITE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_WRITE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WRITE_TIMEOUT_MS;
}

/**
 * Loopback TCP control server. Accepts one connection per session.
 * Speaks JSON-lines over a single TCP connection.
 */
export class ControlServer {
  readonly #emitter = new EventEmitter();
  readonly #sessionSockets = new Map<string, Socket>();
  readonly #sockets = new Set<Socket>();
  /**
   * Reject callbacks for in-flight `#waitForSessionSocket` callers. Indexed by
   * an opaque counter so cleanup is O(1) without scanning. Used by `close()`
   * to fail pending waiters fast instead of letting the shutdown hang for the
   * caller's `deliverWaitMs`.
   */
  readonly #pendingWaiters = new Map<number, (err: Error) => void>();
  #nextWaiterId = 0;
  #server: NetServer | undefined;
  #helloTimeoutMs: number = DEFAULT_HELLO_TIMEOUT_MS;
  #closing = false;

  on<E extends keyof ControlServerEvents>(event: E, listener: ControlServerEvents[E]): this {
    this.#emitter.on(event, listener);
    return this;
  }

  off<E extends keyof ControlServerEvents>(event: E, listener: ControlServerEvents[E]): this {
    this.#emitter.off(event, listener);
    return this;
  }

  async listen(opts: ControlServerListenOptions = {}): Promise<ControlServerEndpoint> {
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 0;
    this.#helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    const server = createServer((socket) => this.#handleSocket(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === "string") {
      throw new Error("failed to determine bound address");
    }
    return {
      host: address.address,
      port: address.port,
      endpoint: formatEndpoint(address.address, address.port),
    };
  }

  async deliver(sessionId: string, content: string, opts: DeliverWireOptions = {}): Promise<void> {
    let socket = this.#sessionSockets.get(sessionId);
    if (!socket) {
      const waitMs = opts.deliverWaitMs ?? DEFAULT_DELIVER_WAIT_MS;
      socket = await this.#waitForSessionSocket(sessionId, waitMs);
    }
    const meta = opts.meta !== undefined ? validateWireMeta(opts.meta) : undefined;
    const msg: DeliverMessage = {
      type: "deliver",
      content,
      ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
      ...(meta !== undefined ? { meta } : {}),
    };
    await writeLineNormal(socket, msg, writeTimeoutMs());
  }

  /**
   * Block until the per-session socket is registered (via a matching `hello`)
   * or `timeoutMs` elapses. On timeout, throws the same error message that
   * deliver throws today when the socket is missing, so callers do not have to
   * learn a new error type. If `close()` runs while a wait is pending, the
   * waiter rejects cleanly instead of hanging.
   */
  #waitForSessionSocket(sessionId: string, timeoutMs: number): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      if (this.#closing) {
        reject(new Error(`no connected client for session ${sessionId}`));
        return;
      }
      const waiterId = this.#nextWaiterId++;
      let settled = false;
      const cleanup = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#emitter.off("hello", onHello);
        this.#pendingWaiters.delete(waiterId);
      };
      const onHello = (sid: string): void => {
        if (sid !== sessionId) return;
        const sock = this.#sessionSockets.get(sessionId);
        if (!sock) return;
        cleanup();
        resolve(sock);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`no connected client for session ${sessionId}`));
      }, timeoutMs);
      timer.unref?.();
      this.#pendingWaiters.set(waiterId, (err) => {
        cleanup();
        reject(err);
      });
      this.#emitter.on("hello", onHello);
    });
  }

  async close(): Promise<void> {
    this.#closing = true;
    // Fail any in-flight deliver waiters before tearing down sockets so they
    // don't hang the caller's `deliverWaitMs`.
    const waiters = [...this.#pendingWaiters.values()];
    this.#pendingWaiters.clear();
    for (const rejectWaiter of waiters) {
      try {
        rejectWaiter(new Error("control server closing"));
      } catch {
        // best effort
      }
    }
    const sockets = [...this.#sockets];
    await Promise.allSettled(
      sockets.map(async (socket) => {
        try {
          await writeLineWithTimeout(socket, { type: "close" }, SHUTDOWN_TIMEOUT_MS);
        } catch {
          // best effort
        }
        socket.destroy();
      }),
    );
    this.#sockets.clear();
    this.#sessionSockets.clear();
    const server = this.#server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.#server = undefined;
  }

  #handleSocket(socket: Socket): void {
    this.#sockets.add(socket);
    let sessionId: string | undefined;
    const helloTimer = setTimeout(() => {
      if (!sessionId) {
        socket.destroy(new Error("hello timeout"));
      }
    }, this.#helloTimeoutMs);
    helloTimer.unref?.();
    readLines(socket, async (msg) => {
      if (msg.type === "hello") {
        if (sessionId) {
          // Already greeted on this socket.
          socket.destroy(new Error("duplicate hello on socket"));
          return;
        }
        if (this.#sessionSockets.has(msg.sessionId)) {
          socket.destroy(new Error(`duplicate session id: ${msg.sessionId}`));
          return;
        }
        sessionId = msg.sessionId;
        clearTimeout(helloTimer);
        this.#sessionSockets.set(sessionId, socket);
        // Write hello_ack BEFORE emitting the hello event so any synchronous
        // deliver() call from a listener cannot race ahead of the ack on the
        // wire.
        try {
          await writeLine(socket, { type: "hello_ack" });
        } catch {
          // best effort
        }
        try {
          this.#emitter.emit("hello", sessionId);
        } catch (err) {
          console.error(`control: hello listener threw: ${String(err)}`);
        }
        return;
      }
      if (msg.type === "tool") {
        if (!sessionId) {
          socket.destroy(new Error("tool before hello"));
          return;
        }
        try {
          this.#emitter.emit("tool", sessionId, msg.name, msg.args);
        } catch (err) {
          console.error(`control: tool listener threw: ${String(err)}`);
        }
        return;
      }
      if (msg.type === "close") {
        socket.end();
        return;
      }
      // Ignore unrecognized envelopes.
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.#sockets.delete(socket);
      if (sessionId && this.#sessionSockets.get(sessionId) === socket) {
        this.#sessionSockets.delete(sessionId);
      }
      // Only signal peer-close after a successful hello and only when the
      // close was initiated by the peer (not by our cooperative shutdown).
      if (sessionId && !this.#closing) {
        try {
          this.#emitter.emit("peer-close", sessionId);
        } catch (err) {
          console.error(`control: peer-close listener threw: ${String(err)}`);
        }
      }
    });
    socket.on("error", () => {
      // Suppress; close handler will fire next.
    });
  }
}

export interface ControlClientOptions {
  readonly endpoint: string;
  readonly sessionId: string;
  readonly onDeliver: (content: string, opts: DeliverWireOptions) => void | Promise<void>;
  readonly helloAckTimeoutMs?: number;
  readonly onConnectionLost?: (err?: Error) => void;
}

const DEFAULT_HELLO_ACK_TIMEOUT_MS = 5_000;

/**
 * Loopback TCP control client. Connects to a ControlServer endpoint and
 * exchanges JSON-lines messages.
 */
export class ControlClient {
  readonly #endpoint: string;
  readonly #sessionId: string;
  readonly #onDeliver: ControlClientOptions["onDeliver"];
  readonly #helloAckTimeoutMs: number;
  readonly #onConnectionLost: ControlClientOptions["onConnectionLost"];
  #socket: Socket | undefined;
  #connected = false;
  #closing = false;
  #lostEmitted = false;

  constructor(opts: ControlClientOptions) {
    this.#endpoint = opts.endpoint;
    this.#sessionId = opts.sessionId;
    this.#onDeliver = opts.onDeliver;
    this.#helloAckTimeoutMs = opts.helloAckTimeoutMs ?? DEFAULT_HELLO_ACK_TIMEOUT_MS;
    this.#onConnectionLost = opts.onConnectionLost;
  }

  async connect(): Promise<void> {
    const { host, port } = parseEndpoint(this.#endpoint);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection({ host, port }, () => {
        s.off("error", reject);
        resolve(s);
      });
      s.once("error", reject);
    });
    this.#socket = socket;

    let ackResolve!: () => void;
    let ackReject!: (err: Error) => void;
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    const ackPromise = new Promise<void>((resolve, reject) => {
      ackResolve = resolve;
      ackReject = reject;
    });

    readLines(socket, async (msg) => {
      if (msg.type === "hello_ack") {
        ackResolve();
        return;
      }
      if (msg.type === "deliver") {
        const opts: DeliverWireOptions = {
          ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
          ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
        };
        try {
          await this.#onDeliver(msg.content, opts);
        } catch (err) {
          console.error(`control: onDeliver threw: ${String(err)}`);
        }
        return;
      }
      if (msg.type === "close") {
        socket.end();
        return;
      }
    });

    socket.on("error", (err) => {
      if (!this.#connected) {
        if (ackTimer) clearTimeout(ackTimer);
        ackReject(err ?? new Error("connection closed before hello_ack"));
        this.#socket = undefined;
        return;
      }
      if (!this.#lostEmitted && !this.#closing) {
        this.#lostEmitted = true;
        this.#socket = undefined;
        this.#onConnectionLost?.(err);
      }
    });
    socket.on("close", () => {
      if (!this.#connected) {
        if (ackTimer) clearTimeout(ackTimer);
        ackReject(new Error("connection closed before hello_ack"));
        this.#socket = undefined;
        return;
      }
      if (!this.#lostEmitted && !this.#closing) {
        this.#lostEmitted = true;
        this.#socket = undefined;
        this.#onConnectionLost?.();
      }
    });

    try {
      await writeLine(socket, { type: "hello", sessionId: this.#sessionId });

      ackTimer = setTimeout(() => {
        socket.destroy();
        ackReject(new Error("hello_ack timeout"));
      }, this.#helloAckTimeoutMs);
      ackTimer.unref?.();
      try {
        await ackPromise;
      } finally {
        if (ackTimer) clearTimeout(ackTimer);
      }
      this.#connected = true;
    } catch (err) {
      this.#socket = undefined;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      throw err;
    }
  }

  async sendTool(name: string, args: Record<string, unknown>): Promise<void> {
    const socket = this.#socket;
    if (!socket) {
      throw new Error("not connected");
    }
    await writeLineNormal(socket, { type: "tool", name, args }, writeTimeoutMs());
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    this.#closing = true;
    this.#socket = undefined;
    if (!socket || socket.destroyed) return;
    try {
      await writeLineWithTimeout(socket, { type: "close" }, SHUTDOWN_TIMEOUT_MS);
    } catch {
      // best effort
    }
    await endSocketWithTimeout(socket, SHUTDOWN_TIMEOUT_MS);
  }
}

export function parseEndpoint(endpoint: string): { host: string; port: number } {
  let host: string;
  let portStr: string;
  if (endpoint.startsWith("[")) {
    const closeIdx = endpoint.indexOf("]");
    if (closeIdx < 0 || endpoint[closeIdx + 1] !== ":") {
      throw new Error(`invalid endpoint ${endpoint}`);
    }
    host = endpoint.slice(1, closeIdx);
    portStr = endpoint.slice(closeIdx + 2);
  } else {
    const idx = endpoint.lastIndexOf(":");
    if (idx <= 0 || idx === endpoint.length - 1) {
      throw new Error(`invalid endpoint ${endpoint}`);
    }
    host = endpoint.slice(0, idx);
    portStr = endpoint.slice(idx + 1);
  }
  if (portStr.length === 0) {
    throw new Error(`invalid endpoint ${endpoint}`);
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid endpoint ${endpoint}`);
  }
  return { host, port };
}

function formatEndpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function writeLine(socket: Socket, msg: ControlMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(msg)}\n`, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Bounded writeLine for shutdown paths: rejects after timeoutMs if the write
 * callback never fires and destroys the socket so subsequent writes fail fast.
 * Reserved for cooperative shutdown where keeping the socket alive after a
 * stuck write has no value.
 */
function writeLineWithTimeout(
  socket: Socket,
  msg: ControlMessage,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy(new Error("control: write timeout"));
      } catch {
        // ignore destroy errors
      }
      reject(new Error("control: write timeout"));
    }, timeoutMs);
    timer.unref?.();
    socket.write(`${JSON.stringify(msg)}\n`, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Bounded writeLine for normal-path writes (deliver, sendTool). Rejects after
 * timeoutMs but leaves the socket alive so a transient stall does not tear
 * down the whole session for one slow write. Callers handle the rejection.
 */
function writeLineNormal(socket: Socket, msg: ControlMessage, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("control: write timeout"));
    }, timeoutMs);
    timer.unref?.();
    socket.write(`${JSON.stringify(msg)}\n`, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Bounded socket.end: resolves after the local FIN callback fires or after
 * timeoutMs (whichever first). On timeout, destroys the socket.
 */
function endSocketWithTimeout(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve();
    }, timeoutMs);
    timer.unref?.();
    try {
      socket.end(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    } catch {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    }
  });
}

/**
 * Read newline-delimited JSON messages from a socket. The remainder between
 * data chunks is buffered until a newline arrives. Each completed line is
 * size-checked individually against MAX_FRAME_BYTES; the residual partial
 * line is also checked to prevent unbounded growth.
 */
function readLines(socket: Socket, onMessage: (msg: ControlMessage) => void | Promise<void>): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > MAX_FRAME_BYTES) {
        socket.destroy(new Error("control: frame exceeds max size"));
        buffer = "";
        return;
      }
      if (line.length > 0) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch (err) {
          console.error(`control: malformed json line: ${String(err)}`);
          newlineIndex = buffer.indexOf("\n");
          continue;
        }
        const parsed = ControlMessageSchema.safeParse(value);
        if (!parsed.success) {
          console.error(`control: invalid control message: ${parsed.error.message}`);
        } else {
          void onMessage(parsed.data);
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_FRAME_BYTES) {
      socket.destroy(new Error("control: frame exceeds max size"));
      buffer = "";
    }
  });
}
