import { expect, test } from "bun:test";
import type { BridgeEvent } from "./events.ts";
import { dispatchBridgeTool, type Supervisor, type SupervisorContext } from "./supervisor.ts";
import type { ClaudeCodeBridge, SendOptions, StartSessionOptions } from "./types.ts";

test("Supervisor can be implemented with the documented surface", async () => {
  const seen: BridgeEvent[] = [];

  class StubSupervisor implements Supervisor {
    async start(ctx: SupervisorContext): Promise<void> {
      ctx.emit({ type: "agent.progress", sessionId: "s1", content: "ready" });
    }
    async sendMessage(_sessionId: string, _messageId: string, _content: string): Promise<void> {}
    async interrupt(_sessionId: string): Promise<void> {}
    async close(_sessionId: string): Promise<void> {}
  }

  const supervisor: Supervisor = new StubSupervisor();
  await supervisor.start({
    sessionId: "s1",
    emit: (event) => {
      seen.push(event);
    },
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.type).toBe("agent.progress");
});

test("StartSessionOptions and SendOptions are usable shapes", () => {
  const start: StartSessionOptions = {};
  const send: SendOptions = {};
  expect(start).toEqual({});
  expect(send).toEqual({});
});

test("ClaudeCodeBridge interface has the documented method shape", () => {
  type Method = keyof ClaudeCodeBridge;
  const required: Method[] = ["startSession", "sendMessage", "events", "interrupt", "close"];
  expect(required).toHaveLength(5);
});

test("dispatchBridgeTool emits agent.reply for bridge_reply", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s1", emit: (e) => events.push(e) };
  dispatchBridgeTool(ctx, "bridge_reply", { content: "hi", final: true, messageId: "m1" });
  expect(events).toEqual([
    { type: "agent.reply", sessionId: "s1", content: "hi", final: true, messageId: "m1" },
  ]);
});

test("dispatchBridgeTool emits agent.progress for bridge_progress", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s1", emit: (e) => events.push(e) };
  dispatchBridgeTool(ctx, "bridge_progress", { content: "working" });
  expect(events).toEqual([{ type: "agent.progress", sessionId: "s1", content: "working" }]);
});

test("dispatchBridgeTool emits agent.done for bridge_done with optional reason", () => {
  const a: BridgeEvent[] = [];
  dispatchBridgeTool({ sessionId: "s1", emit: (e) => a.push(e) }, "bridge_done", {
    reason: "finished",
  });
  expect(a).toEqual([{ type: "agent.done", sessionId: "s1", reason: "finished" }]);

  const b: BridgeEvent[] = [];
  dispatchBridgeTool({ sessionId: "s2", emit: (e) => b.push(e) }, "bridge_done", {});
  expect(b).toEqual([{ type: "agent.done", sessionId: "s2" }]);
});

test("dispatchBridgeTool drops malformed payloads silently", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s1", emit: (e) => events.push(e) };
  dispatchBridgeTool(ctx, "bridge_reply", { content: "x" });
  dispatchBridgeTool(ctx, "bridge_progress", {});
  dispatchBridgeTool(ctx, "unknown_tool", {});
  expect(events).toEqual([]);
});

// ---------------------------------------------------------------------------
// M3.1 — dispatchHookEvent + 64KB per-field truncation
// ---------------------------------------------------------------------------

import { dispatchHookEvent, HOOK_MAX_FIELD_BYTES } from "./supervisor.ts";

test("dispatchHookEvent emits a tool.event BridgeEvent with verbatim payload when small", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s-hook", emit: (e) => events.push(e) };
  dispatchHookEvent(ctx, "PreToolUse", {
    tool_name: "Bash",
    tool_use_id: "toolu_01",
    tool_input: { command: "ls" },
  });
  expect(events).toEqual([
    {
      type: "tool.event",
      sessionId: "s-hook",
      payload: {
        event: "PreToolUse",
        data: {
          tool_name: "Bash",
          tool_use_id: "toolu_01",
          tool_input: { command: "ls" },
        },
      },
    },
  ]);
});

test("dispatchHookEvent truncates a string tool_input larger than 64KB and marks truncated_fields", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s-trunc", emit: (e) => events.push(e) };
  const huge = "x".repeat(HOOK_MAX_FIELD_BYTES + 10);
  dispatchHookEvent(ctx, "PreToolUse", {
    tool_name: "Bash",
    tool_input: huge,
  });
  expect(events).toHaveLength(1);
  const data = (events[0] as { payload: { data: Record<string, unknown> } }).payload.data;
  expect(typeof data.tool_input).toBe("string");
  expect(Buffer.byteLength(data.tool_input as string, "utf8")).toBeLessThanOrEqual(
    HOOK_MAX_FIELD_BYTES,
  );
  expect(data.truncated_fields).toEqual(["tool_input"]);
});

test("dispatchHookEvent independently truncates tool_input and tool_result (per-field rule)", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s-both", emit: (e) => events.push(e) };
  const huge = "y".repeat(HOOK_MAX_FIELD_BYTES + 100);
  dispatchHookEvent(ctx, "PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: "tiny" }, // small object — must NOT be truncated
    tool_result: huge, // huge string — must be truncated
  });
  const data = (events[0] as { payload: { data: Record<string, unknown> } }).payload.data;
  expect(data.tool_input).toEqual({ command: "tiny" });
  expect(typeof data.tool_result).toBe("string");
  expect(Buffer.byteLength(data.tool_result as string, "utf8")).toBeLessThanOrEqual(
    HOOK_MAX_FIELD_BYTES,
  );
  expect(data.truncated_fields).toEqual(["tool_result"]);
});

test("dispatchHookEvent replaces an oversize object tool_input with the truncation marker string", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s-obj", emit: (e) => events.push(e) };
  // Build an object whose serialized form exceeds 64KB.
  const bigArray = Array.from({ length: 70 }, () => "z".repeat(1024));
  dispatchHookEvent(ctx, "PreToolUse", {
    tool_input: { stuff: bigArray },
  });
  const data = (events[0] as { payload: { data: Record<string, unknown> } }).payload.data;
  expect(typeof data.tool_input).toBe("string");
  expect((data.tool_input as string).startsWith("<truncated: object exceeded")).toBe(true);
  expect(data.truncated_fields).toEqual(["tool_input"]);
});

test("dispatchHookEvent omits truncated_fields entirely when nothing was cut", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s-ok", emit: (e) => events.push(e) };
  dispatchHookEvent(ctx, "Stop", { stop_hook_active: false });
  const data = (events[0] as { payload: { data: Record<string, unknown> } }).payload.data;
  expect("truncated_fields" in data).toBe(false);
});

test("dispatchHookEvent passes metadata fields (tool_name, tool_use_id, timestamps) through whole", () => {
  const events: BridgeEvent[] = [];
  const ctx: SupervisorContext = { sessionId: "s-meta", emit: (e) => events.push(e) };
  const meta = {
    tool_name: "Bash",
    tool_use_id: "toolu_meta",
    timestamp: "2026-05-19T20:00:00.000Z",
    hook_event_name: "PreToolUse",
    session_id: "claude-internal-not-routed",
  };
  dispatchHookEvent(ctx, "PreToolUse", { ...meta, tool_input: { command: "echo hi" } });
  const data = (events[0] as { payload: { data: Record<string, unknown> } }).payload.data;
  for (const [k, v] of Object.entries(meta)) {
    expect(data[k]).toEqual(v);
  }
});
