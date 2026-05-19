# Claude Code Bridge

A TypeScript library + CLI that lets external UIs and orchestrators drive an already-running, already-authenticated Claude Code session — without restarting it, without scraping the terminal, and without talking to the model API directly.

## The idea

Channels for inbound general content; MCP tools for outbound. A consumer pushes a message in via a Claude Code channel (`notifications/claude/channel`); Claude responds by calling one of three MCP tools (`bridge_reply` / `bridge_progress` / `bridge_done`); every turn is persisted as an append-only JSONL event log.

```text
        +----------------------+
        |       Consumer       |
        |  ccb demo, T3 Code,  |
        |      agtx, ...       |
        +----------------------+
           |                ^
           | sendMessage()  | events(sessionId)
           v                |
        +----------------------+
        |        Bridge        |
        |   session state +    |
        |      event log       |
        +----------------------+
           ||               ^^
           || channels      || MCP tools
           || (inbound)     || (outbound)
           vv               ||
        +----------------------+
        |      Claude Code     |
        |   claude --channels  |
        |          ...         |
        +----------------------+
```

This is not an ACPX replacement and not a universal agent runtime. It exists for the specific case where you want an already-authenticated interactive `claude` to be the runtime.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design, process topology, and a library-usage example.

## Status

The protocol shape works end-to-end against an in-process mock and against a real `claude` driven by the bridge's managed launch (the bridge spawns and supervises `claude` itself via `node-pty`; requires `node-pty` to build/load on the host). The earlier two-terminal manual smoke is preserved as a fallback for hosts where `node-pty` cannot load.

## Install

`bun ≥ 1.3` must be on PATH. The bridge is published to npm as
[`claudecode-bridge`](https://www.npmjs.com/package/claudecode-bridge)
(unscoped; the unhyphenated `claude-code-bridge` is taken on npm by a
different author — the GitHub repo name stays `claude-code-bridge`).
Two install paths cover the two ways to use the bridge.

### Library / CLI

```bash
bun add claudecode-bridge          # or npm i, or pnpm add
bunx ccb demo --supervisor=claude "what is 11 squared?"
```

Exposed bins: `ccb`, `ccb-channel-server`, `ccb-hook-relay`, `ccb-launcher`.
The library surface (`import { Bridge, ... } from "claudecode-bridge"`) is
ESM-only; CJS consumers are not supported.

### Claude Code plugin (tool-event visibility out of the box)

The plugin manifest invokes bins by name and relies on a prior global
install so claude's hook subsystem can spawn them without a shell PATH
hunt:

```bash
bun add -g claudecode-bridge
```

Then from inside a `claude` session:

```text
/plugin marketplace add https://github.com/pablospe/claude-code-bridge
/plugin install ccb@claude-code-bridge
```

Without the global install, `ccb-channel-server` and `ccb-hook-relay` are
not on PATH and claude reports `command not found` when it tries to spawn
them. After install, every `claude` session registers the ccb MCP server
AND the M3 hook relay automatically; consumers see `tool.event` records
in the bridge event stream from the first turn — alongside `agent.reply`
/ `agent.done`, with Pre/Post pairs correlated by `tool_use_id`. See
[`docs/M3.md`](./docs/M3.md) for the design and
[`docs/SMOKE.md`](./docs/SMOKE.md) for end-to-end verification.

### Development (from a checkout)

For contributors hacking on the bridge itself:

```bash
git clone https://github.com/pablospe/claude-code-bridge
cd claude-code-bridge
bun install
bun test
bun apps/ccb/src/cli.ts demo "hello world"
bun apps/ccb/src/cli.ts demo --supervisor=claude --channels=dev-flag "ping"
```

Expected (UUIDs vary):

```text
[session.started] d91356a6-...
[message.sent] 916c268f-... "hello world"
[agent.progress] "thinking"
[agent.reply final=true] "echo: hello world"
[session.ended]
```

The `--channels=dev-flag` mode skips the plugin path entirely so you can
exercise the bridge against your local source without publishing. If a
contributor specifically wants to exercise the plugin path during
development, run `bun link claudecode-bridge` in the bridge checkout and
`bun link --global claudecode-bridge` in the consumer scope; the plugin
manifest references bin names, so PATH resolution finds the linked bins.

For the full real-`claude` walkthrough — managed launch, plugin install,
and the two-terminal manual fallback — see
[`docs/SMOKE.md`](./docs/SMOKE.md).

## Requirements

- [Bun](https://bun.sh) `≥ 1.3` on PATH. The bridge spawns child
  processes through Bun in some paths, and the published bins are
  bundled with `bun build --target=node` (Node-shebanged) but the
  runtime that spawns them — claude's hook subsystem, the user's shell —
  still needs Bun resolvable for the install and dev paths above. Pure-
  Node hosts are tracked separately (see the project's `npx-runtime`
  branch).
- For the real-`claude` path: Claude Code v2.1.80 or newer,
  authenticated, with the channels research-preview enabled. See
  [`docs/SMOKE.md`](./docs/SMOKE.md) for both the development-flag and
  plugin-install paths.

## Where to go next

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — full design, process topology, library-usage example, and channel-direction nuance.
- [`docs/CLI.md`](./docs/CLI.md) — `ccb` CLI command reference (`demo`, `mcp-config`, `serve`).
- [`docs/SMOKE.md`](./docs/SMOKE.md) — real-`claude` verification procedure.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — milestones, planned work, and consumer-gated follow-ups.

## License

[MIT](./LICENSE).
