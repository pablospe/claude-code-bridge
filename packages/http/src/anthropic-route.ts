// packages/http/src/anthropic-route.ts
import {
  blockStopEvent,
  buildAnthropicMessage,
  inputJsonDeltaEvent,
  messageDeltaEvent,
  messageStartEvent,
  messageStopEvent,
  newAnthropicMessageId,
  sseEvent,
  textBlockStartEvent,
  textDeltaEvent,
  toolUseBlockStartEvent,
  toolUseInput,
} from "./anthropic-response.ts";
import { validateAnthropicRequest } from "./anthropic-types.ts";
import type { SessionPool } from "./pool.ts";
import { renderTranscript } from "./renderer.ts";
import { estimateTokens } from "./response.ts";
import { runPoolTurn, warnIgnored } from "./server.ts";
import { parseReply } from "./tool-call-parser.ts";
import { TurnTimeoutError } from "./turn.ts";

/** Build an Anthropic-shaped error response. */
export function anthropicError(status: number, type: string, message: string): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

const IGNORED_PARAMS = [
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "thinking",
  "metadata",
  "stop_sequences",
];

export async function handleAnthropicMessages(
  req: Request,
  pool: SessionPool,
  turnTimeoutMs: number,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return anthropicError(400, "invalid_request_error", "request body must be valid JSON");
  }
  const validated = validateAnthropicRequest(raw);
  if (!validated.ok) {
    return anthropicError(400, "invalid_request_error", validated.error);
  }
  warnIgnored(IGNORED_PARAMS, raw as Record<string, unknown>);
  const request = validated.value;
  const prompt = renderTranscript(request.messages, request.tools, request.tool_choice);
  const buffered = request.tools.length > 0 && request.tool_choice !== "none";

  if (!request.stream) {
    try {
      const result = await runPoolTurn(pool, prompt, turnTimeoutMs);
      const parsed =
        request.tool_choice === "none"
          ? { kind: "text" as const, content: result.content }
          : parseReply(result.content);
      return Response.json(buildAnthropicMessage({ model: request.model, prompt, parsed }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TurnTimeoutError) return anthropicError(504, "api_error", message);
      return anthropicError(500, "api_error", message);
    }
  }

  const id = newAnthropicMessageId();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: string) => controller.enqueue(encoder.encode(frame));
      // Non-buffered text path streams deltas; buffered tool path holds until parse.
      let textStarted = false;
      try {
        send(messageStartEvent(id, request.model, estimateTokens(prompt)));

        const onDelta = buffered
          ? undefined
          : (delta: string) => {
              if (!textStarted) {
                textStarted = true;
                send(textBlockStartEvent(0));
              }
              send(textDeltaEvent(0, delta));
            };

        const result = await runPoolTurn(pool, prompt, turnTimeoutMs, onDelta);
        // Once text deltas have streamed, the client already saw this content as
        // prose; never reinterpret the final content as tool calls mid-stream.
        const parsed =
          request.tool_choice === "none" || textStarted
            ? { kind: "text" as const, content: result.content }
            : parseReply(result.content);

        // Output tokens are measured from the fully-assembled content blocks.
        const message = buildAnthropicMessage({ model: request.model, prompt, parsed });
        const outTokens = message.usage.output_tokens;

        if (parsed.kind === "tool_calls") {
          parsed.calls.forEach((call, i) => {
            send(toolUseBlockStartEvent(i, call.id, call.function.name));
            send(inputJsonDeltaEvent(i, JSON.stringify(toolUseInput(call.function.arguments))));
            send(blockStopEvent(i));
          });
          send(messageDeltaEvent("tool_use", outTokens));
        } else {
          // Non-buffered turns may have already streamed deltas; if none arrived
          // but the final content is non-empty, emit it as a single block.
          if (!textStarted) {
            send(textBlockStartEvent(0));
            if (parsed.content.length > 0) send(textDeltaEvent(0, parsed.content));
          }
          send(blockStopEvent(0));
          send(messageDeltaEvent("end_turn", outTokens));
        }
        send(messageStopEvent());
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Close any open text block so the client sees a well-formed block
        // before the terminal error frame.
        if (textStarted) send(blockStopEvent(0));
        send(sseEvent("error", { type: "error", error: { type: "api_error", message } }));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
