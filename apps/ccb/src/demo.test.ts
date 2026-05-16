import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockSupervisorFactory } from "@ccb/claude-code";
import { runDemo } from "./demo.ts";

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-cli-demo-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

test("runDemo returns the full event stream in order with format=json", async () => {
  const result = await runDemo({
    input: "hello",
    supervisorFactory: mockSupervisorFactory(),
    format: "json",
    storeDir,
    timeoutMs: 2000,
  });
  const types = result.events.map((e) => e.type);
  expect(types).toEqual([
    "session.started",
    "message.sent",
    "agent.progress",
    "agent.reply",
    "session.ended",
  ]);

  const messageSent = result.events[1];
  if (messageSent?.type !== "message.sent") throw new Error("expected message.sent");
  expect(messageSent.content).toBe("hello");

  const progress = result.events[2];
  if (progress?.type !== "agent.progress") throw new Error("expected agent.progress");
  expect(progress.content).toBe("thinking");

  const reply = result.events[3];
  if (reply?.type !== "agent.reply") throw new Error("expected agent.reply");
  expect(reply.content).toBe("echo: hello");
  expect(reply.final).toBe(true);
});

test("runDemo collects events identically with format=pretty", async () => {
  const result = await runDemo({
    input: "hello",
    supervisorFactory: mockSupervisorFactory(),
    format: "pretty",
    storeDir,
    timeoutMs: 2000,
  });
  const types = result.events.map((e) => e.type);
  expect(types).toEqual([
    "session.started",
    "message.sent",
    "agent.progress",
    "agent.reply",
    "session.ended",
  ]);
});
