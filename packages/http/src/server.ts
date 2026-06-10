import { validateChatRequest } from "./openai-types.ts";
import type { SessionPool } from "./pool.ts";
import { renderTranscript } from "./renderer.ts";
import { buildChunk, buildCompletion, newCompletionId } from "./response.ts";
import { parseReply } from "./tool-call-parser.ts";
import { runTurn, type TurnResult, TurnTimeoutError } from "./turn.ts";

export const FACADE_MODEL_ID = "ccb-claude";

/**
 * Crash-shaped turn failures are retried once on a fresh session (the pool
 * already replaced the crashed one). Timeouts and other errors are not
 * retried; a streaming turn that already emitted deltas is not retried
 * either, since the client has observed partial output.
 */
const RETRYABLE_TURN_ERROR = /session ended mid-turn|session is closing|unknown session/;

async function runPoolTurn(
  pool: SessionPool,
  prompt: string,
  timeoutMs: number,
  onDelta?: (delta: string) => void,
): Promise<TurnResult> {
  let emitted = false;
  const wrapped = onDelta
    ? (delta: string) => {
        emitted = true;
        onDelta(delta);
      }
    : undefined;
  const attempt = () =>
    pool.withSession((sessionId) =>
      runTurn({ bridge: pool.bridge, sessionId, prompt, timeoutMs, onDelta: wrapped }),
    );
  try {
    return await attempt();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (emitted || !RETRYABLE_TURN_ERROR.test(message)) throw err;
    return await attempt();
  }
}

export interface ApiServerOptions {
  readonly pool: SessionPool;
  readonly host: string;
  readonly port: number;
  readonly turnTimeoutMs: number;
  readonly apiKey?: string;
}

export interface ApiServerHandle {
  readonly url: string;
  stop(): Promise<void>;
}

function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { message, type, param: null, code: null } }, { status });
}

const IGNORED_PARAMS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "n",
  "logprobs",
  "response_format",
];
const warnedParams = new Set<string>();

function warnIgnoredParams(body: Record<string, unknown>): void {
  for (const p of IGNORED_PARAMS) {
    if (body[p] !== undefined && !warnedParams.has(p)) {
      warnedParams.add(p);
      console.error(`ccb api: ignoring unsupported parameter '${p}' (logged once)`);
    }
  }
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const { pool, turnTimeoutMs, apiKey } = options;

  async function handleCompletions(req: Request): Promise<Response> {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return errorResponse(400, "invalid_request_error", "request body must be valid JSON");
    }
    const validated = validateChatRequest(raw);
    if (!validated.ok) {
      return errorResponse(400, "invalid_request_error", validated.error);
    }
    warnIgnoredParams(raw as Record<string, unknown>);
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
        return Response.json(buildCompletion({ model: request.model, prompt, parsed }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof TurnTimeoutError ? 504 : 500;
        return errorResponse(status, "server_error", message);
      }
    }

    const id = newCompletionId();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (data: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        try {
          let sentRole = false;
          // Tool turns are buffered until parseable: pass no onDelta so the
          // retry helper sees no emitted output and a crashed first attempt
          // stays retryable.
          const onDelta = buffered
            ? undefined
            : (delta: string) => {
                if (!sentRole) {
                  sentRole = true;
                  send(buildChunk({ id, model: request.model, delta: { role: "assistant" } }));
                }
                send(buildChunk({ id, model: request.model, delta: { content: delta } }));
              };
          const result = await runPoolTurn(pool, prompt, turnTimeoutMs, onDelta);
          const parsed =
            request.tool_choice === "none"
              ? { kind: "text" as const, content: result.content }
              : parseReply(result.content);
          if (parsed.kind === "tool_calls") {
            send(
              buildChunk({
                id,
                model: request.model,
                delta: {
                  role: "assistant",
                  tool_calls: parsed.calls.map((c, index) => ({ ...c, index })),
                },
              }),
            );
            send(buildChunk({ id, model: request.model, delta: {}, finishReason: "tool_calls" }));
          } else {
            if (buffered) {
              send(
                buildChunk({
                  id,
                  model: request.model,
                  delta: { role: "assistant", content: parsed.content },
                }),
              );
            }
            send(buildChunk({ id, model: request.model, delta: {}, finishReason: "stop" }));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          controller.error(err);
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

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      if (apiKey !== undefined) {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${apiKey}`) {
          return errorResponse(401, "authentication_error", "invalid or missing API key");
        }
      }
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: FACADE_MODEL_ID, object: "model", created: 0, owned_by: "ccb" }],
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        return handleCompletions(req);
      }
      return errorResponse(404, "invalid_request_error", `unknown route: ${url.pathname}`);
    },
  });

  return {
    url: `http://${options.host}:${server.port}`,
    async stop() {
      await server.stop(true);
    },
  };
}
