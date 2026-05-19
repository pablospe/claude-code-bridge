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
 * Apply the 64 KB per-field truncation policy to a raw hook payload and
 * return a new object suitable for embedding in `tool.event.payload.data`.
 * Used by `HookFanin` (truncation at queue-time bounds the queue's memory
 * footprint) and by the hook relay bin (truncation at send-time bounds the
 * bytes on the wire and protects the relay's 100ms send slice).
 *
 * Per `docs/M3.md`: measurement target is `Buffer.byteLength(JSON.stringify
 * (value), "utf8")`, so the 64 KB cap applies to the value as it appears
 * inside the JSON-encoded `tool.event` payload, not the raw string bytes.
 */
export function truncateHookPayload(payload: Record<string, unknown>): Record<string, unknown> {
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
  if (value === null || value === undefined) return { value, truncated: false };
  if (typeof value === "string") {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") <= HOOK_MAX_FIELD_BYTES) {
      return { value, truncated: false };
    }
    return { value: truncateStringToFit(value, HOOK_MAX_FIELD_BYTES), truncated: true };
  }
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

/**
 * Return the largest prefix of `value` whose JSON-serialized form
 * (`JSON.stringify(prefix)`) fits within `maxBytes`. Binary-searches the raw
 * UTF-8 byte cut point because escape-heavy strings (e.g. all `"` or `\\n`)
 * roughly double in size when serialized — slicing on raw bytes alone does
 * not bound the serialized output. log2(64 KB) = 16 iterations is cheap.
 */
function truncateStringToFit(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, "utf8");
  let lo = 0;
  let hi = buf.byteLength;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = buf.subarray(0, mid).toString("utf8");
    const safe = candidate.endsWith("�") ? candidate.slice(0, -1) : candidate;
    if (Buffer.byteLength(JSON.stringify(safe), "utf8") <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const final = buf.subarray(0, best).toString("utf8");
  return final.endsWith("�") ? final.slice(0, -1) : final;
}
