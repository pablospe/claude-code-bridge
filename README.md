# Claude Code Bridge

A TypeScript library plus developer CLI for driving an interactive Claude Code session from an external UI or orchestrator. Inbound messages travel over a Claude Code channel (`notifications/claude/channel`), outbound replies/progress travel as MCP tool calls (`bridge_reply` / `bridge_progress` / `bridge_done`), and every turn is persisted as an append-only JSONL event log. This repo is not an ACPX replacement and not a universal agent runtime — it exists for the specific case of using an already authenticated interactive `claude` as the runtime. See [PLAN.md](./PLAN.md) for the full design.

## Status

Milestone 1 delivers the protocol shape end-to-end against an in-process mock plus a documented manual smoke against real `claude`.

Working:

- `Bridge` facade, `EventBus`, `JsonlEventStore`, and the `Supervisor` interface (`@ccb/core`).
- MCP channel server with the `claude/channel` experimental capability and the `bridge_reply` / `bridge_progress` / `bridge_done` tools, a loopback TCP control transport, and a `ccb-channel-server` stdio binary (`@ccb/mcp-channel`).
- `MockSupervisor` (in-process supervisor used by `ccb demo`) and `generateMcpConfig` (`@ccb/claude-code`).
- `ccb` CLI with `demo`, `mcp-config`, and `serve` subcommands.
- 127 unit and integration tests, plus `typecheck` and `lint` clean.

Deferred to M2: managed launch of real `claude` (wrapping it in `node-pty` to satisfy its boot-time TTY check; `ClaudeCodeSupervisor` is a stub), HTTP/WebSocket adapter (`packages/http`), and ACP-compatible facade (`packages/acp`).

## Requirements

