import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge } from "@ccb/core";
import { SessionPool } from "./pool.ts";
import { startApiServer } from "./server.ts";

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
