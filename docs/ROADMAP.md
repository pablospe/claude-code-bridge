# Roadmap

This is the durable entry point for the project's milestone documentation. Individual `MX.md` files are working documents and may be archived or renamed once their milestone is complete; this file is the single index that survives.

## Milestones

| ID | Status      | Doc                            | Summary                                                                                                                          |
| -- | ----------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| M1 | shipped     | [M1.md](./M1.md)               | Protocol shape end-to-end: channels-in / MCP-tools-out, JSONL store, `MockSupervisor`, `ccb` CLI, manual real-claude smoke.      |
| M2 | shipped     | [M2.md](./M2.md)               | Managed launch: bridge spawns `claude` itself via `node-pty`, supervisor-crash event emission, start timeout, plugin packaging.  |
| M3 | proposal    | [M3.md](./M3.md)               | Hook-relayed visibility: `PreToolUse` / `PostToolUse` / `Stop` / lifecycle events surfaced as `BridgeEvent`s for richer UIs.     |

## Possible later work (consumer-demand-gated)

These are not committed milestones. They exist as known, well-understood follow-ups that will
land if a concrete consumer asks for them.

- **Permission-prompt routing.** Advertise the channels-native permission-routing capability
  on the bridge's MCP server, surface incoming tool-approval prompts as a `BridgeEvent`, and
  accept allow/deny decisions back from the consumer. This is what a richer UI (T3 Code, an
  orchestrator dashboard) needs to let a human elsewhere approve Bash / Edit / Write calls
  Claude wants to make. The protocol is bidirectional and narrowly scoped to tool approval;
  the design discussion lives in [M3.md](./M3.md)'s permission-prompt routing open question.
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
