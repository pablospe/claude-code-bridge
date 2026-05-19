# Roadmap

This is the durable entry point for the project's milestone documentation. Individual `MX.md` files are working documents and may be archived or renamed once their milestone is complete; this file is the single index that survives.

## Milestones

| ID | Status      | Doc                            | Summary                                                                                                                          |
| -- | ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| M1 | shipped     | [M1.md](./M1.md)               | Protocol shape end-to-end: channels-in / MCP-tools-out, JSONL store, `MockSupervisor`, `ccb` CLI, manual real-claude smoke.      |
| M2 | shipped     | [M2.md](./M2.md)               | Managed launch: bridge spawns `claude` itself via `node-pty`, supervisor-crash event emission, start timeout, plugin packaging.  |
| M3 | shipped     | [M3.md](./M3.md)               | Observational hook relay: `PreToolUse` / `PostToolUse` / `Stop` surfaced as `BridgeEvent.tool.event` records; phase 2 adds more. |
| M4 | proposal (consumer-gated) | [M4.md](./M4.md)   | Permission-prompt routing: surface tool-approval requests to the consumer and route allow / deny decisions back over channels.  |
| M5 | locked      | [M5.md](./M5.md)               | Publishing: plugin manifest polish, hook relay in the plugin, npm release as a single `claude-code-bridge` package.              |

## Possible later work (consumer-demand-gated)

These are not committed milestones. They exist as known, well-understood follow-ups that will
land if a concrete consumer asks for them.

- **HTTP / WebSocket adapter** (`packages/http`) and **ACP-compatible facade** (`packages/acp`).
  Non-Node consumers and ACP-compatible orchestrators. Deferred until the event stream is rich
  enough (post-M3 hook relay) to be worth exposing over a network boundary.
- **`ccb attach <claude-pid>`** — attach to an already-running `claude` instead of managed
  launch. Deferred for discovery/state-ambiguity reasons; revisit if a consumer asks.

## What stays out (for now)

- Token-level streaming and extended thinking blocks. Every available path violates a stated non-goal.
- `claude --print` / Claude Agent SDK as the runtime path. They re-spawn the model context per turn.
- PTY scraping / `capture-pane` on the semantic protocol. PTY is launch substrate only.
- Daemon mode for shared session state.
- SQLite-backed event store; JSONL is the documented contract.

See each milestone doc for milestone-scoped non-goals and deferred items.

## How to read this

- Durable docs (`README.md`, `docs/ARCHITECTURE.md`, `docs/SMOKE.md`) describe current behavior. They link here, not directly at `MX.md`.
- Milestone docs cross-reference each other freely; that's working-document churn.
- When a milestone is archived, update this file and the milestone doc disappears or moves; no other doc needs to change.
