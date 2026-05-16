import { EventEmitter } from "node:events";
import {
  type AddressInfo,
  createConnection,
  createServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import * as z from "zod/v4";

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
}

export interface ControlServerEvents {
  hello: (sessionId: string) => void;
  tool: (sessionId: string, name: string, args: Record<string, unknown>) => void;
}

const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 1_000;

/**
 * Loopback TCP control server. Accepts one connection per session.
 * Speaks JSON-lines over a single TCP connection.
 */
export class ControlServer {
  readonly #emitter = new EventEmitter();
  readonly #sessionSockets = new Map<string, Socket>();
  readonly #sockets = new Set<Socket>();
  #server: NetServer | undefined;
  #helloTimeoutMs: number = DEFAULT_HELLO_TIMEOUT_MS;

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
    const socket = this.#sessionSockets.get(sessionId);
    if (!socket) {
      throw new Error(`no connected client for session ${sessionId}`);
    }
    const msg: DeliverMessage = {
      type: "deliver",
      content,
      ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
      ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
    };
    await writeLine(socket, msg);
  }

  async close(): Promise<void> {
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
    readLines(socket, (msg) => {
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
        this.#emitter.emit("hello", sessionId);
        writeLine(socket, { type: "hello_ack" }).catch(() => {
          // best effort
        });
        return;
      }
      if (msg.type === "tool") {
        if (!sessionId) {
          socket.destroy(new Error("tool before hello"));
          return;
        }
        this.#emitter.emit("tool", sessionId, msg.name, msg.args);
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
    await writeLine(socket, { type: "tool", name, args });
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
  if (!Number.isInteger(port) || port <= 0) {
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
 * Bounded writeLine: rejects after timeoutMs if the underlying write callback
 * never fires. Used during shutdown paths to avoid hanging on wedged peers.
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
      reject(new Error("control: writeLine timeout"));
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
 * data chunks is buffered until a newline arrives.
 */
function readLines(socket: Socket, onMessage: (msg: ControlMessage) => void | Promise<void>): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME_BYTES) {
      socket.destroy(new Error("control: frame exceeds max size"));
      buffer = "";
      return;
    }
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
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
  });
}
