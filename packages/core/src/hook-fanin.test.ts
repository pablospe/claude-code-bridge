import { expect, test } from "bun:test";
import type { BridgeEvent } from "./events.ts";
import { HookFanin } from "./hook-fanin.ts";
import { HOOK_MAX_FIELD_BYTES } from "./hooks.ts";
import type { SupervisorContext } from "./supervisor.ts";

function makeCtx(sessionId = "s1"): {
  ctx: SupervisorContext;
  events: BridgeEvent[];
} {
  const events: BridgeEvent[] = [];
  return {
    events,
    ctx: { sessionId, emit: (e) => events.push(e) },
  };
}

function payloadEvent(e: BridgeEvent | undefined): string {
  if (!e) throw new Error("expected a BridgeEvent, got undefined");
  if (e.type !== "tool.event") throw new Error("not a tool.event");
  return e.payload.event;
}

test("HookFanin queues hook frames received before the first hello", () => {
  const { ctx, events } = makeCtx();
  const fanin = new HookFanin(ctx);
  fanin.onHook("PreToolUse", { tool_name: "Bash" });
  expect(events).toEqual([]);
  expect(fanin.metrics().pendingQueueDepth).toBe(1);
  expect(fanin.metrics().preHelloHookDrops).toBe(0);
});

test("HookFanin flushes the queue in arrival order on hello", () => {
  const { ctx, events } = makeCtx();
  const fanin = new HookFanin(ctx);
  fanin.onHook("PreToolUse", { tool_name: "a" });
  fanin.onHook("PostToolUse", { tool_name: "a" });
  fanin.onHook("Stop", {});
  fanin.onHello();
  expect(events).toHaveLength(3);
  expect(payloadEvent(events[0])).toBe("PreToolUse");
  expect(payloadEvent(events[1])).toBe("PostToolUse");
  expect(payloadEvent(events[2])).toBe("Stop");
  expect(fanin.metrics().pendingQueueDepth).toBe(0);
});

test("HookFanin dispatches hook frames received after hello immediately", () => {
  const { ctx, events } = makeCtx();
  const fanin = new HookFanin(ctx);
  fanin.onHello();
  fanin.onHook("Stop", {});
  expect(events).toHaveLength(1);
  expect(payloadEvent(events[0])).toBe("Stop");
});

test("HookFanin drops oldest on overflow and increments the drop counter", () => {
  const { ctx } = makeCtx();
  const fanin = new HookFanin(ctx, { queueCap: 3 });
  fanin.onHook("PreToolUse", { n: 1 });
  fanin.onHook("PreToolUse", { n: 2 });
  fanin.onHook("PreToolUse", { n: 3 });
  fanin.onHook("PreToolUse", { n: 4 }); // overflow → drop n=1
  fanin.onHook("PreToolUse", { n: 5 }); // overflow → drop n=2
  expect(fanin.metrics().preHelloHookDrops).toBe(2);
  expect(fanin.metrics().pendingQueueDepth).toBe(3);
});

test("HookFanin overflow keeps the most recent frames (n=3..5 survive)", () => {
  const { ctx, events } = makeCtx();
  const fanin = new HookFanin(ctx, { queueCap: 3 });
  for (let n = 1; n <= 5; n++) {
    fanin.onHook("PreToolUse", { n });
  }
  fanin.onHello();
  const surviving = events
    .map((e) => (e.type === "tool.event" ? (e.payload.data as { n?: number }).n : undefined))
    .filter((n): n is number => typeof n === "number");
  expect(surviving).toEqual([3, 4, 5]);
});

test("HookFanin duplicate hello is idempotent (no re-flush)", () => {
  const { ctx, events } = makeCtx();
  const fanin = new HookFanin(ctx);
  fanin.onHook("Stop", {});
  fanin.onHello();
  expect(events).toHaveLength(1);
  fanin.onHello();
  fanin.onHello();
  expect(events).toHaveLength(1);
});

test("HookFanin onPeerClose discards queued frames without emitting", () => {
  const { ctx, events } = makeCtx();
  const fanin = new HookFanin(ctx);
  fanin.onHook("PreToolUse", { x: 1 });
  fanin.onHook("Stop", {});
  fanin.onPeerClose();
  expect(events).toEqual([]);
  expect(fanin.metrics().pendingQueueDepth).toBe(0);
});

test("HookFanin drops hook frames silently after peer-close (no queue, no emit)", () => {
  const { ctx, events } = makeCtx();
  const fanin = new HookFanin(ctx);
  fanin.onHello();
  fanin.onPeerClose();
  fanin.onHook("PostToolUse", { tool_name: "Bash" });
  expect(events).toEqual([]);
  expect(fanin.metrics().pendingQueueDepth).toBe(0);
});

test("HookFanin truncates oversized tool_input at queue-time (bounded memory)", () => {
  const { ctx, events } = makeCtx();
  const fanin = new HookFanin(ctx);
  const huge = "x".repeat(HOOK_MAX_FIELD_BYTES + 1000);
  fanin.onHook("PreToolUse", { tool_input: huge });
  fanin.onHello();
  expect(events).toHaveLength(1);
  const data = (events[0] as { payload: { data: Record<string, unknown> } }).payload.data;
  expect(typeof data.tool_input).toBe("string");
  expect(Buffer.byteLength(data.tool_input as string, "utf8")).toBeLessThanOrEqual(
    HOOK_MAX_FIELD_BYTES,
  );
  expect(data.truncated_fields).toEqual(["tool_input"]);
});

test("HookFanin emits with the ctx's sessionId on every dispatch", () => {
  const { ctx, events } = makeCtx("session-xyz");
  const fanin = new HookFanin(ctx);
  fanin.onHello();
  fanin.onHook("Stop", {});
  expect(events[0]?.sessionId).toBe("session-xyz");
});