[Bun](https://bun.sh) is the package manager, test runner, and TypeScript execution path. The real-`claude` smoke path additionally needs Claude Code v2.1.80 or newer, authenticated, launched with `--dangerously-load-development-channels server:ccb` (channels are a research-preview feature — see the [channels reference](https://code.claude.com/docs/en/channels-reference)).

## Install and first run

```bash
git clone <repo-url>
cd claude-code-bridge
bun install
bun test
```

The automated end-to-end demo uses the `MockSupervisor` and needs no external processes:

```bash
bun apps/ccb/src/cli.ts demo "hello world"
```

Expected output (UUIDs vary):

```text
[session.started] d91356a6-ed90-4ee7-8523-4f03f5e5a1bb
[message.sent] 916c268f-b407-4a25-b5e8-251deab5634c "hello world"
[agent.progress] "thinking"
[agent.reply final=true] "echo: hello world"
[session.ended]
```

## CLI commands

The CLI lives at `apps/ccb/src/cli.ts`. Invoke it via `bun apps/ccb/src/cli.ts <command>` (or wire `bunx ccb` after publishing).

### `ccb demo <input>`

Runs a full turn through `Bridge` using the in-process `MockSupervisor`. Sends `<input>`, waits for the mock to emit a final `agent.reply`, closes the session. Flags: `--format <json|pretty|stream>` (default `pretty`), `--store-dir <path>` (default `.ccb-data`), `--timeout-ms <ms>` (default `10000`).

```bash
bun apps/ccb/src/cli.ts demo "ping" --format json
```

### `ccb mcp-config --endpoint <host:port>`

Emits the `.mcp.json` document Claude Code expects via `--mcp-config`. Flags: `--endpoint <host:port>` (required), `--session-id <id>` (defaults to a random UUID), `--out <path>` (write to file instead of stdout).

```json
{
  "mcpServers": {
    "ccb": {
      "command": "bunx",
      "args": ["ccb-channel-server"],
      "env": {
        "CCB_BRIDGE_ENDPOINT": "127.0.0.1:18484",
        "CCB_SESSION_ID": "c6d426e8-2073-4439-9693-78cd78b012d8"
      }
    }
  }
}
```

### `ccb serve --endpoint <host:port>`

Hosts the bridge control endpoint and streams its event log to stdout. The channel server `claude` spawns will dial this endpoint over loopback TCP. Press Ctrl-C to tear down. Flags: `--endpoint <host:port>` (required), `--session-id <id>` (defaults to a random UUID), `--store-dir <path>` (default `.ccb-data`), `--format <json|pretty>` (default `pretty`).

## Real Claude Code smoke

The manual three-terminal walkthrough is documented in [SMOKE.md](./SMOKE.md). Two helpers wrap the steps:

- `scripts/smoke-manual.sh` — mints a session id, writes the per-session `.mcp.json`, prints the exact `claude` command to run in the second terminal, then hosts the bridge in the foreground.
- `scripts/smoke-scripted.ts` — automates the outbound tool path only (claude needs a TTY so the inbound side isn't driven from the script). Gated on `CCB_RUN_REAL_CLAUDE=1` and skips with a notice when `claude` refuses to boot without a TTY.

For users who plan to run ccb frequently, the [plugin install path documented in SMOKE.md](./SMOKE.md#installing-as-a-plugin-no-dev-flag-warning) is preferred: install `ccb@ccb-local` once and launch with `claude --channels plugin:ccb@ccb-local` (no `--dangerously-load-development-channels` flag, no startup warning).

## Architecture

Real-session topology (three processes):

```text
ccb (bridge library + CLI)
  │
  └─ spawn: claude --dangerously-load-development-channels server:ccb
        │
        └─ spawn: ccb channel server (stdio child of claude)
              │
              └─ local control connection back to bridge
```

The bridge and the channel server are siblings under different parents and share a per-session loopback TCP control connection carrying a JSON-lines protocol. Inbound `deliver` frames become `notifications/claude/channel`; outbound MCP tool calls become `BridgeEvent`s on the bus and rows in the JSONL store. See [PLAN.md](./PLAN.md) for the full directional-communication discussion and the rationale for the topology.

## Packages

- `packages/core` (`@ccb/core`) — `Bridge` facade, `EventBus`, `JsonlEventStore`, `Supervisor` interface, public types.
- `packages/mcp-channel` (`@ccb/mcp-channel`) — MCP channel server, control server/client, `ccb-channel-server` stdio binary.
- `packages/claude-code` (`@ccb/claude-code`) — `MockSupervisor`, `generateMcpConfig`, and the `ClaudeCodeSupervisor` managed-launch stub.
- `apps/ccb` (`@ccb/cli`) — developer CLI (`demo`, `mcp-config`, `serve`).

## Library usage

```ts
import { Bridge } from "@ccb/core";
import { mockSupervisorFactory } from "@ccb/claude-code";

const bridge = new Bridge({
  storeDir: ".ccb-data",
  supervisorFactory: mockSupervisorFactory(),
});
const { id } = await bridge.startSession({});
const events = bridge.events(id);
await bridge.sendMessage(id, "hello world");
for await (const ev of events) {
  console.log(ev);
  if (ev.type === "agent.reply" && ev.final) break;
}
await bridge.close(id);
```

Swap `mockSupervisorFactory()` for a real `Supervisor` implementation to drive a real `claude` process.

## Development

The working pattern is test-driven: every change ships with a test that exercises it. Common commands:

```bash
bun test           # run the full test suite (currently 127 tests)
bun run typecheck  # tsc -b across the workspace
bun run lint       # biome check
bun run format     # biome format --write
```

To add a new package, create `packages/<name>/{package.json,src,tsconfig.json}` following the existing pattern, add a project reference in the root `tsconfig.json`, and declare a `workspace:*` dependency from any consumer package.

## Known limitations

- Managed launch is deferred. The bridge does not spawn `claude` itself in M1; the human starts it in a second terminal.
- Channels are a Claude Code research-preview feature, so `--dangerously-load-development-channels server:ccb` is required until `claude/channel` is on the allowlist.
- `claude` exits to `--print` mode when stdout is not a TTY, so there is no fully-headless automated test of the real path. `scripts/smoke-scripted.ts` is best-effort only.
- `EventBus` is unbounded; slow consumers can grow the in-memory queue.
- HTTP/WebSocket and ACP adapters are post-M1.

## License

TBD.
