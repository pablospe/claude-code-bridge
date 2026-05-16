import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-smoke-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

test(
  "ccb demo drives the full event loop end-to-end against MockSupervisor",
  async () => {
    const child = Bun.spawn({
      cmd: [
        "bun",
        CLI_PATH,
        "demo",
        "smoke test",
        "--format",
        "json",
        "--store-dir",
        storeDir,
        "--timeout-ms",
        "3000",
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new Error(`ccb demo exited ${exitCode}; stderr=${stderr}; stdout=${stdout}`);
    }
    expect(exitCode).toBe(0);

    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
    const types = parsed.map((p) => p.type);

    // Required ordering: session.started precedes message.sent which precedes
    // agent.progress which precedes agent.reply which precedes session.ended.
    const startedIdx = types.indexOf("session.started");
    const sentIdx = types.indexOf("message.sent");
    const progressIdx = types.indexOf("agent.progress");
    const replyIdx = types.indexOf("agent.reply");
    const endedIdx = types.indexOf("session.ended");

    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(sentIdx).toBeGreaterThan(startedIdx);
    expect(progressIdx).toBeGreaterThan(sentIdx);
    expect(replyIdx).toBeGreaterThan(progressIdx);
    expect(endedIdx).toBeGreaterThan(replyIdx);

    const reply = parsed[replyIdx];
    expect(reply?.content).toBe("echo: smoke test");
    expect(reply?.final).toBe(true);
  },
  { timeout: 15_000 },
);
