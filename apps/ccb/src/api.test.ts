import { expect, test } from "bun:test";
import { runApi } from "./api.ts";

test("POST /v1/chat/completions round-trips a turn through the bridge", async () => {
  const api = await runApi({
    host: "127.0.0.1",
    port: 0,
    poolSize: 1,
    turnTimeoutMs: 10_000,
    supervisor: "mock",
    storeDir: `/tmp/ccb-api-test-${crypto.randomUUID()}`,
  });
  try {
    const res = await fetch(`${api.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ccb-claude",
        messages: [{ role: "user", content: "hello world" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.role).toBe("assistant");
    // MockSupervisor replies "echo: <delivered content>"; the delivered content
    // is the rendered transcript, which embeds the user text.
    expect(body.choices[0]?.message.content).toContain("hello world");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  } finally {
    await api.stop();
  }
});
