import { expect, test } from "bun:test";
import { generateHooksSettings, generateMcpConfig } from "./index.ts";

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

test("generateHooksSettings: default command emits bunx ccb-hook-relay per event", () => {
  const s = generateHooksSettings({ events: ["PreToolUse", "PostToolUse", "Stop"] });
  expect(s).toEqual({
    hooks: {
      PreToolUse: [
        {
          hooks: [{ type: "command", command: "bunx ccb-hook-relay PreToolUse" }],
        },
      ],
      PostToolUse: [
        {
          hooks: [{ type: "command", command: "bunx ccb-hook-relay PostToolUse" }],
        },
      ],
      Stop: [
        {
          hooks: [{ type: "command", command: "bunx ccb-hook-relay Stop" }],
        },
      ],
    },
  });
});

test("generateHooksSettings: only includes events present in the input", () => {
  const s = generateHooksSettings({ events: ["PreToolUse"] });
  expect(Object.keys(s.hooks)).toEqual(["PreToolUse"]);
  expect(s.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("bunx ccb-hook-relay PreToolUse");
});

test("generateHooksSettings: honors custom command and args (joins with spaces and event name)", () => {
  const s = generateHooksSettings({
    events: ["Stop"],
    command: "/usr/local/bin/bun",
    args: ["/abs/path/hook-relay.ts"],
  });
  expect(s.hooks.Stop?.[0]?.hooks[0]).toEqual({
    type: "command",
    command: "/usr/local/bin/bun /abs/path/hook-relay.ts Stop",
  });
});

test("generateHooksSettings: rejects an empty events array", () => {
  expect(() => generateHooksSettings({ events: [] })).toThrow(/non-empty array/);
});

test("generateHooksSettings: output is JSON-serializable roundtrip", () => {
  const s = generateHooksSettings({ events: ["PreToolUse", "PostToolUse"] });
  expect(JSON.parse(JSON.stringify(s))).toEqual(s);
});

test("generateHooksSettings: shell-quotes a command path with spaces", () => {
  const s = generateHooksSettings({
    events: ["Stop"],
    command: "/Users/John Doe/.bun/bin/bun",
    args: ["/some path/hook-relay.ts"],
  });
  expect(s.hooks.Stop?.[0]?.hooks[0]?.command).toBe(
    "'/Users/John Doe/.bun/bin/bun' '/some path/hook-relay.ts' Stop",
  );
});

test("generateHooksSettings: shell-quotes a command path with single quotes (escape sequence)", () => {
  const s = generateHooksSettings({
    events: ["Stop"],
    command: "/o'malley/bin/bun",
    args: ["relay.ts"],
  });
  expect(s.hooks.Stop?.[0]?.hooks[0]?.command).toBe("'/o'\\''malley/bin/bun' relay.ts Stop");
});

test("generateHooksSettings: shell-quotes shell metacharacters in args", () => {
  // `$(date)` would otherwise execute as command substitution when claude
  // invokes the hook via the shell.
  const s = generateHooksSettings({
    events: ["PreToolUse"],
    command: "bun",
    args: ["$(date).ts"],
  });
  expect(s.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe("bun '$(date).ts' PreToolUse");
});

test("generateMcpConfig sets CCB_PERMISSION_RELAY only when enablePermissionRelay is set", () => {
  const base = generateMcpConfig({ sessionId: "s", endpoint: "tcp://127.0.0.1:1" });
  expect(base.mcpServers.ccb.env.CCB_PERMISSION_RELAY).toBeUndefined();
  const enabled = generateMcpConfig({
    sessionId: "s",
    endpoint: "tcp://127.0.0.1:1",
    enablePermissionRelay: true,
  });
  expect(enabled.mcpServers.ccb.env.CCB_PERMISSION_RELAY).toBe("1");
});
