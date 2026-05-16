import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

async function runCli(args: readonly string[]): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn({
    cmd: ["bun", CLI_PATH, ...args],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "ccb-cli-"));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

test("ccb --help prints usage and lists demo, mcp-config, and serve commands", async () => {
  const { exitCode, stdout } = await runCli(["--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/Usage:/);
  expect(stdout).toMatch(/\bdemo\b/);
  expect(stdout).toMatch(/\bmcp-config\b/);
  expect(stdout).toMatch(/\bserve\b/);
});

test("ccb --version prints a version string", async () => {
  const { exitCode, stdout } = await runCli(["--version"]);
  expect(exitCode).toBe(0);
  expect(stdout.trim().length).toBeGreaterThan(0);
});

test("ccb demo --help lists supported flags", async () => {
  const { exitCode, stdout } = await runCli(["demo", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/--format/);
  expect(stdout).toMatch(/--store-dir/);
  expect(stdout).toMatch(/--timeout-ms/);
  expect(stdout).not.toMatch(/--supervisor/);
});

test("ccb mcp-config --help lists session-id, endpoint, out flags", async () => {
  const { exitCode, stdout } = await runCli(["mcp-config", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/--session-id/);
  expect(stdout).toMatch(/--endpoint/);
  expect(stdout).toMatch(/--out/);
});

test("ccb serve --help lists endpoint, session-id, store-dir, format flags", async () => {
  const { exitCode, stdout } = await runCli(["serve", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/--endpoint/);
  expect(stdout).toMatch(/--session-id/);
  expect(stdout).toMatch(/--store-dir/);
  expect(stdout).toMatch(/--format/);
});

test(
  "ccb demo --format json prints session.started ... session.ended over stdout",
  async () => {
    const { exitCode, stdout, stderr } = await runCli([
      "demo",
      "hello",
      "--format",
      "json",
      "--store-dir",
      storeDir,
      "--timeout-ms",
      "3000",
    ]);
    if (exitCode !== 0) {
      throw new Error(`ccb demo exited ${exitCode}; stderr=${stderr}`);
    }
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(5);
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
    expect(parsed[0]?.type).toBe("session.started");
    expect(parsed[parsed.length - 1]?.type).toBe("session.ended");
    const reply = parsed.find((p) => p.type === "agent.reply");
    expect(reply).toBeDefined();
    expect(reply?.content).toBe("echo: hello");
    expect(reply?.final).toBe(true);
  },
  { timeout: 15_000 },
);

test(
  "ccb demo --format stream emits json lines live",
  async () => {
    const { exitCode, stdout } = await runCli([
      "demo",
      "stream me",
      "--format",
      "stream",
      "--store-dir",
      storeDir,
      "--timeout-ms",
      "3000",
    ]);
    expect(exitCode).toBe(0);
    const lines = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
    const types = parsed.map((p) => p.type);
    expect(types).toContain("session.started");
    expect(types).toContain("message.sent");
    expect(types).toContain("agent.reply");
    expect(types).toContain("session.ended");
  },
  { timeout: 15_000 },
);
