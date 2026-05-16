# Project notes for Claude Code

This is a TypeScript library + CLI + MCP server. See PLAN.md for architecture, scope, and the current milestone.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Code Quality

1. **KISS** — simplest solution that works.
2. **DRY** — reuse existing code and patterns before writing new ones.
3. **YAGNI** — build only what's needed now. No speculative abstractions.
4. **Leverage libraries** — prefer maintained libraries over reinvention.
5. **No magic** — explicit configuration. No guessing, parsing, or fallbacks.
6. **Separation of concerns** — one purpose per file/class.
7. **Dependency injection** — pass dependencies in, don't import globally.

Do what's asked, nothing more, nothing less.

## Things to avoid

- Creating new files when editing an existing one works
- Creating documentation (`.md`, README) unless explicitly requested
- Adding emojis to code or docs unless requested
- `git add -A` / `git add .` — use `git add <file>`
- Committing without reviewing the diff
- `git commit --amend` unless explicitly asked
- Skipping tests for new functionality
- Temporal/comparative comments ("replaces old X", "instead of Y") — describe what the code does now

## GitHub CLI

Use `/gh` skill for `gh` CLI patterns (issues, PRs, review comments, deployments).
