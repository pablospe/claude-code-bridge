import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMcpConfig } from "./mcp-config.ts";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ccb-mcp-config-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface ParsedMcpConfig {
  mcpServers: {
    ccb: {
      command: string;
      args: string[];
      env: {
        CCB_BRIDGE_ENDPOINT: string;
        CCB_SESSION_ID: string;
      };
    };
  };
}

test("runMcpConfig returns a JSON-parseable string with the expected shape", async () => {
  const output = await runMcpConfig({ sessionId: "s1", endpoint: "127.0.0.1:8080" });
  const parsed = JSON.parse(output) as ParsedMcpConfig;
  expect(parsed.mcpServers.ccb.command).toBe("bunx");
  expect(parsed.mcpServers.ccb.args).toEqual(["ccb-channel-server"]);
  expect(parsed.mcpServers.ccb.env.CCB_BRIDGE_ENDPOINT).toBe("127.0.0.1:8080");
  expect(parsed.mcpServers.ccb.env.CCB_SESSION_ID).toBe("s1");
});

test("runMcpConfig writes to --out path and resolves to that path", async () => {
  const outPath = join(workDir, "mcp.json");
  const result = await runMcpConfig({
    sessionId: "s2",
    endpoint: "127.0.0.1:9090",
    out: outPath,
  });
  expect(result).toBe(outPath);
  const text = await readFile(outPath, "utf8");
  const parsed = JSON.parse(text) as ParsedMcpConfig;
  expect(parsed.mcpServers.ccb.env.CCB_BRIDGE_ENDPOINT).toBe("127.0.0.1:9090");
  expect(parsed.mcpServers.ccb.env.CCB_SESSION_ID).toBe("s2");
});

test("ccb mcp-config --endpoint writes JSON to stdout", async () => {
  const child = Bun.spawn({
    cmd: ["bun", CLI_PATH, "mcp-config", "--endpoint", "127.0.0.1:9999"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`ccb mcp-config exited ${exitCode}; stderr=${stderr}`);
  }
  const parsed = JSON.parse(stdout) as ParsedMcpConfig;
  expect(parsed.mcpServers.ccb.env.CCB_BRIDGE_ENDPOINT).toBe("127.0.0.1:9999");
  expect(parsed.mcpServers.ccb.env.CCB_SESSION_ID).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("ccb mcp-config without --endpoint exits non-zero with an endpoint error", async () => {
  const child = Bun.spawn({
    cmd: ["bun", CLI_PATH, "mcp-config"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  expect(exitCode).not.toBe(0);
  expect(stderr.toLowerCase()).toMatch(/endpoint/);
});

test("ccb mcp-config --out writes to the file and prints the path", async () => {
  const outPath = join(workDir, "mcp.json");
  const child = Bun.spawn({
    cmd: [
      "bun",
      CLI_PATH,
      "mcp-config",
      "--endpoint",
      "127.0.0.1:7000",
      "--session-id",
      "fixed-id",
      "--out",
      outPath,
    ],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(outPath);
  const text = await readFile(outPath, "utf8");
  const parsed = JSON.parse(text) as ParsedMcpConfig;
  expect(parsed.mcpServers.ccb.env.CCB_SESSION_ID).toBe("fixed-id");
  expect(parsed.mcpServers.ccb.env.CCB_BRIDGE_ENDPOINT).toBe("127.0.0.1:7000");
});
