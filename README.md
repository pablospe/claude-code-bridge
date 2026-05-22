# Claude Code Bridge

A TypeScript library + CLI that lets external UIs and orchestrators drive an already-running, already-authenticated Claude Code session — without restarting it, without scraping the terminal, and without talking to the model API directly.

## The idea

Channels for inbound general content; MCP tools for outbound. A consumer pushes a message in via a Claude Code channel (`notifications/claude/channel`); Claude responds by calling one of three MCP tools (`bridge_reply` / `bridge_progress` / `bridge_done`); every turn is persisted as an append-only JSONL event log.

```text
        +-------------------------------------------+
        |                 Consumer                  |
        |        ccb serve, T3 Code, agtx, ...      |
        +-------------------------------------------+
              |                          ^
              | sendMessage()            | events(sessionId)
              v                          |
        +-------------------------------------------+
        |                  Bridge                   |
        |          session state + event log        |
        +-------------------------------------------+
              ||                         ^^
              || channels (inbound)      || MCP tools (outbound)
              vv                         ||
        +-------------------------------------------+
        |                Claude Code                |
        |             claude + ccb plugin           |
        +-------------------------------------------+
```

This is not an ACP replacement and not a universal agent runtime. It exists for the specific case where you want an already-authenticated interactive `claude` to be the runtime.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full design, process topology, and a library-usage example.

## Demo

<a href="https://asciinema.org/a/7WTXyawPGSikG5Em" target="_blank" rel="noopener noreferrer">
  <img width="2023" height="1098" alt="demo" src="https://github.com/user-attachments/assets/08285bfb-e362-4349-b439-ebf93f93ab23" />
</a>

## Screnshot

<img width="2603" height="673" alt="ccb demo" src="https://github.com/user-attachments/assets/95b36996-9adc-49c0-bba9-ad020fe18873" />

## Install

**1.** Install the CLI globally (`bun ≥ 1.3` must be on PATH):

```bash
> bun add -g @pablospe/claude-code-bridge
```

**2.** Register the plugin inside a `claude` session:

```text
/plugin marketplace add https://github.com/pablospe/claude-code-bridge
/plugin install ccb@claude-code-bridge
```

The plugin connects a normal `claude` session back to the bridge
automatically — including the hook relay, so you get `tool.event` visibility
out of the box.

<details>
<summary>What this installs / why order matters</summary>

