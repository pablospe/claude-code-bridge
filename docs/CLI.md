# `ccb` CLI reference

The CLI lives at `apps/ccb/src/cli.ts`. Invoke it via `bun apps/ccb/src/cli.ts <command>` (or wire `bunx ccb` after publishing).

## `ccb demo <input>`

Runs a full turn through `Bridge` using the in-process `MockSupervisor`. Sends `<input>`, waits for the mock to emit a final `agent.reply`, closes the session.

Flags:

- `--format <json|pretty|stream>` (default `pretty`)
- `--store-dir <path>` (default `.ccb-data`)
- `--timeout-ms <ms>` (default `10000`)
- `--supervisor <mock|claude>` (default `mock`) — choose between in-process MockSupervisor and the managed `claude` launch.
- `--channels <dev-flag|plugin>` (default `dev-flag`, ignored for `--supervisor=mock`) — selects the claude channels mode. `dev-flag` uses `--dangerously-load-development-channels server:ccb`; `plugin` uses `--channels plugin:ccb@ccb-local`.

```bash
bun apps/ccb/src/cli.ts demo "ping" --format json
```

```bash
bun apps/ccb/src/cli.ts demo --supervisor=claude --channels=dev-flag "ping"
```

## `ccb mcp-config --endpoint <host:port>`

Emits the `.mcp.json` document Claude Code expects via `--mcp-config`.

Flags:

- `--endpoint <host:port>` (required)
- `--session-id <id>` (defaults to a random UUID)
- `--out <path>` (write to file instead of stdout)

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

## `ccb serve --endpoint <host:port>`

Hosts the bridge control endpoint and streams its event log to stdout. The channel server `claude` spawns will dial this endpoint over loopback TCP. Press Ctrl-C to tear down.

Flags:

- `--endpoint <host:port>` (required)
- `--session-id <id>` (defaults to a random UUID)
- `--store-dir <path>` (default `.ccb-data`)
- `--format <json|pretty>` (default `pretty`)

## Where to go next

- [`SMOKE.md`](./SMOKE.md) — the real-`claude` smoke procedure (managed-launch single-command path and the three-terminal manual fallback).
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — how the commands fit into the larger bridge / channel-server / claude topology.
