# Claude Code Bridge

A reusable TypeScript library for controlling interactive Claude Code sessions from external UIs and orchestrators.

The bridge uses Claude Code channels for inbound messages, MCP tools for structured outbound replies/progress, Claude Code hooks for lifecycle and telemetry, and PTY/tmux only as a process substrate or fallback observation layer.

This is not an ACPX replacement and not a universal agent runtime. It exists for the specific case where an integration wants to drive an already authenticated interactive Claude Code session without using `claude -p` or the Claude Agent SDK as the primary runtime path.

Primary consumers include T3 Code-style UIs, OpenClaw, agtx, OpenCode-style UIs, local dashboards, and custom CLIs.

See [PLAN.md](./PLAN.md) for architecture, scope, non-goals, and the first implementation milestone.
