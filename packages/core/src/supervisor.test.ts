import { expect, test } from "bun:test";
import type { BridgeEvent } from "./events.ts";
import {
  dispatchBridgeTool,
  HOOK_MAX_FIELD_BYTES,
  type Supervisor,
  type SupervisorContext,
  truncateHookPayload,
} from "./supervisor.ts";
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
// M3.1 — truncateHookPayload (64KB per-field truncation, JSON-serialized rule)
// ---------------------------------------------------------------------------

test("truncateHookPayload passes a small payload through verbatim and omits truncated_fields", () => {
  const out = truncateHookPayload({
    tool_name: "Bash",
    tool_use_id: "toolu_01",
    tool_input: { command: "ls" },
  });
  expect(out).toEqual({
    tool_name: "Bash",
    tool_use_id: "toolu_01",
    tool_input: { command: "ls" },
  });
  expect("truncated_fields" in out).toBe(false);
});

test("truncateHookPayload truncates a string tool_input larger than 64KB and marks the field", () => {
  const huge = "x".repeat(HOOK_MAX_FIELD_BYTES + 10);
  const out = truncateHookPayload({ tool_name: "Bash", tool_input: huge });
  expect(typeof out.tool_input).toBe("string");
  // Spec target: JSON-serialized size stays inside the cap (raw + 2 quote bytes).
  expect(Buffer.byteLength(JSON.stringify(out.tool_input), "utf8")).toBeLessThanOrEqual(
    HOOK_MAX_FIELD_BYTES,
  );
  expect(out.truncated_fields).toEqual(["tool_input"]);
});

test("truncateHookPayload independently truncates tool_input and tool_result (per-field rule)", () => {
  const huge = "y".repeat(HOOK_MAX_FIELD_BYTES + 100);
  const out = truncateHookPayload({
    tool_name: "Bash",
    tool_input: { command: "tiny" }, // small object — must NOT be truncated
    tool_result: huge, // huge string — must be truncated
  });
  expect(out.tool_input).toEqual({ command: "tiny" });
  expect(typeof out.tool_result).toBe("string");
  expect(Buffer.byteLength(JSON.stringify(out.tool_result), "utf8")).toBeLessThanOrEqual(
    HOOK_MAX_FIELD_BYTES,
  );
  expect(out.truncated_fields).toEqual(["tool_result"]);
});

test("truncateHookPayload replaces an oversize object tool_input with the truncation marker", () => {
  // Build an object whose serialized form exceeds 64KB.
  const bigArray = Array.from({ length: 70 }, () => "z".repeat(1024));
  const out = truncateHookPayload({ tool_input: { stuff: bigArray } });
  expect(typeof out.tool_input).toBe("string");
  expect((out.tool_input as string).startsWith("<truncated: object exceeded")).toBe(true);
  expect(out.truncated_fields).toEqual(["tool_input"]);
});

test("truncateHookPayload omits truncated_fields entirely when nothing was cut", () => {
  const out = truncateHookPayload({ stop_hook_active: false });
  expect("truncated_fields" in out).toBe(false);
});

test("truncateHookPayload passes metadata fields (tool_name, tool_use_id, timestamps) through whole", () => {
  const meta = {
    tool_name: "Bash",
    tool_use_id: "toolu_meta",
    timestamp: "2026-05-19T20:00:00.000Z",
    hook_event_name: "PreToolUse",
    session_id: "claude-internal-not-routed",
  };
  const out = truncateHookPayload({ ...meta, tool_input: { command: "echo hi" } });
  for (const [k, v] of Object.entries(meta)) {
    expect(out[k]).toEqual(v);
  }
});

test("truncateHookPayload truncates a string whose JSON-serialized form exceeds 64KB but raw bytes do not", () => {
  // Use a string of `"` chars: each serializes to `\"` (2 bytes) so the raw byte
  // count is half the serialized count. A raw length of HOOK_MAX_FIELD_BYTES - 1
  // serializes to ~2 * (HOOK_MAX_FIELD_BYTES - 1) bytes, well over the cap.
  const raw = '"'.repeat(HOOK_MAX_FIELD_BYTES - 1);
  expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(HOOK_MAX_FIELD_BYTES);
  expect(Buffer.byteLength(JSON.stringify(raw), "utf8")).toBeGreaterThan(HOOK_MAX_FIELD_BYTES);
  const out = truncateHookPayload({ tool_input: raw });
  expect(out.truncated_fields).toEqual(["tool_input"]);
  expect(Buffer.byteLength(JSON.stringify(out.tool_input), "utf8")).toBeLessThanOrEqual(
    HOOK_MAX_FIELD_BYTES,
  );
});
