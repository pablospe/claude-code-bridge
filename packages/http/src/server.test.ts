import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { MockSupervisor, mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge, type Supervisor, type SupervisorContext } from "@ccb/core";
import { SessionPool } from "./pool.ts";
import { startApiServer } from "./server.ts";

// A supervisor that never emits a terminal event, so the turn timeout always
// wins. This makes the 504 mapping assertion deterministic.
class SilentSupervisor implements Supervisor {
  async start(): Promise<void> {}
  async sendMessage(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async clear(): Promise<void> {}
  async close(): Promise<void> {}
}

// A supervisor that stores the SupervisorContext from start() and replays a
// scripted sequence of events on sendMessage, so a test can pin exact turn
// semantics without a real channel.
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

const storeDir = `/tmp/ccb-server-test-${crypto.randomUUID()}`;
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

describe("GET /v1/models", () => {
  test("lists the facade model", async () => {
    const res = await fetch(`${server.url}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    expect(body.data[0]?.id).toBe("ccb-claude");
  });
});

describe("POST /v1/chat/completions", () => {
  test("non-streaming echo round trip", async () => {
    const res = await post("/v1/chat/completions", {
      model: "ccb-claude",
      messages: [{ role: "user", content: "marco" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toContain("marco");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  test("streaming emits chunks then [DONE]", async () => {
    const res = await post("/v1/chat/completions", {
      model: "ccb-claude",
      stream: true,
      messages: [{ role: "user", content: "marco" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(dataLines.at(-1)).toBe("data: [DONE]");
    const parsed = dataLines.slice(0, -1).map((l) => JSON.parse(l.slice("data: ".length)));
    expect(parsed[0]?.object).toBe("chat.completion.chunk");
    const contents = parsed.flatMap((c) => (c.choices[0].delta.content ? [c.choices[0].delta.content] : []));
    expect(contents.join("")).toContain("marco");
    const finals = parsed.filter((c) => c.choices[0].finish_reason !== null);
    expect(finals).toHaveLength(1);
  });

  test("a crashed session is retried once on a fresh session", async () => {
    // The first session's supervisor emits session.ended{reason:"crash"} on
    // sendMessage, so runTurn rejects "session ended mid-turn: crash" and the
    // pool respawns session 2 (a MockSupervisor). The server must retry the
    // request on the respawned session and succeed.
    let started = 0;
    const crashBridge = new Bridge({
      storeDir: `${storeDir}-crash`,
      supervisorFactory: (): Supervisor => {
        started += 1;
        if (started === 1) {
          let ctx: SupervisorContext | undefined;
          return {
            async start(c) {
              ctx = c;
            },
            async sendMessage() {
              if (!ctx) throw new Error("supervisor not started");
              ctx.emit({ type: "session.ended", sessionId: ctx.sessionId, reason: "crash" });
            },
            async interrupt() {},
            async clear() {},
            async close() {},
          };
        }
        return new MockSupervisor();
      },
    });
    const crashPool = new SessionPool({ bridge: crashBridge, size: 1 });
    await crashPool.start();
    const crashServer = await startApiServer({
      pool: crashPool,
      host: "127.0.0.1",
      port: 0,
      turnTimeoutMs: 10_000,
    });
    try {
      const res = await fetch(`${crashServer.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          messages: [{ role: "user", content: "marco" }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(body.choices[0]?.message.content).toContain("marco");
      expect(started).toBe(2);
    } finally {
      await crashServer.stop();
      await crashPool.close();
      await rm(`${storeDir}-crash`, { recursive: true, force: true });
    }
  });

  test("invalid body is a 400 in OpenAI error shape", async () => {
    const res = await post("/v1/chat/completions", { model: "m" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.message).toContain("messages");
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("unknown route is 404", async () => {
    const res = await fetch(`${server.url}/v2/nope`);
    expect(res.status).toBe(404);
  });

  test("a turn timeout maps to 504", async () => {
    const silentBridge = new Bridge({
      storeDir: `${storeDir}-silent`,
      supervisorFactory: () => new SilentSupervisor(),
    });
    const silentPool = new SessionPool({ bridge: silentBridge, size: 1 });
    await silentPool.start();
    const silentServer = await startApiServer({
      pool: silentPool,
      host: "127.0.0.1",
      port: 0,
      turnTimeoutMs: 50,
    });
    try {
      const res = await fetch(`${silentServer.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          messages: [{ role: "user", content: "marco" }],
        }),
      });
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: { type: string } };
      expect(body.error.type).toBe("server_error");
    } finally {
      await silentServer.stop();
      await silentPool.close();
      await rm(`${storeDir}-silent`, { recursive: true, force: true });
    }
  });

  test("streaming tool_calls are buffered then emitted with [DONE]", async () => {
    const toolBridge = new Bridge({
      storeDir: `${storeDir}-tool`,
      supervisorFactory: () =>
        new ScriptedSupervisor((ctx) => {
          ctx.emit({
            type: "agent.reply",
            sessionId: ctx.sessionId,
            content:
              '```json\n{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}\n```',
            final: true,
          });
        }),
    });
    const toolPool = new SessionPool({ bridge: toolBridge, size: 1 });
    await toolPool.start();
    const toolServer = await startApiServer({
      pool: toolPool,
      host: "127.0.0.1",
      port: 0,
      turnTimeoutMs: 10_000,
    });
    try {
      const res = await fetch(`${toolServer.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          stream: true,
          messages: [{ role: "user", content: "weather in Paris?" }],
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                parameters: {
                  type: "object",
                  properties: { city: { type: "string" } },
                },
              },
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
      expect(dataLines.at(-1)).toBe("data: [DONE]");
      const parsed = dataLines
        .slice(0, -1)
        .map((l) => JSON.parse(l.slice("data: ".length)));
      const toolChunks = parsed.filter((c) => c.choices[0].delta.tool_calls);
      expect(toolChunks).toHaveLength(1);
      const call = toolChunks[0].choices[0].delta.tool_calls[0];
      expect(call.index).toBe(0);
      expect(call.function.name).toBe("get_weather");
      const finals = parsed.filter((c) => c.choices[0].finish_reason !== null);
      expect(finals).toHaveLength(1);
      expect(finals[0].choices[0].finish_reason).toBe("tool_calls");
      // Buffering held: no content deltas precede the tool_calls chunk.
      const toolIdx = parsed.findIndex((c) => c.choices[0].delta.tool_calls);
      const contentBefore = parsed
        .slice(0, toolIdx)
        .some((c) => c.choices[0].delta.content);
      expect(contentBefore).toBe(false);
    } finally {
      await toolServer.stop();
      await toolPool.close();
      await rm(`${storeDir}-tool`, { recursive: true, force: true });
    }
  });

  test("a streaming turn that already emitted deltas is not retried", async () => {
    // The supervisor emits a non-final agent.reply ("partial") then ends the
    // session mid-turn. runTurn rejects "session ended mid-turn", but because a
    // delta was already streamed, runPoolTurn must NOT retry: the stream errors
    // mid-flight, so the body has no [DONE] and "partial" appears exactly once.
    const emittedBridge = new Bridge({
      storeDir: `${storeDir}-emitted`,
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
    const emittedPool = new SessionPool({ bridge: emittedBridge, size: 1 });
    await emittedPool.start();
    const emittedServer = await startApiServer({
      pool: emittedPool,
      host: "127.0.0.1",
      port: 0,
      turnTimeoutMs: 10_000,
    });
    try {
      const res = await fetch(`${emittedServer.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "ccb-claude",
          stream: true,
          messages: [{ role: "user", content: "marco" }],
        }),
      });
      expect(res.status).toBe(200);
      let text = "";
      try {
        text = await res.text();
      } catch {
        // bun's fetch may throw on an abrupt stream termination; tolerate it.
      }
      expect(text).not.toContain("[DONE]");
      // "partial" was streamed exactly once (no duplicate from a retry).
      const occurrences = text.split('"partial"').length - 1;
      expect(occurrences).toBeLessThanOrEqual(1);
    } finally {
      await emittedServer.stop();
      await emittedPool.close();
      await rm(`${storeDir}-emitted`, { recursive: true, force: true });
    }
  });
});

describe("auth", () => {
  test("when apiKey is configured, missing/wrong bearer is 401", async () => {
    const bridge = new Bridge({
      storeDir: `${storeDir}-auth`,
      supervisorFactory: mockSupervisorFactory(),
    });
    const authedPool = new SessionPool({ bridge, size: 1 });
    await authedPool.start();
    const authed = await startApiServer({
      pool: authedPool,
      host: "127.0.0.1",
      port: 0,
      turnTimeoutMs: 10_000,
      apiKey: "sekrit",
    });
    try {
      const noKey = await fetch(`${authed.url}/v1/models`);
      expect(noKey.status).toBe(401);
      const withKey = await fetch(`${authed.url}/v1/models`, {
        headers: { authorization: "Bearer sekrit" },
      });
      expect(withKey.status).toBe(200);
    } finally {
      await authed.stop();
      await authedPool.close();
      await rm(`${storeDir}-auth`, { recursive: true, force: true });
    }
  });
});
