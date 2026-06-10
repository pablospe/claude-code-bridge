import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge, type Supervisor, type SupervisorContext } from "@ccb/core";
import { SessionPool } from "./pool.ts";
import { startApiServer } from "./server.ts";

// Replays a scripted sequence of events on sendMessage so a test can pin exact
// turn semantics without a real channel.
class ScriptedSupervisor implements Supervisor {
  #ctx: SupervisorContext | undefined;
  constructor(private readonly script: (ctx: SupervisorContext) => void) {}
  async start(ctx: SupervisorContext): Promise<void> {
    this.#ctx = ctx;
  }
  async sendMessage(): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx) throw new Error("supervisor not started");
    this.script(ctx);
  }
  async interrupt(): Promise<void> {}
  async clear(): Promise<void> {}
  async close(): Promise<void> {}
}

// Never emits a terminal event, so the turn timeout always wins.
class SilentSupervisor implements Supervisor {
  async start(): Promise<void> {}
  async sendMessage(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async clear(): Promise<void> {}
  async close(): Promise<void> {}
}

const storeDir = `/tmp/ccb-anthropic-test-${crypto.randomUUID()}`;
let pool: SessionPool;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeEach(async () => {
  const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
  pool = new SessionPool({ bridge, size: 1 });
  await pool.start();
  server = await startApiServer({ pool, host: "127.0.0.1", port: 0, turnTimeoutMs: 10_000 });
});

afterEach(async () => {
  await server.stop();
  await pool.close();
  await rm(storeDir, { recursive: true, force: true });
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const TOOL_REPLY =
  '```json\n{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}\n```';

/** Spin up a server whose supervisor replies with `content` on every turn. */
async function scriptedServer(suffix: string, content: string) {
  const bridge = new Bridge({
    storeDir: `${storeDir}-${suffix}`,
    supervisorFactory: () =>
      new ScriptedSupervisor((ctx) => {
        ctx.emit({ type: "agent.reply", sessionId: ctx.sessionId, content, final: true });
      }),
  });
  const p = new SessionPool({ bridge, size: 1 });
  await p.start();
  const s = await startApiServer({ pool: p, host: "127.0.0.1", port: 0, turnTimeoutMs: 10_000 });
  return {
    url: s.url,
    async cleanup() {
      await s.stop();
      await p.close();
      await rm(`${storeDir}-${suffix}`, { recursive: true, force: true });
    },
  };
}

/** Parse an SSE body into { event, data } records. */
function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    let event: string | undefined;
    let data: string | undefined;
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice("event: ".length);
      else if (line.startsWith("data: ")) data = line.slice("data: ".length);
    }
    if (event && data !== undefined) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

describe("POST /v1/messages", () => {
  test("non-streaming echo round trip", async () => {
    const res = await post("/v1/messages", {
      model: "ccb-claude",
      max_tokens: 1024,
      messages: [{ role: "user", content: "marco" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      type: string;
      role: string;
      content: Array<{ type: string; text?: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");
    expect(body.content[0]?.type).toBe("text");
    expect(body.content[0]?.text).toContain("marco");
    expect(body.stop_reason).toBe("end_turn");
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.id.startsWith("msg_")).toBe(true);
  });

  test("tool use non-streaming", async () => {
    const srv = await scriptedServer("tool", TOOL_REPLY);
    try {
      const res = await fetch(`${srv.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          max_tokens: 1024,
          messages: [{ role: "user", content: "weather in Paris?" }],
          tools: [
            {
              name: "get_weather",
              input_schema: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          ],
          tool_choice: { type: "tool", name: "get_weather" },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        content: Array<{ type: string; name?: string; input?: { city?: string } }>;
        stop_reason: string;
      };
      expect(body.content[0]?.type).toBe("tool_use");
      expect(body.content[0]?.name).toBe("get_weather");
      expect(body.content[0]?.input?.city).toBe("Paris");
      expect(body.stop_reason).toBe("tool_use");
    } finally {
      await srv.cleanup();
    }
  });

  test("tool result round trip translation feeds the renderer", async () => {
    // MockSupervisor echoes the rendered prompt; assert the echoed text carries
    // the translated tool_result marker, proving translation reached the renderer.
    const res = await post("/v1/messages", {
      model: "ccb-claude",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "weather in Paris?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Paris" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }],
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    expect(body.content[0]?.text).toContain("[tool result for");
  });

  test("streaming text emits the anthropic event sequence", async () => {
    const res = await post("/v1/messages", {
      model: "ccb-claude",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: "marco" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const events = parseSse(text);
    const types = events.map((e) => e.event);

    expect(types[0]).toBe("message_start");
    const start = events[0]?.data as { message: { usage: { input_tokens: number } } };
    expect(start.message.usage.input_tokens).toBeGreaterThan(0);

    expect(types).toContain("content_block_start");
    const blockStart = events.find((e) => e.event === "content_block_start")?.data as {
      content_block: { type: string };
    };
    expect(blockStart.content_block.type).toBe("text");

    const textDeltas = events.filter(
      (e) =>
        e.event === "content_block_delta" &&
        (e.data as { delta: { type: string } }).delta.type === "text_delta",
    );
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);
    const joined = textDeltas
      .map((e) => (e.data as { delta: { text: string } }).delta.text)
      .join("");
    expect(joined).toContain("marco");

    expect(types).toContain("content_block_stop");

    const msgDelta = events.find((e) => e.event === "message_delta")?.data as {
      delta: { stop_reason: string };
      usage: { output_tokens: number };
    };
    expect(msgDelta.delta.stop_reason).toBe("end_turn");
    expect(msgDelta.usage.output_tokens).toBeGreaterThan(0);

    expect(types.at(-1)).toBe("message_stop");
  });

  test("streaming tool use emits tool_use blocks and no text deltas", async () => {
    const srv = await scriptedServer("tool-stream", TOOL_REPLY);
    try {
      const res = await fetch(`${srv.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "weather in Paris?" }],
          tools: [
            {
              name: "get_weather",
              input_schema: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      const types = events.map((e) => e.event);

      const toolStart = events.find(
        (e) =>
          e.event === "content_block_start" &&
          (e.data as { content_block: { type: string } }).content_block.type === "tool_use",
      )?.data as { content_block: { type: string; id: string; name: string } };
      expect(toolStart.content_block.id).toBeTruthy();
      expect(toolStart.content_block.name).toBe("get_weather");

      const jsonDelta = events.find(
        (e) =>
          e.event === "content_block_delta" &&
          (e.data as { delta: { type: string } }).delta.type === "input_json_delta",
      )?.data as { delta: { partial_json: string } };
      expect(JSON.parse(jsonDelta.delta.partial_json)).toEqual({ city: "Paris" });

      const textDeltas = events.filter(
        (e) =>
          e.event === "content_block_delta" &&
          (e.data as { delta: { type: string } }).delta.type === "text_delta",
      );
      expect(textDeltas).toHaveLength(0);

      const msgDelta = events.find((e) => e.event === "message_delta")?.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe("tool_use");
      expect(types.at(-1)).toBe("message_stop");
    } finally {
      await srv.cleanup();
    }
  });

  test("streamed text is never reinterpreted as tool calls mid-stream", async () => {
    // Non-buffered streaming (no tools): a non-final prose reply streams as a
    // text delta, then the final reply is a fenced tool_call block. parseReply
    // would classify that final content as tool_calls, but because text deltas
    // already went out, the route must keep the text interpretation: one text
    // block opened and closed, no tool_use, end_turn.
    const bridge = new Bridge({
      storeDir: `${storeDir}-late-tool`,
      supervisorFactory: () =>
        new ScriptedSupervisor((ctx) => {
          ctx.emit({
            type: "agent.reply",
            sessionId: ctx.sessionId,
            content: "checking...",
            final: false,
          });
          ctx.emit({
            type: "agent.reply",
            sessionId: ctx.sessionId,
            content: TOOL_REPLY,
            final: true,
          });
        }),
    });
    const p = new SessionPool({ bridge, size: 1 });
    await p.start();
    const s = await startApiServer({ pool: p, host: "127.0.0.1", port: 0, turnTimeoutMs: 10_000 });
    try {
      const res = await fetch(`${s.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      const types = events.map((e) => e.event);

      // No tool_use block ever opened.
      const toolStart = events.find(
        (e) =>
          e.event === "content_block_start" &&
          (e.data as { content_block: { type: string } }).content_block.type === "tool_use",
      );
      expect(toolStart).toBeUndefined();

      // Exactly one text block opened and one closed.
      const textStarts = events.filter(
        (e) =>
          e.event === "content_block_start" &&
          (e.data as { content_block: { type: string } }).content_block.type === "text",
      );
      expect(textStarts).toHaveLength(1);
      expect(types.filter((t) => t === "content_block_stop")).toHaveLength(1);

      const msgDelta = events.find((e) => e.event === "message_delta")?.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe("end_turn");
      expect(types.at(-1)).toBe("message_stop");
    } finally {
      await s.stop();
      await p.close();
      await rm(`${storeDir}-late-tool`, { recursive: true, force: true });
    }
  });

  test("mid-stream error frame terminates the stream", async () => {
    const bridge = new Bridge({
      storeDir: `${storeDir}-mid-error`,
      supervisorFactory: () => new SilentSupervisor(),
    });
    const p = new SessionPool({ bridge, size: 1 });
    await p.start();
    const s = await startApiServer({ pool: p, host: "127.0.0.1", port: 0, turnTimeoutMs: 50 });
    try {
      const res = await fetch(`${s.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "marco" }],
        }),
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      expect(events[0]?.event).toBe("message_start");
      const errorFrame = events.find((e) => e.event === "error");
      expect(errorFrame).toBeDefined();
      const data = errorFrame?.data as { type: string; error: { type: string } };
      expect(data.type).toBe("error");
      expect(data.error.type).toBe("api_error");
    } finally {
      await s.stop();
      await p.close();
      await rm(`${storeDir}-mid-error`, { recursive: true, force: true });
    }
  });

  test("mid-stream crash after a partial text delta closes the open block before the error frame", async () => {
    // A non-final prose reply streams a text delta (opening a content block),
    // then the session crashes. The route must close the open block
    // (content_block_stop) before emitting the error frame, and must not emit
    // message_stop.
    const bridge = new Bridge({
      storeDir: `${storeDir}-mid-crash`,
      supervisorFactory: () =>
        new ScriptedSupervisor((ctx) => {
          ctx.emit({
            type: "agent.reply",
            sessionId: ctx.sessionId,
            content: "partial",
            final: false,
          });
          ctx.emit({ type: "session.ended", sessionId: ctx.sessionId, reason: "crash" });
        }),
    });
    const p = new SessionPool({ bridge, size: 1 });
    await p.start();
    const s = await startApiServer({ pool: p, host: "127.0.0.1", port: 0, turnTimeoutMs: 10_000 });
    try {
      const res = await fetch(`${s.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      const types = events.map((e) => e.event);

      const errorIdx = types.indexOf("error");
      expect(errorIdx).toBeGreaterThan(-1);

      // The open text block is closed BEFORE the error frame.
      const startIdx = types.indexOf("content_block_start");
      const deltaIdx = types.findIndex(
        (t, i) =>
          t === "content_block_delta" &&
          (events[i]?.data as { delta: { type: string } }).delta.type === "text_delta",
      );
      const stopIdx = types.indexOf("content_block_stop");
      expect(startIdx).toBeGreaterThan(-1);
      expect(deltaIdx).toBeGreaterThan(startIdx);
      expect(stopIdx).toBeGreaterThan(deltaIdx);
      expect(stopIdx).toBeLessThan(errorIdx);

      // No message_stop on the error path.
      expect(types).not.toContain("message_stop");
    } finally {
      await s.stop();
      await p.close();
      await rm(`${storeDir}-mid-crash`, { recursive: true, force: true });
    }
  });

  test("streaming tool input partial_json parses to an object", async () => {
    const srv = await scriptedServer("tool-stream-objinput", TOOL_REPLY);
    try {
      const res = await fetch(`${srv.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "weather in Paris?" }],
          tools: [{ name: "get_weather", input_schema: { type: "object" } }],
        }),
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      const jsonDelta = events.find(
        (e) =>
          e.event === "content_block_delta" &&
          (e.data as { delta: { type: string } }).delta.type === "input_json_delta",
      )?.data as { delta: { partial_json: string } };
      const parsed = JSON.parse(jsonDelta.delta.partial_json);
      expect(typeof parsed).toBe("object");
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).not.toBeNull();
    } finally {
      await srv.cleanup();
    }
  });

  test("agent.done-only turn opens and closes an empty text block", async () => {
    const bridge = new Bridge({
      storeDir: `${storeDir}-done-only`,
      supervisorFactory: () =>
        new ScriptedSupervisor((ctx) => {
          ctx.emit({ type: "agent.done", sessionId: ctx.sessionId });
        }),
    });
    const p = new SessionPool({ bridge, size: 1 });
    await p.start();
    const s = await startApiServer({ pool: p, host: "127.0.0.1", port: 0, turnTimeoutMs: 10_000 });
    try {
      const res = await fetch(`${s.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          max_tokens: 1024,
          stream: true,
          messages: [{ role: "user", content: "marco" }],
        }),
      });
      expect(res.status).toBe(200);
      const events = parseSse(await res.text());
      const types = events.map((e) => e.event);

      expect(types[0]).toBe("message_start");
      // Text block opened (the no-delta fallback) but carries no text_delta.
      expect(types.filter((t) => t === "content_block_start")).toHaveLength(1);
      const textDeltas = events.filter(
        (e) =>
          e.event === "content_block_delta" &&
          (e.data as { delta: { type: string } }).delta.type === "text_delta",
      );
      expect(textDeltas).toHaveLength(0);
      expect(types.filter((t) => t === "content_block_stop")).toHaveLength(1);
      const msgDelta = events.find((e) => e.event === "message_delta")?.data as {
        delta: { stop_reason: string };
      };
      expect(msgDelta.delta.stop_reason).toBe("end_turn");
      expect(types.at(-1)).toBe("message_stop");
    } finally {
      await s.stop();
      await p.close();
      await rm(`${storeDir}-done-only`, { recursive: true, force: true });
    }
  });

  test("invalid body is a 400 in the anthropic error envelope", async () => {
    const res = await post("/v1/messages", { model: "m" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("malformed JSON is a 400 in the anthropic error envelope", async () => {
    const res = await fetch(`${server.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("turn timeout maps to 504 api_error envelope", async () => {
    const bridge = new Bridge({
      storeDir: `${storeDir}-silent`,
      supervisorFactory: () => new SilentSupervisor(),
    });
    const silentPool = new SessionPool({ bridge, size: 1 });
    await silentPool.start();
    const silentServer = await startApiServer({
      pool: silentPool,
      host: "127.0.0.1",
      port: 0,
      turnTimeoutMs: 50,
    });
    try {
      const res = await fetch(`${silentServer.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          max_tokens: 1024,
          messages: [{ role: "user", content: "marco" }],
        }),
      });
      expect(res.status).toBe(504);
      const body = (await res.json()) as { type: string; error: { type: string } };
      expect(body.type).toBe("error");
      expect(body.error.type).toBe("api_error");
    } finally {
      await silentServer.stop();
      await silentPool.close();
      await rm(`${storeDir}-silent`, { recursive: true, force: true });
    }
  });
});

describe("auth on /v1/messages", () => {
  let authedPool: SessionPool;
  let authed: Awaited<ReturnType<typeof startApiServer>>;

  beforeEach(async () => {
    const bridge = new Bridge({
      storeDir: `${storeDir}-auth`,
      supervisorFactory: mockSupervisorFactory(),
    });
    authedPool = new SessionPool({ bridge, size: 1 });
    await authedPool.start();
    authed = await startApiServer({
      pool: authedPool,
      host: "127.0.0.1",
      port: 0,
      turnTimeoutMs: 10_000,
      apiKey: "sekrit",
    });
  });

  afterEach(async () => {
    await authed.stop();
    await authedPool.close();
    await rm(`${storeDir}-auth`, { recursive: true, force: true });
  });

  test("x-api-key authorizes /v1/messages", async () => {
    const res = await fetch(`${authed.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sekrit" },
      body: JSON.stringify({
        model: "ccb-claude",
        max_tokens: 1024,
        messages: [{ role: "user", content: "marco" }],
      }),
    });
    expect(res.status).toBe(200);
  });

  test("missing/wrong key on /v1/messages is 401 anthropic envelope", async () => {
    const res = await fetch(`${authed.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "wrong" },
      body: JSON.stringify({
        model: "ccb-claude",
        max_tokens: 1024,
        messages: [{ role: "user", content: "marco" }],
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string } };
    expect(body.type).toBe("error");
    expect(body.error.type).toBe("authentication_error");
  });

  test("OpenAI route still accepts the bearer key", async () => {
    const res = await fetch(`${authed.url}/v1/models`, {
      headers: { authorization: "Bearer sekrit" },
    });
    expect(res.status).toBe(200);
  });
});
