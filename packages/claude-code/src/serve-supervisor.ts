import {
  dispatchBridgeTool,
  emitChannelDisconnectEvents,
  HookFanin,
  type Supervisor,
  type SupervisorContext,
} from "@ccb/core";
import { ControlServer } from "@ccb/mcp-channel";

export type ChannelStatus = "connected" | "disconnected";

/**
 * Supervisor that hosts a real ControlServer for an external channel server
 * (typically the ccb-channel-server spawned by `claude`). It does not spawn
 * `claude` itself; the human (or scripts/smoke-manual.sh) is responsible for
 * launching the claude process and pointing it at this endpoint.
 */
export class ServeSupervisor implements Supervisor {
  readonly #host: string;
  readonly #port: number;
  readonly #wireSessionId: string;
  readonly #onListening: (info: { host: string; port: number; endpoint: string }) => void;
  readonly #onChannelStatus: ((status: ChannelStatus, sessionId: string) => void) | undefined;
  #server: ControlServer | undefined;
  #ctx: SupervisorContext | undefined;
  #hookFanin: HookFanin | undefined;

  constructor(
    host: string,
    port: number,
    wireSessionId: string,
    onListening: (info: { host: string; port: number; endpoint: string }) => void,
    onChannelStatus?: (status: ChannelStatus, sessionId: string) => void,
  ) {
    this.#host = host;
    this.#port = port;
    this.#wireSessionId = wireSessionId;
    this.#onListening = onListening;
    this.#onChannelStatus = onChannelStatus;
  }

  async start(ctx: SupervisorContext): Promise<void> {
    if (this.#server) throw new Error("supervisor already started");
    this.#ctx = ctx;
    const wireId = this.#wireSessionId;
    const server = new ControlServer();
    this.#hookFanin = new HookFanin(ctx);
    try {
      const info = await server.listen({ host: this.#host, port: this.#port });
      this.#server = server;
      server.on("tool", (sid, name, args) => {
        if (sid !== wireId) return;
        this.#dispatchTool(name, args);
      });
      server.on("hook", (sid, event, payload) => {
        if (sid !== wireId) return;
        this.#hookFanin?.onHook(event, payload);
      });
      server.on("hello", (sid) => {
        if (sid !== wireId) return;
        this.#hookFanin?.onHello();
        this.#onChannelStatus?.("connected", sid);
      });
      server.on("peer-close", (sid) => {
        if (sid !== wireId) return;
        this.#hookFanin?.onPeerClose();
        this.#onChannelStatus?.("disconnected", sid);
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
    this.#hookFanin = undefined;
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
   * Channel-server peer dropped its TCP control connection. This supervisor
   * does not own the claude process; it only sees the TCP peer close, which is
   * usually a clean exit, not a crash. Synthesize the neutral channel-disconnect
   * pair so the bridge transitions the session out of "open" and live consumers
   * see the disconnect without claiming a crash.
   */
  #handlePeerClose(): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    emitChannelDisconnectEvents(ctx);
  }
}
