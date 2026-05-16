import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeEvent } from "./events.ts";
import { JsonlEventStore } from "./store.ts";

async function corruptFileWithGarbageLine(path: string, afterFirstLine: boolean): Promise<void> {
  const text = await Bun.file(path).text();
  const lines = text.split("\n");
  const garbage = "{not json";
  if (afterFirstLine && lines.length >= 1) {
    lines.splice(1, 0, garbage);
  } else {
    lines.unshift(garbage);
  }
  await Bun.write(path, lines.join("\n"));
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ccb-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("append then readAll returns the event in order", async () => {
  const store = new JsonlEventStore(join(dir, "events.jsonl"));
  const event: BridgeEvent = { type: "session.started", sessionId: "s1" };
  await store.append(event);

  const events = await store.readAll();
  expect(events).toEqual([event]);
});

test("readAll returns multiple events in append order", async () => {
  const store = new JsonlEventStore(join(dir, "events.jsonl"));
  const events: BridgeEvent[] = [
    { type: "session.started", sessionId: "s1" },
    { type: "message.sent", sessionId: "s1", messageId: "m1", content: "hi" },
    { type: "agent.reply", sessionId: "s1", content: "ok", final: true },
    { type: "session.ended", sessionId: "s1", reason: "done" },
  ];
  for (const e of events) {
    await store.append(e);
  }

  const out = await store.readAll();
  expect(out).toEqual(events);
});

test("a second store instance against the same path reads prior events", async () => {
  const path = join(dir, "events.jsonl");
  const first = new JsonlEventStore(path);
  await first.append({ type: "session.started", sessionId: "s1" });
  await first.append({
    type: "agent.progress",
    sessionId: "s1",
    content: "thinking",
  });

  const second = new JsonlEventStore(path);
  const out = await second.readAll();
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({ type: "session.started", sessionId: "s1" });
  expect(out[1]).toEqual({
    type: "agent.progress",
    sessionId: "s1",
    content: "thinking",
  });
});

test("events survive a close-and-reopen cycle", async () => {
  const path = join(dir, "events.jsonl");
  const writer = new JsonlEventStore(path);
  await writer.append({ type: "session.started", sessionId: "s1" });
  await writer.append({
    type: "agent.reply",
    sessionId: "s1",
    content: "hello",
    final: true,
  });
  await writer.close();

  const reader = new JsonlEventStore(path);
  const out = await reader.readAll();
  expect(out).toHaveLength(2);
  expect(out[1]).toEqual({
    type: "agent.reply",
    sessionId: "s1",
    content: "hello",
    final: true,
  });
});

test("readAll on an empty/nonexistent file yields an empty list", async () => {
  const store = new JsonlEventStore(join(dir, "missing.jsonl"));
  const out = await store.readAll();
  expect(out).toEqual([]);
});

test("append across separate store instances does not truncate prior events", async () => {
  const path = join(dir, "events.jsonl");

  const a = new JsonlEventStore(path);
  await a.append({ type: "session.started", sessionId: "s1" });
  await a.append({
    type: "agent.progress",
    sessionId: "s1",
    content: "tick-1",
  });
  await a.close();

  const b = new JsonlEventStore(path);
  await b.append({ type: "agent.progress", sessionId: "s1", content: "tick-2" });
  await b.append({
    type: "agent.reply",
    sessionId: "s1",
    content: "done",
    final: true,
  });
  await b.close();

  const c = new JsonlEventStore(path);
  const out = await c.readAll();
  expect(out).toHaveLength(4);
  expect(out[0]).toEqual({ type: "session.started", sessionId: "s1" });
  expect(out[1]).toEqual({
    type: "agent.progress",
    sessionId: "s1",
    content: "tick-1",
  });
  expect(out[2]).toEqual({
    type: "agent.progress",
    sessionId: "s1",
    content: "tick-2",
  });
  expect(out[3]).toEqual({
    type: "agent.reply",
    sessionId: "s1",
    content: "done",
    final: true,
  });
});

test("readAll skips malformed lines and returns the valid ones", async () => {
  const path = join(dir, "events.jsonl");
  const store = new JsonlEventStore(path);
  await store.append({ type: "session.started", sessionId: "s1" });
  await store.append({
    type: "agent.reply",
    sessionId: "s1",
    content: "ok",
    final: true,
  });
  await store.close();

  await corruptFileWithGarbageLine(path, true);

  const reader = new JsonlEventStore(path);
  const out = await reader.readAll();
  expect(out).toHaveLength(2);
  expect(out[0]).toEqual({ type: "session.started", sessionId: "s1" });
  expect(out[1]).toEqual({
    type: "agent.reply",
    sessionId: "s1",
    content: "ok",
    final: true,
  });
});

test("readAll handles CRLF-terminated lines", async () => {
  const path = join(dir, "events.jsonl");
  const event: BridgeEvent = { type: "session.started", sessionId: "s1" };
  await Bun.write(path, `${JSON.stringify(event)}\r\n`);

  const store = new JsonlEventStore(path);
  const out = await store.readAll();
  expect(out).toEqual([event]);
});

test("concurrent appends preserve submission order and persist all events", async () => {
  const path = join(dir, "events.jsonl");
  const store = new JsonlEventStore(path);

  const count = 50;
  const events: BridgeEvent[] = Array.from({ length: count }, (_, i) => ({
    type: "agent.progress",
    sessionId: "s1",
    content: `tick-${i}`,
  }));

  await Promise.all(events.map((e) => store.append(e)));
  await store.close();

  const reader = new JsonlEventStore(path);
  const out = await reader.readAll();
  expect(out).toHaveLength(count);
  for (let i = 0; i < count; i++) {
    expect(out[i]).toEqual(events[i] as BridgeEvent);
  }
});

test("constructor creates parent directories as needed", async () => {
  const path = join(dir, "nested", "deep", "log.jsonl");
  const store = new JsonlEventStore(path);
  await store.append({ type: "session.started", sessionId: "s1" });
  await store.close();

  const reader = new JsonlEventStore(path);
  const out = await reader.readAll();
  expect(out).toEqual([{ type: "session.started", sessionId: "s1" }]);
});
