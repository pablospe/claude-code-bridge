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
  hello: (sessionId: string, ack: () => void) => void;
  tool: (sessionId: string, name: string, args: Record<string, unknown>, ack: () => void) => void;
}

/**
 * Loopback TCP control server. Accepts one connection per session.
 * Speaks JSON-lines over a single TCP connection.
 */
export class ControlServer {
  readonly #emitter = new EventEmitter();
  readonly #sessionSockets = new Map<string, Socket>();
  #server: NetServer | undefined;

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
      throw new Error("ControlServer: failed to determine bound address");
    }
    return {
      host: address.address,
      port: address.port,
      endpoint: `${address.address}:${address.port}`,
    };
  }

  async deliver(sessionId: string, content: string, opts: DeliverWireOptions = {}): Promise<void> {
    const socket = this.#sessionSockets.get(sessionId);
    if (!socket) {
      throw new Error(`ControlServer.deliver: no connected client for session ${sessionId}`);
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
    for (const socket of this.#sessionSockets.values()) {
      try {
        await writeLine(socket, { type: "close" });
      } catch {
        // best effort
      }
      socket.destroy();
    }
    this.#sessionSockets.clear();
    const server = this.#server;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.#server = undefined;
  }

  #handleSocket(socket: Socket): void {
    let sessionId: string | undefined;
    readLines(socket, (msg) => {
      if (msg.type === "hello") {
        sessionId = msg.sessionId;
        this.#sessionSockets.set(sessionId, socket);
        const ack = (): void => {
          writeLine(socket, { type: "hello_ack" }).catch(() => {
            // best effort
          });
        };
        this.#emitter.emit("hello", sessionId, ack);
        ack();
        return;
      }
      if (msg.type === "tool") {
        if (!sessionId) return;
        const ack = (): void => {
          // No application-level ack for tool messages in M1.
        };
        this.#emitter.emit("tool", sessionId, msg.name, msg.args, ack);
        return;
      }
      if (msg.type === "close") {
        socket.end();
        return;
      }
      // Ignore unrecognized envelopes.
    });
    socket.on("close", () => {
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
}

/**
 * Loopback TCP control client. Connects to a ControlServer endpoint and
 * exchanges JSON-lines messages.
 */
export class ControlClient {
  readonly #endpoint: string;
  readonly #sessionId: string;
  readonly #onDeliver: ControlClientOptions["onDeliver"];
  #socket: Socket | undefined;

  constructor(opts: ControlClientOptions) {
    this.#endpoint = opts.endpoint;
    this.#sessionId = opts.sessionId;
    this.#onDeliver = opts.onDeliver;
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
    readLines(socket, async (msg) => {
      if (msg.type === "deliver") {
        const opts: DeliverWireOptions = {
          ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
          ...(msg.meta !== undefined ? { meta: msg.meta } : {}),
        };
        try {
          await this.#onDeliver(msg.content, opts);
        } catch {
          // Errors in delivery callbacks are swallowed in M1.
        }
        return;
      }
      if (msg.type === "close") {
        socket.end();
        return;
      }
      // hello_ack and others are accepted but not surfaced in M1.
    });
    socket.on("error", () => {
      // Suppress; the consumer can rely on close() / connection errors via connect().
    });
    await writeLine(socket, { type: "hello", sessionId: this.#sessionId });
  }

  async sendTool(name: string, args: Record<string, unknown>): Promise<void> {
    const socket = this.#socket;
    if (!socket) {
      throw new Error("ControlClient.sendTool: not connected");
    }
    await writeLine(socket, { type: "tool", name, args });
  }

  async close(): Promise<void> {
    const socket = this.#socket;
    if (!socket) return;
    this.#socket = undefined;
    try {
      await writeLine(socket, { type: "close" });
    } catch {
      // best effort
    }
    await new Promise<void>((resolve) => {
      socket.end(() => resolve());
    });
  }
}

function parseEndpoint(endpoint: string): { host: string; port: number } {
  const idx = endpoint.lastIndexOf(":");
  if (idx <= 0 || idx === endpoint.length - 1) {
    throw new Error(`ControlClient: invalid endpoint ${endpoint}`);
  }
  const host = endpoint.slice(0, idx);
  const port = Number(endpoint.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`ControlClient: invalid endpoint ${endpoint}`);
  }
  return { host, port };
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
 * Read newline-delimited JSON messages from a socket. The remainder between
 * data chunks is buffered until a newline arrives.
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
