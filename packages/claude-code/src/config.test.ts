import { expect, test } from "bun:test";
import { ClaudeCodeSupervisor, generateMcpConfig } from "./index.ts";

test("generateMcpConfig returns default ccb mcpServer entry", () => {
  const cfg = generateMcpConfig({ sessionId: "s1", endpoint: "127.0.0.1:8080" });
  expect(cfg).toEqual({
    mcpServers: {
      ccb: {
        command: "bunx",
        args: ["ccb-channel-server"],
        env: {
          CCB_BRIDGE_ENDPOINT: "127.0.0.1:8080",
          CCB_SESSION_ID: "s1",
        },
      },
    },
  });
});

test("generateMcpConfig honors custom command and args", () => {
  const cfg = generateMcpConfig({
    sessionId: "s2",
    endpoint: "[::1]:9000",
    command: "/usr/local/bin/node",
    args: ["./dist/bin.js", "--debug"],
  });
  expect(cfg.mcpServers.ccb.command).toBe("/usr/local/bin/node");
  expect(cfg.mcpServers.ccb.args).toEqual(["./dist/bin.js", "--debug"]);
  expect(cfg.mcpServers.ccb.env).toEqual({
    CCB_BRIDGE_ENDPOINT: "[::1]:9000",
    CCB_SESSION_ID: "s2",
  });
});

test("generateMcpConfig output is JSON-serializable roundtrip", () => {
  const cfg = generateMcpConfig({ sessionId: "s3", endpoint: "127.0.0.1:5555" });
  const roundtrip = JSON.parse(JSON.stringify(cfg));
  expect(roundtrip).toEqual(cfg);
});

test("ClaudeCodeSupervisor.start throws because managed launch is not implemented", async () => {
  const supervisor = new ClaudeCodeSupervisor();
  await expect(
    supervisor.start({
      sessionId: "00000000-0000-0000-0000-000000000000",
      emit: () => {},
    }),
  ).rejects.toThrow(/managed launch is not implemented/);
});
