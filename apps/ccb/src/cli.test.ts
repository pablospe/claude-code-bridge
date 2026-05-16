import { expect, test } from "bun:test";

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

test("ccb --help prints usage and lists demo and mcp-config commands", async () => {
  const { exitCode, stdout } = await runCli(["--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/Usage:/);
  expect(stdout).toMatch(/\bdemo\b/);
  expect(stdout).toMatch(/\bmcp-config\b/);
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
  expect(stdout).toMatch(/--supervisor/);
  expect(stdout).toMatch(/--store-dir/);
  expect(stdout).toMatch(/--timeout-ms/);
});

test("ccb mcp-config --help lists session-id, endpoint, out flags", async () => {
  const { exitCode, stdout } = await runCli(["mcp-config", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/--session-id/);
  expect(stdout).toMatch(/--endpoint/);
  expect(stdout).toMatch(/--out/);
});
