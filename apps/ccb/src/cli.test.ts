import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeSupervisor, MockSupervisor } from "@ccb/claude-code";
import { selectSupervisorFactory } from "./cli.ts";

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

test("ccb --version prints the dev fallback when run from source", async () => {
  const { exitCode, stdout } = await runCli(["--version"]);
  expect(exitCode).toBe(0);
  // The real version is injected from the root package.json at build time via
  // `bun build --define` (see scripts/build.ts); source runs get the fallback.
  expect(stdout.trim()).toBe("0.0.0-dev");
});

test("ccb demo --help lists supported flags", async () => {
  const { exitCode, stdout } = await runCli(["demo", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/--format/);
  expect(stdout).toMatch(/--store-dir/);
  expect(stdout).toMatch(/--timeout-ms/);
  expect(stdout).toMatch(/--supervisor <mock\|claude>/);
  expect(stdout).toMatch(/--channels <dev-flag\|plugin>/);
  expect(stdout).toMatch(/--start-timeout-ms <ms>/);
});

test("ccb demo --start-timeout-ms=bogus exits non-zero with a clear error", async () => {
  const { exitCode, stderr } = await runCli([
    "demo",
    "hi",
    "--start-timeout-ms",
    "bogus",
    "--store-dir",
    storeDir,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/start-timeout-ms/i);
});

test("ccb demo --supervisor=bogus exits non-zero with a clear error", async () => {
  const { exitCode, stderr } = await runCli([
    "demo",
    "hi",
    "--supervisor",
    "bogus",
    "--store-dir",
    storeDir,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/supervisor/i);
  expect(stderr.toLowerCase()).toMatch(/mock|claude/);
});

test("ccb demo --channels=bogus exits non-zero with a clear error", async () => {
  const { exitCode, stderr } = await runCli([
    "demo",
    "hi",
    "--channels",
    "bogus",
    "--store-dir",
    storeDir,
  ]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/channels/i);
  expect(stderr.toLowerCase()).toMatch(/dev-flag|plugin/);
});

test("ccb demo --start-timeout-ms 12345 succeeds with the mock supervisor", async () => {
  const { exitCode, stderr } = await runCli([
    "demo",
    "hi",
    "--supervisor",
    "mock",
    "--format",
    "json",
    "--store-dir",
    storeDir,
    "--timeout-ms",
    "3000",
    "--start-timeout-ms",
    "12345",
  ]);
  if (exitCode !== 0) {
    throw new Error(`ccb demo exited ${exitCode}; stderr=${stderr}`);
  }
});

test("ccb demo --supervisor=mock preserves default echo behavior", async () => {
  const { exitCode, stdout, stderr } = await runCli([
    "demo",
    "hello",
    "--supervisor",
    "mock",
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
  const parsed = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string; content?: string });
  const reply = parsed.find((p) => p.type === "agent.reply");
  expect(reply?.content).toBe("echo: hello");
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

test("selectSupervisorFactory('mock') returns a MockSupervisor", () => {
  const factory = selectSupervisorFactory({ supervisor: "mock", channels: "dev-flag" });
  const sup = factory("sess-id");
  expect(sup).toBeInstanceOf(MockSupervisor);
});

test("selectSupervisorFactory('claude', 'dev-flag') returns a ClaudeCodeSupervisor", () => {
  const factory = selectSupervisorFactory({ supervisor: "claude", channels: "dev-flag" });
  const sup = factory("sess-id");
  expect(sup).toBeInstanceOf(ClaudeCodeSupervisor);
});

test("selectSupervisorFactory('claude', 'plugin') returns a ClaudeCodeSupervisor", () => {
  const factory = selectSupervisorFactory({ supervisor: "claude", channels: "plugin" });
  const sup = factory("sess-id");
  expect(sup).toBeInstanceOf(ClaudeCodeSupervisor);
});
