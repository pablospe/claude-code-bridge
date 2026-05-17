# Roadmap

This is the durable entry point for the project's milestone documentation. Individual `MX.md` files are working documents and may be archived or renamed once their milestone is complete; this file is the single index that survives.

## Milestones

| ID | Status      | Doc                            | Summary                                                                                                                          |
| -- | ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| M1 | shipped     | [M1.md](./M1.md)               | Protocol shape end-to-end: channels-in / MCP-tools-out, JSONL store, `MockSupervisor`, `ccb` CLI, manual real-claude smoke.      |
| M2 | planned     | [M2.md](./M2.md)               | Managed launch: bridge spawns `claude` itself via `node-pty`, supervisor-crash event emission, start timeout, plugin packaging.  |
| M3 | proposal    | [M3.md](./M3.md)               | Hook-relayed visibility: `PreToolUse` / `PostToolUse` / `Stop` / lifecycle events surfaced as `BridgeEvent`s for richer UIs.     |

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
