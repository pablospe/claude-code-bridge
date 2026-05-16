import type { BridgeEvent, Supervisor, SupervisorContext, SupervisorFactory } from "@ccb/core";
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

  async start(ctx: SupervisorContext): Promise<void> {
    this.#ctx = ctx;
    const sessionId = ctx.sessionId;

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
    await Promise.all([channel.server.connect(serverTransport), peer.connect(clientTransport)]);

    const client = new ControlClient({
      endpoint: endpoint.endpoint,
      sessionId,
      onDeliver: async (content, opts) => {
        await channel.deliver(content, opts);
        this.#scheduleEcho({ messageId: opts.messageId, content });
      },
    });
    this.#client = client;
    await client.connect();
  }

  async sendMessage(sessionId: string, messageId: string, content: string): Promise<void> {
    const server = this.#server;
    if (!server) throw new Error("supervisor not started");
    await server.deliver(sessionId, content, { messageId });
  }

  async interrupt(_sessionId: string): Promise<void> {
    // no-op for the mock supervisor
  }

  async close(_sessionId: string): Promise<void> {
    const client = this.#client;
    const server = this.#server;
    const channel = this.#channel;
    const peer = this.#peer;
    this.#client = undefined;
    this.#server = undefined;
    this.#channel = undefined;
    this.#peer = undefined;
    this.#ctx = undefined;
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
    queueMicrotask(() => {
      void this.#runEcho(client, messageId, content);
    });
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
    const sessionId = ctx.sessionId;
    if (name === "bridge_reply") {
      const content = args.content;
      const final = args.final;
      if (typeof content !== "string" || typeof final !== "boolean") return;
      const event: BridgeEvent = {
        type: "agent.reply",
        sessionId,
        content,
        final,
        ...(typeof args.messageId === "string" ? { messageId: args.messageId } : {}),
      };
      ctx.emit(event);
      return;
    }
    if (name === "bridge_progress") {
      const content = args.content;
      if (typeof content !== "string") return;
      const event: BridgeEvent = {
        type: "agent.progress",
        sessionId,
        content,
        ...(typeof args.messageId === "string" ? { messageId: args.messageId } : {}),
      };
      ctx.emit(event);
      return;
    }
    if (name === "bridge_done") {
      // no bridge event; Bridge.close handles session.ended
      return;
    }
  }
}

export function mockSupervisorFactory(): SupervisorFactory {
  return () => new MockSupervisor();
}
