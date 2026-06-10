import {
  dispatchBridgeTool,
  emitCrashEvents,
  type Supervisor,
  type SupervisorContext,
  type SupervisorFactory,
} from "@ccb/core";
import {
  type ChannelServerHandle,
  ControlClient,
  ControlServer,
  createChannelServer,
} from "@ccb/mcp-channel";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

interface PendingMessage {
  readonly messageId: string | undefined;
  readonly content: string;
}

export class MockSupervisor implements Supervisor {
  #server: ControlServer | undefined;
  #client: ControlClient | undefined;
  #channel: ChannelServerHandle | undefined;
  #peer: Client | undefined;
  #ctx: SupervisorContext | undefined;
  #echoChain: Promise<void> = Promise.resolve();

  async start(ctx: SupervisorContext): Promise<void> {
    if (this.#server) throw new Error("supervisor already started");
    this.#ctx = ctx;
    const sessionId = ctx.sessionId;

    try {
      const server = new ControlServer();
      const endpoint = await server.listen({ host: "127.0.0.1", port: 0 });
      this.#server = server;

      server.on("tool", (sid, name, args) => {
        if (sid !== sessionId) return;
        this.#dispatchTool(name, args);
      });

      const channel = createChannelServer({
        sessionId,
        onTool: async (name, args) => {
          const client = this.#client;
          if (!client) throw new Error("control client not initialized");
          await client.sendTool(name, args);
        },
      });
      this.#channel = channel;

      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const peer = new Client({ name: "ccb-mock-peer", version: "0.0.1" });
      this.#peer = peer;

      const client = new ControlClient({
        endpoint: endpoint.endpoint,
        sessionId,
        onDeliver: async (content, opts) => {
          await channel.deliver(content, opts);
          this.#scheduleEcho({ messageId: opts.messageId, content });
        },
      });
      this.#client = client;

      await Promise.all([channel.server.connect(serverTransport), peer.connect(clientTransport)]);
      await client.connect();
    } catch (err) {
      await this.#teardown();
      throw err;
    }
  }

  async sendMessage(sessionId: string, messageId: string, content: string): Promise<void> {
    const server = this.#server;
    if (!server) throw new Error("supervisor not started");
    if (sessionId !== this.#ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    await server.deliver(sessionId, content, { messageId });
  }

  async interrupt(_sessionId: string): Promise<void> {
    // no-op for the mock supervisor
  }

  #clearCalls = 0;

  /** Number of clear() invocations. Test seam for pool/bridge tests. */
  get clearCalls(): number {
    return this.#clearCalls;
  }

  async clear(sessionId: string): Promise<void> {
    if (sessionId !== this.#ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    this.#clearCalls += 1;
  }

  /**
   * Test seam: synthesize the supervisor-crashed event pair through the bridge
   * exactly as ClaudeCodeSupervisor / ServeSupervisor would on a peer
   * disconnect. After this call the bridge transitions the session into
   * closing, so subsequent sendMessage rejects and the live events iterator
   * terminates after observing session.ended.
   */
  triggerCrash(): void {
    const ctx = this.#ctx;
    if (!ctx) throw new Error("supervisor not started");
    emitCrashEvents(ctx);
  }

  async close(_sessionId: string): Promise<void> {
    await this.#teardown();
  }

  async #teardown(): Promise<void> {
    const client = this.#client;
    const server = this.#server;
    const channel = this.#channel;
    const peer = this.#peer;
    const echoChain = this.#echoChain;
    this.#client = undefined;
    this.#server = undefined;
    this.#channel = undefined;
    this.#peer = undefined;
    this.#ctx = undefined;
    this.#echoChain = Promise.resolve();
    try {
      await echoChain;
    } catch {
      // best effort
    }
    if (client) {
      try {
        await client.close();
      } catch (err) {
        console.error(`MockSupervisor: client close failed: ${String(err)}`);
      }
    }
    if (peer) {
      try {
        await peer.close();
      } catch (err) {
        console.error(`MockSupervisor: peer close failed: ${String(err)}`);
      }
    }
    if (channel) {
      try {
        await channel.server.close();
      } catch (err) {
        console.error(`MockSupervisor: channel close failed: ${String(err)}`);
      }
    }
    if (server) {
      try {
        await server.close();
      } catch (err) {
        console.error(`MockSupervisor: server close failed: ${String(err)}`);
      }
    }
  }

  #scheduleEcho(message: PendingMessage): void {
    const client = this.#client;
    if (!client) return;
    const { messageId, content } = message;
    this.#echoChain = this.#echoChain.then(() => this.#runEcho(client, messageId, content));
  }

  async #runEcho(
    client: ControlClient,
    messageId: string | undefined,
    content: string,
  ): Promise<void> {
    try {
      const progressArgs: Record<string, unknown> = { content: "thinking" };
      if (messageId !== undefined) progressArgs.messageId = messageId;
      await client.sendTool("bridge_progress", progressArgs);

      const replyArgs: Record<string, unknown> = {
        content: `echo: ${content}`,
        final: true,
      };
      if (messageId !== undefined) replyArgs.messageId = messageId;
      await client.sendTool("bridge_reply", replyArgs);

      await client.sendTool("bridge_done", {});
    } catch (err) {
      console.error(`MockSupervisor: echo failed: ${String(err)}`);
    }
  }

  #dispatchTool(name: string, args: Record<string, unknown>): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    dispatchBridgeTool(ctx, name, args);
  }
}

export function mockSupervisorFactory(): SupervisorFactory {
  return () => new MockSupervisor();
}
