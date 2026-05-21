import { expect, test } from "bun:test";
import type { BridgeEvent } from "@ccb/core";
import { ControlClient } from "@ccb/mcp-channel";
import { type ChannelStatus, ServeSupervisor } from "./serve-supervisor.ts";

const WIRE_SESSION_ID = "00000000-0000-4000-8000-000000000001";

interface Harness {
  supervisor: ServeSupervisor;
  events: BridgeEvent[];
  endpoint: string;
  statuses: Array<{ status: ChannelStatus; sessionId: string }>;
}

async function startSupervisor(): Promise<Harness> {
  const events: BridgeEvent[] = [];
  const statuses: Array<{ status: ChannelStatus; sessionId: string }> = [];
  const listening = Promise.withResolvers<{ endpoint: string }>();
  const supervisor = new ServeSupervisor(
    "127.0.0.1",
    0,
    WIRE_SESSION_ID,
    (info) => listening.resolve(info),
    (status, sessionId) => statuses.push({ status, sessionId }),
  );
  await supervisor.start({ sessionId: WIRE_SESSION_ID, emit: (e) => events.push(e) });
  const { endpoint } = await listening.promise;
  return { supervisor, events, endpoint, statuses };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("ServeSupervisor.start invokes onListening with the bound endpoint", async () => {
  const { supervisor, endpoint } = await startSupervisor();
  expect(endpoint).toMatch(/^127\.0\.0\.1:\d+$/);
  await supervisor.close(WIRE_SESSION_ID);
});

test("ServeSupervisor rejects a second start", async () => {
  const { supervisor } = await startSupervisor();
  await expect(
    supervisor.start({ sessionId: WIRE_SESSION_ID, emit: () => undefined }),
  ).rejects.toThrow("supervisor already started");
  await supervisor.close(WIRE_SESSION_ID);
});

test("ServeSupervisor dispatches bridge_reply tool calls as agent.reply", async () => {
  const { supervisor, events, endpoint } = await startSupervisor();
  const client = new ControlClient({
    endpoint,
    sessionId: WIRE_SESSION_ID,
    onDeliver: () => undefined,
  });
  await client.connect();

  await client.sendTool("bridge_reply", { content: "hi", final: true, messageId: "m1" });
  await waitFor(() => events.some((e) => e.type === "agent.reply"));

  const reply = events.find((e) => e.type === "agent.reply");
  expect(reply).toBeDefined();
  if (reply && reply.type === "agent.reply") {
    expect(reply.content).toBe("hi");
    expect(reply.final).toBe(true);
    expect(reply.messageId).toBe("m1");
  }

  await client.close();
  await supervisor.close(WIRE_SESSION_ID);
});

test("ServeSupervisor reports channel connect and disconnect status", async () => {
  const { supervisor, statuses, endpoint } = await startSupervisor();
  const client = new ControlClient({
    endpoint,
    sessionId: WIRE_SESSION_ID,
    onDeliver: () => undefined,
  });
  await client.connect();
  await waitFor(() => statuses.some((s) => s.status === "connected"));
  expect(statuses).toContainEqual({ status: "connected", sessionId: WIRE_SESSION_ID });

  await client.close();
  await waitFor(() => statuses.some((s) => s.status === "disconnected"));
  expect(statuses).toContainEqual({ status: "disconnected", sessionId: WIRE_SESSION_ID });

  await supervisor.close(WIRE_SESSION_ID);
});

test("ServeSupervisor.sendMessage delivers content to the connected client", async () => {
  const { supervisor, endpoint } = await startSupervisor();
  const delivered: string[] = [];
  const deliverWaiter = Promise.withResolvers<void>();
  const client = new ControlClient({
    endpoint,
    sessionId: WIRE_SESSION_ID,
    onDeliver: (content) => {
      delivered.push(content);
      deliverWaiter.resolve();
    },
  });
  await client.connect();

  await supervisor.sendMessage(WIRE_SESSION_ID, "m1", "ping");
  await deliverWaiter.promise;
  expect(delivered).toEqual(["ping"]);

  await client.close();
  await supervisor.close(WIRE_SESSION_ID);
});

test("ServeSupervisor.sendMessage rejects an unknown session", async () => {
  const { supervisor } = await startSupervisor();
  await expect(supervisor.sendMessage("other", "m1", "ping")).rejects.toThrow(
    "unknown session: other",
  );
  await supervisor.close(WIRE_SESSION_ID);
});

test("ServeSupervisor synthesizes channel-disconnect events on peer close", async () => {
  const { supervisor, events, endpoint } = await startSupervisor();
  const client = new ControlClient({
    endpoint,
    sessionId: WIRE_SESSION_ID,
    onDeliver: () => undefined,
  });
  await client.connect();
  await client.close();

  await waitFor(() => events.some((e) => e.type === "session.ended"));

  const done = events.find((e) => e.type === "agent.done" && e.reason === "channel-disconnected");
  const ended = events.find(
    (e) => e.type === "session.ended" && e.reason === "channel disconnected",
  );
  expect(done).toBeDefined();
  expect(ended).toBeDefined();

  await supervisor.close(WIRE_SESSION_ID);
});
