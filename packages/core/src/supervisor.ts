import type { BridgeEvent } from "./events.ts";

export interface SupervisorContext {
  readonly sessionId: string;
  emit(event: BridgeEvent): void;
}

export interface Supervisor {
  start(ctx: SupervisorContext): Promise<void>;
  sendMessage(sessionId: string, messageId: string, content: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}

/**
 * Translate a bridge tool call from the wire (bridge_reply / bridge_progress /
 * bridge_done) into a BridgeEvent and emit it through ctx. Shared between
 * supervisors that consume the same outbound MCP tool surface.
 *
 * Silently drops calls whose payload does not match the expected shape; the
 * channel-server schema layer already validates before the call gets here, so
 * mismatches at this layer indicate a non-bridge tool or wire corruption.
 */
export function dispatchBridgeTool(
  ctx: SupervisorContext,
  name: string,
  args: Record<string, unknown>,
): void {
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
    const event: BridgeEvent = {
      type: "agent.done",
      sessionId,
      ...(typeof args.messageId === "string" ? { messageId: args.messageId } : {}),
      ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
    };
    ctx.emit(event);
    return;
  }
}

/**
 * Maximum size, in UTF-8 bytes, of each truncatable field on a hook payload.
 * Per M3.md: applied independently to `tool_input` and `tool_result`.
 */
export const HOOK_MAX_FIELD_BYTES = 65_536;

const HOOK_TRUNCATABLE_FIELDS = ["tool_input", "tool_result"] as const;

/**
 * Translate a hook frame received over the control protocol into a `tool.event`
 * BridgeEvent. Applies the 64 KB per-field truncation policy to `tool_input`
 * and `tool_result` before emitting; truncated field names are recorded under
 * `data.truncated_fields` (omitted when nothing was cut).
 */
export function dispatchHookEvent(
  ctx: SupervisorContext,
  event: string,
  payload: Record<string, unknown>,
): void {
  const data = truncateHookPayload(payload);
  ctx.emit({
    type: "tool.event",
    sessionId: ctx.sessionId,
    payload: { event, data },
  });
}

function truncateHookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  const truncatedFields: string[] = [];
  for (const field of HOOK_TRUNCATABLE_FIELDS) {
    if (!(field in out)) continue;
    const original = out[field];
    const result = truncateValue(original);
    if (result.truncated) {
      out[field] = result.value;
      truncatedFields.push(field);
    }
  }
  if (truncatedFields.length > 0) {
    out.truncated_fields = truncatedFields;
  }
  return out;
}

function truncateValue(value: unknown): { value: unknown; truncated: boolean } {
  if (typeof value === "string") {
    const buf = Buffer.from(value, "utf8");
    if (buf.byteLength <= HOOK_MAX_FIELD_BYTES) return { value, truncated: false };
    const sliced = buf.subarray(0, HOOK_MAX_FIELD_BYTES).toString("utf8");
    const safe = sliced.endsWith("�") ? sliced.slice(0, -1) : sliced;
    return { value: safe, truncated: true };
  }
  if (value === null || value === undefined) return { value, truncated: false };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    return { value: `<truncated: unserializable>`, truncated: true };
  }
  if (Buffer.byteLength(serialized, "utf8") <= HOOK_MAX_FIELD_BYTES) {
    return { value, truncated: false };
  }
  return { value: `<truncated: object exceeded ${HOOK_MAX_FIELD_BYTES} bytes>`, truncated: true };
}
