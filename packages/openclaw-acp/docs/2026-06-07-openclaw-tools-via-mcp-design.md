# Design: give the bridged `claude` OpenClaw's tools via MCP (reuse, don't rebuild)

**Status:** design + task list (not yet implemented). 2026-06-07.

## Goal
Let the bridged interactive `claude` (the reasoner, on the Max sub) **use OpenClaw's own tools**
(cron, memory, web, channel actions, …) — so OpenClaw's capabilities are available without making
OpenClaw the reasoner (impossible on Max quota; the interactive session IS the agent). The reasoning
stays in `claude`; OpenClaw's tools become MCP tools `claude` can call.

## Key finding: OpenClaw already serves its tools over MCP — reuse it
- `openclaw/src/mcp/openclaw-tools-serve.ts` — a standalone **stdio MCP server** of built-in OpenClaw
  tools. `resolveOpenClawToolsForMcp()` currently returns only `createCronTool()`; extend it to expose more.
- `openclaw/src/mcp/tools-stdio-server.ts` — `createToolsMcpServer({ name, tools })`: wrap ANY OpenClaw
  `AnyAgentTool[]` as an MCP server.
- `openclaw/src/mcp/channel-bridge.ts` / `channel-tools.ts` — exposes OpenClaw **channel actions**
  (chat history, approvals, send) over MCP (the `openclaw mcp` "channel bridge").
- Precedent: `extensions/acpx/src/runtime-internals/mcp-proxy.mjs` — acpx already injects OpenClaw tools
  into its ACP agents (claude/codex) via an MCP proxy.

So: **no new MCP server from scratch.** Reuse `openclaw-tools-serve` (+ extend the tool list) and/or
`channel-bridge`, and wire it into the `claude` launch.

## Approach
ccb's supervisor already launches `claude` with `--mcp-config <mcp.json> --strict-mcp-config` (the ccb
channel server). Add the OpenClaw tools server as a **second entry in that same `mcp.json`** (must be the
same file because `--strict-mcp-config` restricts MCP to it). Then `claude` gets: ccb channel (relay in/out)
+ OpenClaw tools (cron/memory/web/channel).

Two code seams:
1. **ccb supervisor** — accept an `extraMcpServers` option and merge it into the generated `mcp.json`'s
   `mcpServers` (alongside `ccb`). Pure addition; default = none (behavior unchanged).
2. **openclaw-acp plugin** — populate `extraMcpServers` with an entry that runs OpenClaw's tools MCP server
   (e.g. `command: <bun>`, `args: [<path to openclaw-tools-serve>]`), using `ctx` to locate it.

### Sketch — ccb `claudeCodeSupervisorFactory` / supervisor
```ts
// options
interface ClaudeCodeSupervisorOptions {
  channels: ChannelsMode;
  hooks?: { events: HookEvent[] };
  extraMcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string,string> }>;
}
// in start(), when building mcp.json:
const config = generateMcpConfig({ sessionId, endpoint: endpoint.endpoint,
  command: channelRuntimeCommand, args: [channelBin] });
for (const [name, srv] of Object.entries(this.#extraMcpServers ?? {})) {
  config.mcpServers[name] = srv;   // merged into the SAME strict-mcp-config file
}
```

### Sketch — openclaw-acp `index.ts`
```ts
supervisorFactory: claudeCodeSupervisorFactory({
  channels, hooks: { events: DEFAULT_HOOKS },
  extraMcpServers: {
    "openclaw-tools": {
      command: process.env.CCB_CHANNEL_RUNTIME || process.execPath, // bun for node-compat
      args: [resolveOpenClawToolsServePath(ctx)],   // path to openclaw-tools-serve (bin or dist)
      // env: pass gateway URL/token if the tools need to call back into OpenClaw
    },
  },
}),
```

### Extend what's exposed (OpenClaw side)
- Minimal first proof: keep `resolveOpenClawToolsForMcp()` = `[createCronTool()]` → prove `claude` can call
  OpenClaw's cron tool.
- Then add memory / web / channel-send tools to that list (or wire `channel-bridge` for channel actions).
  Tools that act on the gateway need the gateway client/URL+token in their env.

## Tasks
- [ ] T1. Add `extraMcpServers` to `ClaudeCodeSupervisorOptions` + thread into `generateMcpConfig` merge
      (`packages/claude-code/src/claude-supervisor.ts`). Unit test: extra entry appears in mcp.json.
- [ ] T2. `openclaw-acp` `index.ts`: resolve the OpenClaw tools-serve entrypoint and pass `extraMcpServers`
      with the `openclaw-tools` server. Decide how to locate `openclaw-tools-serve` (bundled path vs the
      host openclaw install) and which runtime to launch it with (reuse `CCB_CHANNEL_RUNTIME`).
- [ ] T3. First proof: confirm the bridged `claude` lists + calls the **cron** tool over Telegram/TUI.
- [ ] T4. Extend `resolveOpenClawToolsForMcp()` (or add `channel-bridge`) to expose memory + web + channel
      send; pass any required gateway auth via the server's env.
- [ ] T5. Allowed-tools: the bridge launches claude with `--allowed-tools mcp__ccb__*`; extend the allowed
      set to include the new `mcp__openclaw-tools__*` names so claude may actually call them.
- [ ] T6. Tests + docs; note the `--strict-mcp-config` constraint (extra servers MUST be in the same file).

## Open questions / caveats
- **Locating `openclaw-tools-serve`**: the plugin runs inside the OpenClaw process; can it import/serve the
  tools in-process instead of spawning a separate node? (Cleaner — investigate a `createToolsMcpServer`
  in-process attached to the same control transport.)
- **`--allowed-tools`** must be widened or claude won't be permitted to call the new tools (T5).
- **Auth/permissions**: tools that mutate (channel send, memory write) run unattended (no approval relay
  until ccb M5) — scope deliberately.
- **node-compat**: the OpenClaw tools server, if spawned, has the same Node-vs-bun concern as the channel
  server — reuse `CCB_CHANNEL_RUNTIME`.