- **Four bins land on your PATH:** `ccb` (the CLI), `ccb-channel-server` and
  `ccb-hook-relay` (spawned by Claude Code), and `ccb-launcher` (a Node-side
  launcher; see [limitations](#status--known-limitations)).
- **npm name:** published as
  [`@pablospe/claude-code-bridge`](https://www.npmjs.com/package/@pablospe/claude-code-bridge),
  scoped under the author's namespace; the GitHub repo name stays
  `claude-code-bridge`.
- **Global install must come first:** the plugin manifest invokes
  `ccb-channel-server` / `ccb-hook-relay` by bare name, so without them on
  PATH claude reports `command not found`.
- **Channels is a research preview:** it must be enabled / allowlisted for
  your account — see [`docs/SMOKE.md`](./docs/SMOKE.md) for that one-time step.

</details>

## Usage: two terminals

The bridge is the *consumer side*; your `claude` session is the *runtime* —
you drive claude from the bridge and watch the structured event stream.

**1.** Start the bridge (**Terminal 1**). It mints a session id, writes a
per-session MCP config, and prints the exact `claude` command for terminal 2:

```bash
ccb serve
#   listening on 127.0.0.1:18484
#   bridge_uuid: 4f3b6e10-…
#   …
#   in a second terminal, start claude pointed at this bridge:
#     claude --dangerously-load-development-channels server:ccb \
#       --mcp-config /tmp/ccb-serve-4f3b6e10-….mcp.json \
#       --allowed-tools "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done"
```

**2.** Start claude (**Terminal 2**). Paste the command `ccb serve` printed.

**3.** Send a prompt (back in **Terminal 1**) — it's pushed to claude as a
channel notification:

```text
what is 11 squared?
```

Terminal 1 streams the round-trip as structured events:

```text
[message.sent]  m1 "what is 11 squared?"
[tool.event]    PreToolUse Bash "…"
[tool.event]    PostToolUse Bash (12 B)
[agent.reply final=true] "11 squared is 121."
[agent.done]
```

<details>
<summary>Why the pasted command matters / session-id tips</summary>

- **The dev-channels flag is what enables inbound.** It loads the `ccb`
  channel from the generated `--mcp-config` (whose env carries the endpoint +
  session id); a plain plugin launch gives outbound tools + hooks only.
- **Need a session id without copy-paste?** Bun is already installed:
  `bun -e 'console.log(crypto.randomUUID())'`, or use `uuidgen` if you have it,
  and pass the same value to `ccb serve --session-id` and
  `export CCB_SESSION_ID`.

</details>

For the full verified walkthrough — including enabling the channels preview
and the alternative `ccb-launcher` flow — see [`docs/SMOKE.md`](./docs/SMOKE.md).

## Did it install? (no claude needed)

A mock supervisor runs the whole event pipeline in-process, with no real
`claude` and no channels — handy as a smoke check:

```bash
ccb demo --supervisor=mock "what is 11 squared?"
```

```text
[session.started] d91356a6-…
[message.sent] 916c268f-… "what is 11 squared?"
[agent.progress] "thinking"
[agent.reply final=true] "echo: what is 11 squared?"
[session.ended]
```

## Development

From a source checkout — also the way to run the bridge before the npm
package is published:

```bash
git clone https://github.com/pablospe/claude-code-bridge
cd claude-code-bridge
bun install
bun test
# the CLI runs straight from source (no global install):
bun apps/ccb/src/cli.ts demo --supervisor=mock "hello world"
```

`--channels=dev-flag` exercises the real-claude channel surface without the
plugin (uses `claude --dangerously-load-development-channels`), so you can
test against your local source without publishing. To exercise the *plugin*
path against local source, `bun link @pablospe/claude-code-bridge` in this
checkout and `bun link --global @pablospe/claude-code-bridge` where you run
claude; the plugin manifest references bin names, so PATH resolution finds
the linked bins.

## Status & known limitations

What works today: the protocol shape end-to-end against an in-process mock;
the observational hook relay (`PreToolUse` / `PostToolUse` / `Stop`
surfaced as `tool.event` records, Pre/Post correlated by `tool_use_id`);
the append-only JSONL event store; and the one-command managed launch (the
bridge spawning `claude` itself via `node-pty`), which now works under **both
Node and Bun**.

**Managed launch.** `ccb demo --supervisor=claude` spawns and supervises
`claude` via `node-pty` in one process and completes the full inbound/outbound
round-trip under both Node and Bun. The [two-terminal flow](#usage-two-terminals)
above remains available for consumers that prefer to launch `claude`
themselves, with the `ccb-launcher` bin as a pure-Node launcher/diagnostic for
that shape.

The genuine constraints are on the Claude Code side, not the bridge: you need
Claude Code v2.1.80+ authenticated with the channels research preview enabled,
and inbound only works via the dev-flag/`--mcp-config` path (the plugin path is
outbound + hooks only on individual accounts). See
[`docs/SMOKE.md`](./docs/SMOKE.md).

## Where to go next

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — full design, process topology, library-usage example, and channel-direction nuance.
- [`docs/CLI.md`](./docs/CLI.md) — `ccb` CLI command reference (`demo`, `mcp-config`, `serve`).
- [`docs/SMOKE.md`](./docs/SMOKE.md) — real-`claude` verification procedure (plugin, dev-flag, and two-terminal launcher).
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — milestones, planned work, and consumer-gated follow-ups.

## License

[MIT](./LICENSE).
