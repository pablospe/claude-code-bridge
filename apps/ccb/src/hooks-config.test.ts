import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHooksConfig } from "./hooks-config.ts";

const CLI_PATH = new URL("./cli.ts", import.meta.url).pathname;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ccb-hooks-config-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface ParsedHooksSettings {
  hooks: Record<
    string,
    Array<{
      hooks: Array<{ type: "command"; command: string }>;
    }>
  >;
}

test("runHooksConfig returns a JSON-parseable string with the expected shape (default events)", async () => {
  const output = await runHooksConfig({ events: ["PreToolUse", "PostToolUse", "Stop"] });
  const parsed = JSON.parse(output) as ParsedHooksSettings;
  expect(Object.keys(parsed.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
  expect(parsed.hooks.PreToolUse?.[0]?.hooks[0]).toEqual({
    type: "command",
    command: "bunx ccb-hook-relay PreToolUse",
  });
});

test("runHooksConfig honors a custom subset of events", async () => {
  const output = await runHooksConfig({ events: ["Stop"] });
  const parsed = JSON.parse(output) as ParsedHooksSettings;
  expect(Object.keys(parsed.hooks)).toEqual(["Stop"]);
});

test("runHooksConfig writes to --out path and resolves to that path", async () => {
  const outPath = join(workDir, "settings.json");
  const result = await runHooksConfig({
    events: ["PreToolUse"],
    out: outPath,
  });
  expect(result).toBe(outPath);
  const text = await readFile(outPath, "utf8");
  const parsed = JSON.parse(text) as ParsedHooksSettings;
  expect(parsed.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("bunx ccb-hook-relay PreToolUse");
});

test("ccb hooks-config writes JSON to stdout with all three default events", async () => {
  const child = Bun.spawn({
    cmd: ["bun", CLI_PATH, "hooks-config"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`ccb hooks-config exited ${exitCode}; stderr=${stderr}`);
  }
  const parsed = JSON.parse(stdout) as ParsedHooksSettings;
  expect(Object.keys(parsed.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
});

test("ccb hooks-config --events PreToolUse,Stop emits only those events", async () => {
  const child = Bun.spawn({
    cmd: ["bun", CLI_PATH, "hooks-config", "--events", "PreToolUse,Stop"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  expect(exitCode).toBe(0);
  const parsed = JSON.parse(stdout) as ParsedHooksSettings;
  expect(Object.keys(parsed.hooks).sort()).toEqual(["PreToolUse", "Stop"]);
});

test("ccb hooks-config --events with an unknown event exits non-zero", async () => {
  const child = Bun.spawn({
    cmd: ["bun", CLI_PATH, "hooks-config", "--events", "PreToolUse,Bogus"],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  expect(exitCode).not.toBe(0);
  expect(stderr.toLowerCase()).toMatch(/events|bogus/);
});

test("ccb hooks-config --out writes to the file and prints the path", async () => {
  const outPath = join(workDir, "settings.json");
  const child = Bun.spawn({
    cmd: ["bun", CLI_PATH, "hooks-config", "--out", outPath],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(outPath);
  const text = await readFile(outPath, "utf8");
  const parsed = JSON.parse(text) as ParsedHooksSettings;
  expect(Object.keys(parsed.hooks).sort()).toEqual(["PostToolUse", "PreToolUse", "Stop"]);
});
