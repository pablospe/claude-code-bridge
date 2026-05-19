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

## Quick start

```bash
git clone <repo-url>
cd claude-code-bridge
bun install
bun test
bun apps/ccb/src/cli.ts demo "hello world"
```

Expected (UUIDs vary):

```text
[session.started] d91356a6-...
[message.sent] 916c268f-... "hello world"
[agent.progress] "thinking"
[agent.reply final=true] "echo: hello world"
[session.ended]
```

That runs the mock supervisor end-to-end with no external processes. To drive a real `claude` in one command, opt into managed launch:

```bash
bun apps/ccb/src/cli.ts demo --supervisor=claude "ping"
```

Expected (UUIDs vary):

```text
[session.started] 4f3b6e10-...
[message.sent] 2b8c1f70-... "ping"
[agent.progress] "..."
[agent.reply final=true] "..."
[session.ended]
```

For the full real-`claude` walkthrough — managed launch, plugin install, and the two-terminal manual fallback — see [`docs/SMOKE.md`](./docs/SMOKE.md).

**Observational tool-call visibility.** A hook relay can register `ccb-hook-relay` for claude's `PreToolUse` / `PostToolUse` / `Stop` events so the event stream carries `tool.event` records alongside `agent.reply` / `agent.done`. Consumers see what `claude` *did* (Bash commands, Read/Edit/Write calls, …), not just what it said, with Pre/Post pairs correlated by `tool_use_id`. See [`docs/M3.md`](./docs/M3.md) for the design and [`docs/SMOKE.md`](./docs/SMOKE.md) for end-to-end verification.

## Requirements

- [Bun](https://bun.sh) for the package manager, test runner, and TypeScript runtime.
- For the real-`claude` path: Claude Code v2.1.80 or newer, authenticated, with the channels research-preview enabled. See [`docs/SMOKE.md`](./docs/SMOKE.md) for both the development-flag and plugin-install paths.

## Where to go next

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — full design, process topology, library-usage example, and channel-direction nuance.
- [`docs/CLI.md`](./docs/CLI.md) — `ccb` CLI command reference (`demo`, `mcp-config`, `serve`).
- [`docs/SMOKE.md`](./docs/SMOKE.md) — real-`claude` verification procedure.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — milestones, planned work, and consumer-gated follow-ups.

## License

[MIT](./LICENSE).
