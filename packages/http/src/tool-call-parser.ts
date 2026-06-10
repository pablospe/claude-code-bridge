// packages/http/src/tool-call-parser.ts
import type { ToolCall } from "./openai-types.ts";

export type ParsedReply =
  | { kind: "text"; content: string }
  | { kind: "tool_calls"; calls: ReadonlyArray<ToolCall> };

interface RawCall {
  readonly name: string;
  readonly arguments: unknown;
}

function asRawCall(v: unknown): RawCall | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string" || o.name.length === 0) return undefined;
  return { name: o.name, arguments: o.arguments ?? {} };
}

function toToolCall(raw: RawCall): ToolCall {
  return {
    id: `call_${crypto.randomUUID().slice(0, 8)}`,
    type: "function",
    function: {
      name: raw.name,
      arguments: typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments),
    },
  };
}

/**
 * Extract the prompted tool-call protocol from a final reply. Degrades to
 * text on any mismatch — the facade never errors on an unparseable reply.
 *
 * For a `tool_calls` array, every entry must parse: if any entry is invalid
 * the whole reply degrades to text rather than silently dropping entries.
 */
export function parseReply(reply: string): ParsedReply {
  const fenced = reply.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const candidate = (fenced?.[1] ?? reply).trim();
  if (!candidate.startsWith("{")) return { kind: "text", content: reply };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { kind: "text", content: reply };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "text", content: reply };
  const o = parsed as Record<string, unknown>;
  const raws: RawCall[] = [];
  if (o.tool_call !== undefined) {
    const one = asRawCall(o.tool_call);
    if (one) raws.push(one);
  } else if (Array.isArray(o.tool_calls)) {
    for (const c of o.tool_calls) {
      const one = asRawCall(c);
      if (!one) return { kind: "text", content: reply };
      raws.push(one);
    }
  }
  if (raws.length === 0) return { kind: "text", content: reply };
  return { kind: "tool_calls", calls: raws.map(toToolCall) };
}
