# OpenAI-Compatible Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose a warm interactive Claude Code session pool as an OpenAI-compatible HTTP API (`packages/http` + `ccb api`) so LiteLLM can use it with zero LiteLLM changes.

**Architecture:** New `packages/http` package (server, session pool, transcript renderer, tool-call parser) on top of `@ccb/core`'s Bridge. Two small additions outside the new package: `Bridge.clear()` (PTY `/clear` injection) and two `ClaudeCodeSupervisor` launch options (`cleanSession` → `--safe-mode`, `rawModel` → `--disallowed-tools`). Every request is stateless: acquire → clear → replay full `messages[]` as one turn → parse → release.

**Tech Stack:** Bun (`Bun.serve`, `bun test`), TypeScript ESM, commander (CLI), existing `@ccb/core` / `@ccb/claude-code` / `@ccb/process` packages.

**Spec:** `docs/2026-06-10-openai-facade-design.md`

**Conventions that apply to every task:**
- Run tests with `bun test <path>` from the repo root.
- Run `bun run typecheck` before each commit.
- Commit with `git add <specific files>` (never `-A`), message style `feat(http): ...` / `feat(core): ...` / `test: ...` as shown per task.
- All new source files live under `src/` of their package; tests sit next to sources as `<name>.test.ts` (existing pattern).

---

## File Structure (final state)

```
packages/http/
  package.json                  (new) @ccb/http workspace package
  tsconfig.json                 (new) project-reference config
  src/
    index.ts                    (new) public exports
    openai-types.ts             (new) request/response wire types + validation
    renderer.ts                 (new) messages[] + tools[] -> single prompt string
    tool-call-parser.ts         (new) final reply -> text | tool_calls
    response.ts                 (new) OpenAI response/chunk builders + token estimate
    pool.ts                     (new) SessionPool: N warm sessions, FIFO queue, respawn
    turn.ts                     (new) one bridge turn -> async deltas + terminal result
    server.ts                   (new) fetch handler + Bun.serve wrapper
    *.test.ts                   (new) one per module
packages/core/src/
  supervisor.ts                 (modify) optional clear() on Supervisor
  bridge.ts                     (modify) Bridge.clear(sessionId)
  types.ts                      (modify) clear on ClaudeCodeBridge
  index.ts                      (no change needed; types re-exported already)
packages/claude-code/src/
  mock-supervisor.ts            (modify) clear() recording seam
  claude-supervisor.ts          (modify) clear() PTY write; cleanSession/rawModel args
apps/ccb/src/
  api.ts                        (new) runApi(): bridge + pool + server wiring
  api.test.ts                   (new) CLI-level acceptance vs mock supervisor
  cli.ts                        (modify) `ccb api` command
scripts/
  litellm-smoke.py              (new) real-claude acceptance via litellm
docs/SMOKE.md                   (modify) facade smoke runbook
tsconfig.json                   (modify) add packages/http reference
apps/ccb/package.json           (modify) add @ccb/http dep
apps/ccb/tsconfig.json          (modify) add ../../packages/http reference
```

---

### Task 1: Scaffold `packages/http`

**Files:**
- Create: `packages/http/package.json`
- Create: `packages/http/tsconfig.json`
- Create: `packages/http/src/index.ts`
- Modify: `tsconfig.json` (root)
- Modify: `apps/ccb/package.json`
- Modify: `apps/ccb/tsconfig.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@ccb/http",
  "private": true,
  "type": "module",
  "version": "0.0.1",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@ccb/core": "workspace:*"
  },
  "devDependencies": {
    "@ccb/claude-code": "workspace:*"
  }
}
```

- [ ] **Step 2: Create tsconfig.json** (mirror `packages/openclaw-acp/tsconfig.json`)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "dist/tsconfig.tsbuildinfo"
  },
  "references": [
    { "path": "../core" },
    { "path": "../claude-code" }
  ],
  "include": ["src"]
}
```

- [ ] **Step 3: Create src/index.ts** (placeholder export so the project compiles; grows as modules land)

```ts
export {};
```

- [ ] **Step 4: Wire references** — root `tsconfig.json`: add `{ "path": "packages/http" }` to `references` (before `apps/ccb`). `apps/ccb/package.json`: add `"@ccb/http": "workspace:*"` to `dependencies`. `apps/ccb/tsconfig.json`: add `{ "path": "../../packages/http" }` to `references`.

- [ ] **Step 5: Install + typecheck**

Run: `bun install && bun run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/http/package.json packages/http/tsconfig.json packages/http/src/index.ts tsconfig.json apps/ccb/package.json apps/ccb/tsconfig.json bun.lock
git commit -m "chore(http): scaffold @ccb/http workspace package"
```

---

### Task 2: Failing acceptance test (outside-in anchor)

The acceptance drives everything: boot the whole facade against the **mock** supervisor and make an OpenAI request through real HTTP. It is committed as `test.todo` (so the suite stays green between tasks) and un-skipped in Task 12. The real-claude litellm smoke script is also written now and wired into SMOKE.md in Task 13.

**Files:**
- Create: `apps/ccb/src/api.test.ts`
- Create: `scripts/litellm-smoke.py`

- [ ] **Step 1: Write the acceptance test (todo-marked)**

```ts
// apps/ccb/src/api.test.ts
import { expect, test } from "bun:test";
import { runApi } from "./api.ts";

// Un-skip in the final wiring task (flip test.todo -> test).
test.todo("POST /v1/chat/completions round-trips a turn through the bridge", async () => {
  const api = await runApi({
    host: "127.0.0.1",
    port: 0,
    poolSize: 1,
    turnTimeoutMs: 10_000,
    supervisor: "mock",
    storeDir: `/tmp/ccb-api-test-${crypto.randomUUID()}`,
  });
  try {
    const res = await fetch(`${api.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ccb-claude",
        messages: [{ role: "user", content: "hello world" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.role).toBe("assistant");
    // MockSupervisor replies "echo: <delivered content>"; the delivered content
    // is the rendered transcript, which embeds the user text.
    expect(body.choices[0]?.message.content).toContain("hello world");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  } finally {
    await api.stop();
  }
});
```

- [ ] **Step 2: Verify it is red when live** — temporarily change `test.todo` to `test`, run:

Run: `bun test apps/ccb/src/api.test.ts`
Expected: FAIL — `Cannot find module './api.ts'`. Revert to `test.todo` and confirm the suite passes (todo reported, not failed).

- [ ] **Step 3: Write the real-claude litellm smoke script**

```python
# scripts/litellm-smoke.py
# Acceptance smoke: ccb api (real claude) consumed through litellm.
# Run: see docs/SMOKE.md "OpenAI facade" section.
import sys

import litellm

BASE = "http://127.0.0.1:18485/v1"


def main() -> int:
    resp = litellm.completion(
        model="openai/ccb-claude",
        api_base=BASE,
        api_key="ccb",
        messages=[{"role": "user", "content": "Reply with exactly the word: pong"}],
    )
    content = resp.choices[0].message.content or ""
    print(f"non-streaming reply: {content!r}")
    if "pong" not in content.lower():
        print("FAIL: expected 'pong' in reply")
        return 1

    chunks = []
    for chunk in litellm.completion(
        model="openai/ccb-claude",
        api_base=BASE,
        api_key="ccb",
        messages=[{"role": "user", "content": "Reply with exactly the word: pong"}],
        stream=True,
    ):
        delta = chunk.choices[0].delta.content
        if delta:
            chunks.append(delta)
    streamed = "".join(chunks)
    print(f"streamed reply: {streamed!r}")
    if "pong" not in streamed.lower():
        print("FAIL: expected 'pong' in streamed reply")
        return 1

    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Commit**

```bash
git add apps/ccb/src/api.test.ts scripts/litellm-smoke.py
git commit -m "test: add facade acceptance test (todo) and litellm smoke script"
```

---

### Task 3: OpenAI wire types + request validation

**Files:**
- Create: `packages/http/src/openai-types.ts`
- Test: `packages/http/src/openai-types.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/http/src/openai-types.test.ts
import { describe, expect, test } from "bun:test";
import { validateChatRequest } from "./openai-types.ts";

describe("validateChatRequest", () => {
  test("accepts a minimal valid request", () => {
    const r = validateChatRequest({
      model: "ccb-claude",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.messages).toHaveLength(1);
      expect(r.value.stream).toBe(false);
    }
  });

  test("accepts tools, tool messages and stream flag", () => {
    const r = validateChatRequest({
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "{\"temp\":18}" },
      ],
      tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stream).toBe(true);
  });

  test("rejects missing messages", () => {
    const r = validateChatRequest({ model: "m" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("messages");
  });

  test("rejects message without role", () => {
    const r = validateChatRequest({ model: "m", messages: [{ content: "x" }] });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/http/src/openai-types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/http/src/openai-types.ts
export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<ToolCall>;
  readonly tool_call_id?: string;
}

export interface ToolDef {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools: ReadonlyArray<ToolDef>;
  readonly stream: boolean;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const ROLES = new Set(["system", "user", "assistant", "tool"]);

export function validateChatRequest(body: unknown): Validated<ChatRequest> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, error: "'messages' must be a non-empty array" };
  }
  for (const m of b.messages) {
    if (typeof m !== "object" || m === null) {
      return { ok: false, error: "every message must be an object" };
    }
    const role = (m as Record<string, unknown>).role;
    if (typeof role !== "string" || !ROLES.has(role)) {
      return { ok: false, error: "every message needs a role of system|user|assistant|tool" };
    }
  }
  return {
    ok: true,
    value: {
      model: typeof b.model === "string" ? b.model : "ccb-claude",
      messages: b.messages as ReadonlyArray<ChatMessage>,
      tools: Array.isArray(b.tools) ? (b.tools as ReadonlyArray<ToolDef>) : [],
      stream: b.stream === true,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/http/src/openai-types.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Export from index** — replace `packages/http/src/index.ts` content:

```ts
export * from "./openai-types.ts";
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add packages/http/src/openai-types.ts packages/http/src/openai-types.test.ts packages/http/src/index.ts
git commit -m "feat(http): OpenAI chat request wire types and validation"
```

---

### Task 4: Transcript renderer

**Files:**
- Create: `packages/http/src/renderer.ts`
- Test: `packages/http/src/renderer.test.ts`

The exact rendered format is part of the contract — tests pin it.

- [ ] **Step 1: Write failing tests**

```ts
// packages/http/src/renderer.test.ts
import { describe, expect, test } from "bun:test";
import { renderTranscript, TOOL_CALL_INSTRUCTION } from "./renderer.ts";

describe("renderTranscript", () => {
  test("single user message renders with label and reply instruction", () => {
    const out = renderTranscript([{ role: "user", content: "hi there" }], []);
    expect(out).toContain("[user]\nhi there");
    expect(out).toContain("Respond to the conversation above.");
  });

  test("system messages become a preamble before the conversation", () => {
    const out = renderTranscript(
      [
        { role: "system", content: "You are terse." },
        { role: "user", content: "hi" },
      ],
      [],
    );
    expect(out.indexOf("You are terse.")).toBeLessThan(out.indexOf("[user]"));
  });

  test("assistant tool_calls and tool results are labeled turns", () => {
    const out = renderTranscript(
      [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"temp":18}' },
      ],
      [],
    );
    expect(out).toContain('[assistant tool_call call_1]\nget_weather({"city":"Paris"})');
    expect(out).toContain('[tool result for call_1]\n{"temp":18}');
  });

  test("tools render schemas plus the tool-call instruction", () => {
    const out = renderTranscript(
      [{ role: "user", content: "weather?" }],
      [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    );
    expect(out).toContain('"name": "get_weather"');
    expect(out).toContain(TOOL_CALL_INSTRUCTION);
  });

  test("no tools means no tool instruction", () => {
    const out = renderTranscript([{ role: "user", content: "hi" }], []);
    expect(out).not.toContain(TOOL_CALL_INSTRUCTION);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/http/src/renderer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/http/src/renderer.ts
import type { ChatMessage, ToolDef } from "./openai-types.ts";

export const TOOL_CALL_INSTRUCTION =
  'If you need a tool, reply with ONLY a fenced json block of the shape ' +
  '{"tool_call": {"name": "<tool name>", "arguments": {...}}} — or ' +
  '{"tool_calls": [...]} for multiple calls. Otherwise reply normally.';

function renderMessage(m: ChatMessage): string {
  if (m.role === "tool") {
    return `[tool result for ${m.tool_call_id ?? "unknown"}]\n${m.content ?? ""}`;
  }
  if (m.role === "assistant" && m.tool_calls !== undefined && m.tool_calls.length > 0) {
    const calls = m.tool_calls
      .map((c) => `[assistant tool_call ${c.id}]\n${c.function.name}(${c.function.arguments})`)
      .join("\n\n");
    return m.content ? `[assistant]\n${m.content}\n\n${calls}` : calls;
  }
  return `[${m.role}]\n${m.content ?? ""}`;
}

/**
 * Render a stateless OpenAI messages array into a single prompt for one
 * bridge turn. System messages form a preamble; everything else becomes
 * labeled turns; tool schemas (if any) are appended with the call protocol.
 */
export function renderTranscript(
  messages: ReadonlyArray<ChatMessage>,
  tools: ReadonlyArray<ToolDef>,
): string {
  const parts: string[] = [];
  const system = messages.filter((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  if (system.length > 0) {
    parts.push(system.map((m) => m.content ?? "").join("\n\n"));
  }
  parts.push(rest.map(renderMessage).join("\n\n"));
  if (tools.length > 0) {
    const schemas = tools.map((t) => JSON.stringify(t.function, null, 2)).join("\n");
    parts.push(`[available tools]\n${schemas}\n\n${TOOL_CALL_INSTRUCTION}`);
  }
  parts.push("Respond to the conversation above.");
  return parts.join("\n\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/http/src/renderer.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Add export + commit**

Add `export * from "./renderer.ts";` to `packages/http/src/index.ts`.

```bash
bun run typecheck
git add packages/http/src/renderer.ts packages/http/src/renderer.test.ts packages/http/src/index.ts
git commit -m "feat(http): transcript renderer for stateless replay"
```

---

### Task 5: Tool-call parser

**Files:**
- Create: `packages/http/src/tool-call-parser.ts`
- Test: `packages/http/src/tool-call-parser.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/http/src/tool-call-parser.test.ts
import { describe, expect, test } from "bun:test";
import { parseReply } from "./tool-call-parser.ts";

describe("parseReply", () => {
  test("plain prose is text", () => {
    const r = parseReply("It is sunny in Paris.");
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.content).toBe("It is sunny in Paris.");
  });

  test("fenced single tool_call parses", () => {
    const r = parseReply(
      '```json\n{"tool_call": {"name": "get_weather", "arguments": {"city": "Paris"}}}\n```',
    );
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") {
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.function.name).toBe("get_weather");
      expect(JSON.parse(r.calls[0]?.function.arguments ?? "")).toEqual({ city: "Paris" });
      expect(r.calls[0]?.id).toMatch(/^call_/);
    }
  });

  test("bare (unfenced) tool_call object parses", () => {
    const r = parseReply('{"tool_call": {"name": "f", "arguments": {}}}');
    expect(r.kind).toBe("tool_calls");
  });

  test("tool_calls array parses to multiple calls", () => {
    const r = parseReply(
      '```json\n{"tool_calls": [{"name": "a", "arguments": {}}, {"name": "b", "arguments": {"x": 1}}]}\n```',
    );
    expect(r.kind).toBe("tool_calls");
    if (r.kind === "tool_calls") expect(r.calls.map((c) => c.function.name)).toEqual(["a", "b"]);
  });

  test("malformed JSON degrades to text, never throws", () => {
    const raw = '```json\n{"tool_call": {"name": broken}\n```';
    const r = parseReply(raw);
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.content).toBe(raw);
  });

  test("JSON without tool_call key degrades to text", () => {
    const raw = '```json\n{"answer": 42}\n```';
    expect(parseReply(raw).kind).toBe("text");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/http/src/tool-call-parser.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/http/src/tool-call-parser.ts
import type { ToolCall } from "./openai-types.ts";

export type ParsedReply =
  | { kind: "text"; content: string }
  | { kind: "tool_calls"; calls: ReadonlyArray<ToolCall> };

interface RawCall {
  readonly name: string;
  readonly arguments: unknown;
}

function asRawCall(v: unknown): RawCall | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== "string") return undefined;
  return { name: o.name, arguments: o.arguments ?? {} };
}

function toToolCall(raw: RawCall): ToolCall {
  return {
    id: `call_${crypto.randomUUID().slice(0, 8)}`,
    type: "function",
    function: { name: raw.name, arguments: JSON.stringify(raw.arguments) },
  };
}

/**
 * Extract the prompted tool-call protocol from a final reply. Degrades to
 * text on any mismatch — the facade never errors on an unparseable reply.
 */
export function parseReply(reply: string): ParsedReply {
  const fenced = reply.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  const candidate = (fenced?.[1] ?? reply).trim();
  if (!candidate.startsWith("{")) return { kind: "text", content: reply };
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { kind: "text", content: reply };
  }
  if (typeof parsed !== "object" || parsed === null) return { kind: "text", content: reply };
  const o = parsed as Record<string, unknown>;
  const raws: RawCall[] = [];
  if (o.tool_call !== undefined) {
    const one = asRawCall(o.tool_call);
    if (one) raws.push(one);
  } else if (Array.isArray(o.tool_calls)) {
    for (const c of o.tool_calls) {
      const one = asRawCall(c);
      if (one) raws.push(one);
    }
  }
  if (raws.length === 0) return { kind: "text", content: reply };
  return { kind: "tool_calls", calls: raws.map(toToolCall) };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/http/src/tool-call-parser.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add export + commit**

Add `export * from "./tool-call-parser.ts";` to `packages/http/src/index.ts`.

```bash
bun run typecheck
git add packages/http/src/tool-call-parser.ts packages/http/src/tool-call-parser.test.ts packages/http/src/index.ts
git commit -m "feat(http): prompted tool-call parser with text degradation"
```

---

### Task 6: Response builders + token estimate

**Files:**
- Create: `packages/http/src/response.ts`
- Test: `packages/http/src/response.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/http/src/response.test.ts
import { describe, expect, test } from "bun:test";
import { buildChunk, buildCompletion, estimateTokens } from "./response.ts";

describe("estimateTokens", () => {
  test("~chars/4, minimum 1 for non-empty", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(10))).toBe(3);
  });
});

describe("buildCompletion", () => {
  test("text result shape", () => {
    const r = buildCompletion({
      model: "ccb-claude",
      prompt: "p".repeat(40),
      parsed: { kind: "text", content: "hello" },
    });
    expect(r.object).toBe("chat.completion");
    expect(r.id).toMatch(/^chatcmpl-/);
    expect(r.choices[0]?.message).toEqual({ role: "assistant", content: "hello" });
    expect(r.choices[0]?.finish_reason).toBe("stop");
    expect(r.usage.prompt_tokens).toBe(10);
    expect(r.usage.completion_tokens).toBe(2);
    expect(r.usage.total_tokens).toBe(12);
  });

  test("tool_calls result shape", () => {
    const r = buildCompletion({
      model: "m",
      prompt: "p",
      parsed: {
        kind: "tool_calls",
        calls: [{ id: "call_x", type: "function", function: { name: "f", arguments: "{}" } }],
      },
    });
    expect(r.choices[0]?.finish_reason).toBe("tool_calls");
    expect(r.choices[0]?.message.content).toBeNull();
    expect(r.choices[0]?.message.tool_calls?.[0]?.id).toBe("call_x");
  });
});

describe("buildChunk", () => {
  test("delta chunk and final chunk", () => {
    const delta = buildChunk({ id: "chatcmpl-1", model: "m", delta: { content: "hi" } });
    expect(delta.object).toBe("chat.completion.chunk");
    expect(delta.choices[0]?.delta).toEqual({ content: "hi" });
    expect(delta.choices[0]?.finish_reason).toBeNull();
    const final = buildChunk({ id: "chatcmpl-1", model: "m", delta: {}, finishReason: "stop" });
    expect(final.choices[0]?.finish_reason).toBe("stop");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/http/src/response.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/http/src/response.ts
import type { ToolCall } from "./openai-types.ts";
import type { ParsedReply } from "./tool-call-parser.ts";

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

interface AssistantMessage {
  readonly role: "assistant";
  readonly content: string | null;
  readonly tool_calls?: ReadonlyArray<ToolCall>;
}

export interface ChatCompletion {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly index: 0;
    readonly message: AssistantMessage;
    readonly finish_reason: "stop" | "tool_calls";
  }>;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
}

export function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

export function buildCompletion(input: {
  model: string;
  prompt: string;
  parsed: ParsedReply;
}): ChatCompletion {
  const { model, prompt, parsed } = input;
  const message: AssistantMessage =
    parsed.kind === "text"
      ? { role: "assistant", content: parsed.content }
      : { role: "assistant", content: null, tool_calls: parsed.calls };
  const completionText =
    parsed.kind === "text" ? parsed.content : JSON.stringify(parsed.calls);
  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(completionText);
  return {
    id: newCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: parsed.kind === "text" ? "stop" : "tool_calls",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export interface ChatChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: ReadonlyArray<{
    readonly index: 0;
    readonly delta: {
      readonly role?: "assistant";
      readonly content?: string;
      readonly tool_calls?: ReadonlyArray<ToolCall & { readonly index: number }>;
    };
    readonly finish_reason: "stop" | "tool_calls" | null;
  }>;
}

export function buildChunk(input: {
  id: string;
  model: string;
  delta: ChatChunk["choices"][number]["delta"];
  finishReason?: "stop" | "tool_calls";
}): ChatChunk {
  return {
    id: input.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [{ index: 0, delta: input.delta, finish_reason: input.finishReason ?? null }],
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/http/src/response.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add export + commit**

Add `export * from "./response.ts";` to `packages/http/src/index.ts`.

```bash
bun run typecheck
git add packages/http/src/response.ts packages/http/src/response.test.ts packages/http/src/index.ts
git commit -m "feat(http): OpenAI completion and chunk builders with token estimate"
```

---

### Task 7: `clear()` through core (Supervisor + Bridge + Mock)

**Files:**
- Modify: `packages/core/src/supervisor.ts` (Supervisor interface)
- Modify: `packages/core/src/types.ts` (ClaudeCodeBridge interface)
- Modify: `packages/core/src/bridge.ts` (Bridge.clear)
- Modify: `packages/claude-code/src/mock-supervisor.ts` (clear seam)
- Test: `packages/core/src/bridge-clear.test.ts`

- [ ] **Step 1: Write failing test**

Look at `packages/core/src/bridge.test.ts` first for the established Bridge test setup (storeDir fixtures, factory wiring) and reuse its helpers/style.

```ts
// packages/core/src/bridge-clear.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { MockSupervisor } from "@ccb/claude-code";
import { Bridge } from "./bridge.ts";

const storeDir = `/tmp/ccb-clear-test-${crypto.randomUUID()}`;

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("Bridge.clear", () => {
  test("delegates to a supervisor that supports clear", async () => {
    const supervisor = new MockSupervisor();
    const bridge = new Bridge({ storeDir, supervisorFactory: () => supervisor });
    const { id } = await bridge.startSession({});
    await bridge.clear(id);
    expect(supervisor.clearCalls).toBe(1);
    await bridge.close(id);
  });

  test("rejects for unknown session", async () => {
    const bridge = new Bridge({ storeDir, supervisorFactory: () => new MockSupervisor() });
    await expect(bridge.clear("nope")).rejects.toThrow();
  });

  test("rejects when the supervisor does not implement clear", async () => {
    const supervisor = new MockSupervisor();
    // Simulate a supervisor without clear support.
    (supervisor as unknown as Record<string, unknown>).clear = undefined;
    const bridge = new Bridge({ storeDir, supervisorFactory: () => supervisor });
    const { id } = await bridge.startSession({});
    await expect(bridge.clear(id)).rejects.toThrow("does not support clear");
    await bridge.close(id);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/core/src/bridge-clear.test.ts`
Expected: FAIL — `bridge.clear is not a function` (and `clearCalls` missing).

- [ ] **Step 3: Implement** — three small edits:

`packages/core/src/supervisor.ts` — add to the `Supervisor` interface after `interrupt`:

```ts
  /**
   * Reset the driven session's conversation context in place (e.g. inject
   * /clear into the interactive UI). Optional: supervisors that cannot reset
   * without a restart leave it undefined and Bridge.clear rejects.
   */
  clear?(sessionId: string): Promise<void>;
```

`packages/core/src/types.ts` — add to `ClaudeCodeBridge` after `interrupt`:

```ts
  clear(sessionId: string): Promise<void>;
```

`packages/core/src/bridge.ts` — add a `clear` method to the `Bridge` class directly below `interrupt` (line 209), using the same `#requireSession` lookup and open-state guard:

```ts
  async clear(sessionId: string): Promise<void> {
    const session = this.#requireSession(sessionId);
    if (session.state !== "open") {
      throw new Error(`session is closing: ${sessionId}`);
    }
    if (session.supervisor.clear === undefined) {
      throw new Error("supervisor does not support clear");
    }
    await session.supervisor.clear(sessionId);
  }
```

`packages/claude-code/src/mock-supervisor.ts` — add a recording seam to `MockSupervisor`:

```ts
  #clearCalls = 0;

  /** Number of clear() invocations. Test seam for pool/bridge tests. */
  get clearCalls(): number {
    return this.#clearCalls;
  }

  async clear(sessionId: string): Promise<void> {
    if (sessionId !== this.#ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    this.#clearCalls += 1;
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/core/src/bridge-clear.test.ts && bun test packages/core packages/claude-code`
Expected: PASS, no regressions in existing suites.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add packages/core/src/supervisor.ts packages/core/src/types.ts packages/core/src/bridge.ts packages/claude-code/src/mock-supervisor.ts packages/core/src/bridge-clear.test.ts
git commit -m "feat(core): Bridge.clear with optional supervisor clear support"
```

---

### Task 8: `ClaudeCodeSupervisor.clear()` + `cleanSession` / `rawModel` launch options

**Files:**
- Modify: `packages/claude-code/src/claude-supervisor.ts`
- Test: `packages/claude-code/src/claude-supervisor.test.ts` (append tests)

Look at the existing tests in `claude-supervisor.test.ts` first — they already use a fake `launcherFactory` capturing `(command, args)` and a fake launcher with a `write` recorder; reuse those fixtures.

- [ ] **Step 1: Write failing tests** (append to `claude-supervisor.test.ts`, using the file's existing fake-launcher fixture pattern)

```ts
describe("clear", () => {
  test("writes escape then /clear to the PTY", async () => {
    // Use the existing started-supervisor fixture from this file; the fake
    // launcher records writes in order.
    const { supervisor, launcher, sessionId } = await startSupervisorFixture();
    await supervisor.clear(sessionId);
    const writes = launcher.writes.join("");
    expect(writes).toContain("\x1b");
    expect(writes).toContain("/clear\r");
    expect(launcher.writes.indexOf("\x1b")).toBeLessThan(launcher.writes.indexOf("/clear\r"));
  });

  test("rejects before start", async () => {
    const supervisor = new ClaudeCodeSupervisor({ launcherFactory: fakeLauncherFactory() });
    await expect(supervisor.clear("s1")).rejects.toThrow("not started");
  });
});

describe("cleanSession / rawModel launch args", () => {
  test("cleanSession swaps user-tier trimming for --safe-mode", async () => {
    const { args } = await captureSpawnArgs({ cleanSession: true });
    expect(args).toContain("--safe-mode");
    expect(args).not.toContain("--disable-slash-commands");
    expect(args).not.toContain("--setting-sources");
  });

  test("default keeps the existing trimming flags and no --safe-mode", async () => {
    const { args } = await captureSpawnArgs({});
    expect(args).not.toContain("--safe-mode");
    expect(args).toContain("--disable-slash-commands");
  });

  test("rawModel adds --disallowed-tools with the built-in list", async () => {
    const { args } = await captureSpawnArgs({ rawModel: true });
    const i = args.indexOf("--disallowed-tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toContain("Bash");
    expect(args[i + 1]).toContain("Edit");
  });

  test("cleanSession with plugin channels throws at construction", () => {
    expect(
      () => new ClaudeCodeSupervisor({ channels: "plugin", cleanSession: true }),
    ).toThrow("cleanSession requires dev-flag channels");
  });
});
```

(`startSupervisorFixture` / `captureSpawnArgs` / `fakeLauncherFactory` are whatever the file already names its fixtures — adapt the test code to the existing helper names rather than duplicating them.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/claude-code/src/claude-supervisor.test.ts`
Expected: FAIL — `clear is not a function`, unknown option errors.

- [ ] **Step 3: Implement** in `claude-supervisor.ts`:

Options (add to `ClaudeCodeSupervisorOptions`):

```ts
  /**
   * Launch the driven session with --safe-mode: no operator plugins, hooks,
   * MCP servers, skills, CLAUDE.md, or auto-memory. Requires claude >= 2.1.169
   * and dev-flag channels (the channel arrives via --mcp-config; in plugin
   * mode safe-mode would sever the channel itself). Replaces the
   * --setting-sources/--disable-slash-commands trim (slash commands must stay
   * available for clear()).
   */
  readonly cleanSession?: boolean;
  /**
   * Disallow claude's own built-in tools so the session can only answer via
   * the bridge tools — it behaves like a bare model rather than an agent.
   */
  readonly rawModel?: boolean;
```

Constants and constructor:

```ts
const DISALLOWED_BUILTIN_TOOLS =
  "Bash Edit Write Read Glob Grep WebFetch WebSearch Task NotebookEdit TodoWrite";
```

```ts
  readonly #cleanSession: boolean;
  readonly #rawModel: boolean;
  // in the constructor body:
  this.#cleanSession = options.cleanSession ?? false;
  this.#rawModel = options.rawModel ?? false;
  if (this.#cleanSession && this.#channels === "plugin") {
    throw new Error("cleanSession requires dev-flag channels");
  }
```

In `#buildClaudeArgs` dev-flag branch, replace the two fixed trim flags:

```ts
      if (this.#cleanSession) {
        // --safe-mode supersedes the user-tier trim AND keeps /clear usable
        // (--disable-slash-commands would block the clear() injection).
        args.push("--safe-mode");
      } else {
        args.push("--setting-sources", "project,local");
        args.push("--disable-slash-commands");
      }
```

After the `--allowed-tools` push at the end of `#buildClaudeArgs`:

```ts
    if (this.#rawModel) {
      args.push("--disallowed-tools", DISALLOWED_BUILTIN_TOOLS);
    }
```

The `clear` method on the class (next to `interrupt`, which shows the started-state guard pattern):

```ts
  async clear(sessionId: string): Promise<void> {
    const launcher = this.#launcher;
    if (!this.#ctx || !launcher) throw new Error("supervisor not started");
    if (sessionId !== this.#ctx.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    // Escape first dismisses any transient UI state (autocomplete popup,
    // half-typed text); the pool only clears idle sessions so the input box
    // is otherwise empty.
    launcher.write("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 50));
    launcher.write("/clear\r");
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/claude-code`
Expected: PASS including all pre-existing supervisor tests.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add packages/claude-code/src/claude-supervisor.ts packages/claude-code/src/claude-supervisor.test.ts
git commit -m "feat(claude-code): clear() PTY injection and cleanSession/rawModel launch options"
```

---

### Task 9: SessionPool

**Files:**
- Create: `packages/http/src/pool.ts`
- Test: `packages/http/src/pool.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/http/src/pool.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { MockSupervisor } from "@ccb/claude-code";
import { Bridge } from "@ccb/core";
import { SessionPool } from "./pool.ts";

const storeDir = `/tmp/ccb-pool-test-${crypto.randomUUID()}`;
afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

function makeBridge(supervisors: MockSupervisor[]): Bridge {
  return new Bridge({
    storeDir,
    supervisorFactory: () => {
      const s = new MockSupervisor();
      supervisors.push(s);
      return s;
    },
  });
}

describe("SessionPool", () => {
  test("clears the session before handing it to the turn", async () => {
    const supervisors: MockSupervisor[] = [];
    const bridge = makeBridge(supervisors);
    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    await pool.withSession(async () => {});
    expect(supervisors[0]?.clearCalls).toBe(1);
    await pool.close();
  });

  test("serializes concurrent turns on a size-1 pool (FIFO)", async () => {
    const bridge = makeBridge([]);
    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = pool.withSession(async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
    });
    const second = pool.withSession(async () => {
      order.push("second-start");
    });
    // Give the second a chance to (incorrectly) start early.
    await new Promise((r) => setTimeout(r, 20));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
    await pool.close();
  });

  test("a turn failure respawns a fresh session and the pool keeps serving", async () => {
    const supervisors: MockSupervisor[] = [];
    const bridge = makeBridge(supervisors);
    const pool = new SessionPool({ bridge, size: 1 });
    await pool.start();
    await expect(
      pool.withSession(async () => {
        supervisors[0]?.triggerCrash();
        throw new Error("turn failed: session crashed");
      }),
    ).rejects.toThrow("turn failed");
    // The pool replaced the crashed session; a new turn works.
    await pool.withSession(async (sessionId) => {
      expect(typeof sessionId).toBe("string");
    });
    expect(supervisors.length).toBe(2);
    await pool.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/http/src/pool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/http/src/pool.ts
import type { ClaudeCodeBridge } from "@ccb/core";

export interface SessionPoolOptions {
  readonly bridge: ClaudeCodeBridge;
  readonly size: number;
}

/**
 * Fixed-size pool of warm bridge sessions. One in-flight turn per session;
 * excess callers queue FIFO. Every turn gets a cleared session. A turn that
 * throws is assumed to have poisoned its session: the session is closed
 * (best effort) and replaced with a fresh one before the next waiter runs.
 */
export class SessionPool {
  readonly #bridge: ClaudeCodeBridge;
  readonly #size: number;
  readonly #idle: string[] = [];
  readonly #waiters: Array<(sessionId: string) => void> = [];
  #closed = false;

  constructor(options: SessionPoolOptions) {
    if (options.size < 1) throw new Error("pool size must be >= 1");
    this.#bridge = options.bridge;
    this.#size = options.size;
  }

  /** The bridge the pool wraps; turn executors run against it. */
  get bridge(): ClaudeCodeBridge {
    return this.#bridge;
  }

  async start(): Promise<void> {
    for (let i = 0; i < this.#size; i++) {
      const { id } = await this.#bridge.startSession({});
      this.#idle.push(id);
    }
  }

  async withSession<T>(fn: (sessionId: string) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("pool is closed");
    const sessionId = await this.#acquire();
    try {
      await this.#bridge.clear(sessionId);
      const result = await fn(sessionId);
      this.#release(sessionId);
      return result;
    } catch (err) {
      await this.#replace(sessionId);
      throw err;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const ids = this.#idle.splice(0);
    await Promise.allSettled(ids.map((id) => this.#bridge.close(id)));
  }

  #acquire(): Promise<string> {
    const id = this.#idle.shift();
    if (id !== undefined) return Promise.resolve(id);
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #release(sessionId: string): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(sessionId);
    else this.#idle.push(sessionId);
  }

  async #replace(sessionId: string): Promise<void> {
    try {
      await this.#bridge.close(sessionId);
    } catch {
      // already dead — that's why we're replacing it
    }
    if (this.#closed) return;
    try {
      const { id } = await this.#bridge.startSession({});
      this.#release(id);
    } catch (err) {
      // Pool shrinks if respawn fails; surfaces as queue starvation rather
      // than a hidden crash loop.
      console.error(`SessionPool: respawn failed: ${String(err)}`);
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/http/src/pool.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add export + commit**

Add `export * from "./pool.ts";` to `packages/http/src/index.ts`.

```bash
bun run typecheck
git add packages/http/src/pool.ts packages/http/src/pool.test.ts packages/http/src/index.ts
git commit -m "feat(http): fixed-size warm session pool with clear-before-turn"
```

---

### Task 10: Turn executor

**Files:**
- Create: `packages/http/src/turn.ts`
- Test: `packages/http/src/turn.test.ts`

The executor runs ONE turn: subscribe to events **before** sending (live-tail semantics — subscribing after `sendMessage` can miss events), send the prompt, stream deltas, finish on `agent.reply{final:true}` or `agent.done`, bounded by a timeout.

- [ ] **Step 1: Write failing tests**

```ts
// packages/http/src/turn.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge } from "@ccb/core";
import { runTurn } from "./turn.ts";

const storeDir = `/tmp/ccb-turn-test-${crypto.randomUUID()}`;
afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("runTurn", () => {
  test("collects deltas and the final content", async () => {
    const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
    const { id } = await bridge.startSession({});
    const deltas: string[] = [];
    const result = await runTurn({
      bridge,
      sessionId: id,
      prompt: "ping",
      timeoutMs: 10_000,
      onDelta: (d) => deltas.push(d),
    });
    // MockSupervisor emits progress "thinking" then reply "echo: <content>".
    expect(result.content).toBe("echo: ping");
    expect(deltas).toEqual(["thinking", "echo: ping"]);
    await bridge.close(id);
  });

  test("times out when no terminal event arrives", async () => {
    const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
    const { id } = await bridge.startSession({});
    // Never send through the bridge channel: call runTurn against a prompt
    // the mock will answer, but with an absurdly small timeout so the timer
    // wins the race deterministically is flaky — instead use timeoutMs: 1
    // and assert the error message either way.
    await expect(
      runTurn({ bridge, sessionId: id, prompt: "ping", timeoutMs: 1 }),
    ).rejects.toThrow("turn timed out");
    await bridge.close(id);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/http/src/turn.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/http/src/turn.ts
import type { ClaudeCodeBridge } from "@ccb/core";

export interface RunTurnOptions {
  readonly bridge: ClaudeCodeBridge;
  readonly sessionId: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  /** Invoked for each progress/partial-reply delta as it arrives. */
  readonly onDelta?: (delta: string) => void;
}

export interface TurnResult {
  /** Final reply content; empty string if the turn ended via agent.done only. */
  readonly content: string;
}

/**
 * Run exactly one turn against an open session. Subscribes to the live event
 * stream BEFORE sending so no event is missed, then resolves on the first
 * turn-terminal event: agent.reply{final:true} or agent.done (both must be
 * handled — agent.done is the only signal for a no-reply turn).
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
  const { bridge, sessionId, prompt, timeoutMs, onDelta } = options;
  const events = bridge.events(sessionId);

  const turn = (async (): Promise<TurnResult> => {
    await bridge.sendMessage(sessionId, prompt);
    let finalContent = "";
    for await (const ev of events) {
      if (ev.type === "agent.progress") {
        onDelta?.(ev.content);
        continue;
      }
      if (ev.type === "agent.reply") {
        onDelta?.(ev.content);
        if (ev.final) return { content: ev.content };
        finalContent += ev.content;
        continue;
      }
      if (ev.type === "agent.done") return { content: finalContent };
      if (ev.type === "session.ended") {
        throw new Error(`session ended mid-turn${ev.reason ? `: ${ev.reason}` : ""}`);
      }
    }
    throw new Error("event stream closed without a terminal event");
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`turn timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([turn, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

Note: the iterator subscription happens at the `bridge.events(sessionId)` call (subscribe-time forward); calling it before `sendMessage` inside the async closure preserves ordering. If the first test reveals events are missed because the async generator only subscribes on first `next()`, hoist a manual iterator and prime it: `const it = events[Symbol.asyncIterator]();` before `sendMessage`, then loop with `await it.next()`. Check `packages/core/src/bus.ts` subscription semantics if this occurs.

- [ ] **Step 4: Run tests**

Run: `bun test packages/http/src/turn.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add export + commit**

Add `export * from "./turn.ts";` to `packages/http/src/index.ts`.

```bash
bun run typecheck
git add packages/http/src/turn.ts packages/http/src/turn.test.ts packages/http/src/index.ts
git commit -m "feat(http): single-turn executor over the bridge event stream"
```

---

### Task 11: HTTP server (routes, SSE, errors, auth)

**Files:**
- Create: `packages/http/src/server.ts`
- Test: `packages/http/src/server.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// packages/http/src/server.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { mockSupervisorFactory } from "@ccb/claude-code";
import { Bridge } from "@ccb/core";
import { SessionPool } from "./pool.ts";
import { startApiServer } from "./server.ts";

const storeDir = `/tmp/ccb-server-test-${crypto.randomUUID()}`;
let pool: SessionPool;
let server: Awaited<ReturnType<typeof startApiServer>>;

beforeEach(async () => {
  const bridge = new Bridge({ storeDir, supervisorFactory: mockSupervisorFactory() });
  pool = new SessionPool({ bridge, size: 1 });
  await pool.start();
  server = await startApiServer({ pool, host: "127.0.0.1", port: 0, turnTimeoutMs: 10_000 });
});

afterEach(async () => {
  await server.stop();
  await pool.close();
  await rm(storeDir, { recursive: true, force: true });
});

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("GET /v1/models", () => {
  test("lists the facade model", async () => {
    const res = await fetch(`${server.url}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    expect(body.data[0]?.id).toBe("ccb-claude");
  });
});

describe("POST /v1/chat/completions", () => {
  test("non-streaming echo round trip", async () => {
    const res = await post("/v1/chat/completions", {
      model: "ccb-claude",
      messages: [{ role: "user", content: "marco" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toContain("marco");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  test("streaming emits chunks then [DONE]", async () => {
    const res = await post("/v1/chat/completions", {
      model: "ccb-claude",
      stream: true,
      messages: [{ role: "user", content: "marco" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: "));
    expect(dataLines.at(-1)).toBe("data: [DONE]");
    const parsed = dataLines.slice(0, -1).map((l) => JSON.parse(l.slice("data: ".length)));
    expect(parsed[0]?.object).toBe("chat.completion.chunk");
    const contents = parsed.flatMap((c) => (c.choices[0].delta.content ? [c.choices[0].delta.content] : []));
    expect(contents.join("")).toContain("marco");
    const finals = parsed.filter((c) => c.choices[0].finish_reason !== null);
    expect(finals).toHaveLength(1);
  });

  test("invalid body is a 400 in OpenAI error shape", async () => {
    const res = await post("/v1/chat/completions", { model: "m" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; type: string } };
    expect(body.error.message).toContain("messages");
    expect(body.error.type).toBe("invalid_request_error");
  });

  test("unknown route is 404", async () => {
    const res = await fetch(`${server.url}/v2/nope`);
    expect(res.status).toBe(404);
  });
});

describe("auth", () => {
  test("when apiKey is configured, missing/wrong bearer is 401", async () => {
    const bridge = new Bridge({
      storeDir: `${storeDir}-auth`,
      supervisorFactory: mockSupervisorFactory(),
    });
    const authedPool = new SessionPool({ bridge, size: 1 });
    await authedPool.start();
    const authed = await startApiServer({
      pool: authedPool,
      host: "127.0.0.1",
      port: 0,
      turnTimeoutMs: 10_000,
      apiKey: "sekrit",
    });
    try {
      const noKey = await fetch(`${authed.url}/v1/models`);
      expect(noKey.status).toBe(401);
      const withKey = await fetch(`${authed.url}/v1/models`, {
        headers: { authorization: "Bearer sekrit" },
      });
      expect(withKey.status).toBe(200);
    } finally {
      await authed.stop();
      await authedPool.close();
      await rm(`${storeDir}-auth`, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/http/src/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/http/src/server.ts
import { validateChatRequest } from "./openai-types.ts";
import { renderTranscript } from "./renderer.ts";
import { buildChunk, buildCompletion, newCompletionId } from "./response.ts";
import type { SessionPool } from "./pool.ts";
import { parseReply } from "./tool-call-parser.ts";
import { runTurn } from "./turn.ts";

export const FACADE_MODEL_ID = "ccb-claude";

export interface ApiServerOptions {
  readonly pool: SessionPool;
  readonly host: string;
  readonly port: number;
  readonly turnTimeoutMs: number;
  readonly apiKey?: string;
}

export interface ApiServerHandle {
  readonly url: string;
  stop(): Promise<void>;
}

function errorResponse(status: number, type: string, message: string): Response {
  return Response.json({ error: { message, type, param: null, code: null } }, { status });
}

const IGNORED_PARAMS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "n",
  "logprobs",
  "response_format",
];
const warnedParams = new Set<string>();

function warnIgnoredParams(body: Record<string, unknown>): void {
  for (const p of IGNORED_PARAMS) {
    if (body[p] !== undefined && !warnedParams.has(p)) {
      warnedParams.add(p);
      console.error(`ccb api: ignoring unsupported parameter '${p}' (logged once)`);
    }
  }
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const { pool, turnTimeoutMs, apiKey } = options;

  async function handleCompletions(req: Request): Promise<Response> {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return errorResponse(400, "invalid_request_error", "request body must be valid JSON");
    }
    const validated = validateChatRequest(raw);
    if (!validated.ok) {
      return errorResponse(400, "invalid_request_error", validated.error);
    }
    warnIgnoredParams(raw as Record<string, unknown>);
    const request = validated.value;
    const prompt = renderTranscript(request.messages, request.tools);
    const buffered = request.tools.length > 0;

    if (!request.stream) {
      try {
        const result = await pool.withSession((sessionId) =>
          runTurn({ bridge: pool.bridge, sessionId, prompt, timeoutMs: turnTimeoutMs }),
        );
        const parsed = parseReply(result.content);
        return Response.json(buildCompletion({ model: request.model, prompt, parsed }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = message.includes("timed out") ? 504 : 500;
        return errorResponse(status, "server_error", message);
      }
    }

    const id = newCompletionId();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (data: unknown) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        try {
          let sentRole = false;
          const result = await pool.withSession((sessionId) =>
            runTurn({
              bridge: pool.bridge,
              sessionId,
              prompt,
              timeoutMs: turnTimeoutMs,
              onDelta: (delta) => {
                if (buffered) return; // tool turns are buffered until parseable
                if (!sentRole) {
                  sentRole = true;
                  send(buildChunk({ id, model: request.model, delta: { role: "assistant" } }));
                }
                send(buildChunk({ id, model: request.model, delta: { content: delta } }));
              },
            }),
          );
          const parsed = parseReply(result.content);
          if (parsed.kind === "tool_calls") {
            send(
              buildChunk({
                id,
                model: request.model,
                delta: {
                  role: "assistant",
                  tool_calls: parsed.calls.map((c, index) => ({ ...c, index })),
                },
              }),
            );
            send(buildChunk({ id, model: request.model, delta: {}, finishReason: "tool_calls" }));
          } else {
            if (buffered) {
              send(
                buildChunk({
                  id,
                  model: request.model,
                  delta: { role: "assistant", content: parsed.content },
                }),
              );
            }
            send(buildChunk({ id, model: request.model, delta: {}, finishReason: "stop" }));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    idleTimeout: 0,
    async fetch(req: Request): Promise<Response> {
      if (apiKey !== undefined) {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${apiKey}`) {
          return errorResponse(401, "authentication_error", "invalid or missing API key");
        }
      }
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: FACADE_MODEL_ID, object: "model", created: 0, owned_by: "ccb" }],
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        return handleCompletions(req);
      }
      return errorResponse(404, "invalid_request_error", `unknown route: ${url.pathname}`);
    },
  });

  return {
    url: `http://${options.host}:${server.port}`,
    async stop() {
      await server.stop(true);
    },
  };
}
```


- [ ] **Step 4: Run tests**

Run: `bun test packages/http/src/server.test.ts && bun test packages/http`
Expected: PASS (6 new tests, all package tests green).

- [ ] **Step 5: Add export + commit**

Add `export * from "./server.ts";` to `packages/http/src/index.ts`.

```bash
bun run typecheck
git add packages/http/src/server.ts packages/http/src/server.test.ts packages/http/src/pool.ts packages/http/src/index.ts
git commit -m "feat(http): OpenAI-compatible HTTP server with SSE streaming"
```

---

### Task 12: `ccb api` command + acceptance green

**Files:**
- Create: `apps/ccb/src/api.ts`
- Modify: `apps/ccb/src/cli.ts`
- Modify: `apps/ccb/src/api.test.ts` (flip `test.todo` → `test`)

- [ ] **Step 1: Implement runApi**

```ts
// apps/ccb/src/api.ts
import { claudeCodeSupervisorFactory, mockSupervisorFactory } from "@ccb/claude-code";
import type { SupervisorFactory } from "@ccb/core";
import { Bridge } from "@ccb/core";
import { SessionPool, startApiServer } from "@ccb/http";

export interface ApiOptions {
  readonly host: string;
  readonly port: number;
  readonly poolSize: number;
  readonly turnTimeoutMs: number;
  readonly supervisor: "mock" | "claude";
  readonly storeDir: string;
  readonly apiKey?: string;
}

export interface ApiHandle {
  readonly url: string;
  stop(): Promise<void>;
}

function selectFactory(choice: "mock" | "claude"): SupervisorFactory {
  if (choice === "claude") {
    return claudeCodeSupervisorFactory({
      channels: "dev-flag",
      cleanSession: true,
      rawModel: true,
    });
  }
  return mockSupervisorFactory();
}

export async function runApi(options: ApiOptions): Promise<ApiHandle> {
  const bridge = new Bridge({
    storeDir: options.storeDir,
    supervisorFactory: selectFactory(options.supervisor),
    // Clean cold boots of a real claude can take tens of seconds.
    startTimeoutMs: 90_000,
  });
  const pool = new SessionPool({ bridge, size: options.poolSize });
  await pool.start();
  const server = await startApiServer({
    pool,
    host: options.host,
    port: options.port,
    turnTimeoutMs: options.turnTimeoutMs,
    apiKey: options.apiKey,
  });
  return {
    url: server.url,
    async stop() {
      await server.stop();
      await pool.close();
    },
  };
}
```

- [ ] **Step 2: Wire the CLI command** — in `apps/ccb/src/cli.ts`, after the `serve` command registration, add (reusing the file's existing `parsePositiveInt` and `parseSupervisorChoice` helpers):

```ts
  program
    .command("api")
    .description("serve an OpenAI-compatible API backed by a warm claude session pool")
    .option("--host <host>", "address to bind", "127.0.0.1")
    .option("--port <port>", "port to bind", parsePositiveInt, 18_485)
    .option("--pool-size <n>", "number of warm sessions", parsePositiveInt, 1)
    .option(
      "--turn-timeout-ms <ms>",
      "upper bound for a single completion turn",
      parsePositiveInt,
      300_000,
    )
    .option(
      "--supervisor <mock|claude>",
      "supervisor backing the pool: claude (default) or mock (tests)",
      parseSupervisorChoice,
      "claude" as SupervisorChoice,
    )
    .option("--store-dir <path>", "directory for per-session JSONL logs", ".ccb-data")
    .option("--api-key <key>", "require this bearer token on every request")
    .action(
      async (opts: {
        host: string;
        port: number;
        poolSize: number;
        turnTimeoutMs: number;
        supervisor: SupervisorChoice;
        storeDir: string;
        apiKey?: string;
      }) => {
        const api = await runApi(opts);
        process.stdout.write(`ccb api listening on ${api.url}/v1\n`);
        await new Promise<void>((resolve) => {
          process.once("SIGINT", resolve);
          process.once("SIGTERM", resolve);
        });
        await api.stop();
      },
    );
```

Also add `import { runApi } from "./api.ts";` to the imports at the top of `cli.ts`.

- [ ] **Step 3: Un-skip the acceptance test** — in `apps/ccb/src/api.test.ts`, change `test.todo(` to `test(`.

- [ ] **Step 4: Run the acceptance**

Run: `bun test apps/ccb/src/api.test.ts`
Expected: PASS — the outside-in anchor from Task 2 is green.

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `bun test && bun run typecheck && bun run lint`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/ccb/src/api.ts apps/ccb/src/api.test.ts apps/ccb/src/cli.ts
git commit -m "feat(cli): ccb api command serving the OpenAI facade"
```

---

### Task 13: Real-claude smokes + SMOKE.md

**Files:**
- Modify: `docs/SMOKE.md`

These need a real logged-in claude; they are documented commands, run manually from the repo root. **Smoke 1 is the decision gate from the spec** — if `--safe-mode` severs the dev-flag channel, switch `cleanSession` to the `CLAUDE_CONFIG_DIR` fallback (see spec) before continuing.

- [ ] **Step 1: Append an "OpenAI facade (`ccb api`)" section to docs/SMOKE.md**

````markdown
## OpenAI facade (`ccb api`)

All smokes assume a logged-in `claude` >= 2.1.169 on PATH. Start the server
in one terminal and leave it running:

```bash
bun apps/ccb/src/cli.ts api --supervisor claude --pool-size 1
```

### Smoke 1 — clean boot (decision gate)

The pool session must boot with --safe-mode AND still connect the ccb
channel. Watch the server terminal: a successful boot prints the listening
line and the first request below succeeds. If startSession times out, safe
mode severed the --mcp-config channel: switch cleanSession to the
CLAUDE_CONFIG_DIR fallback documented in
docs/2026-06-10-openai-facade-design.md and re-run.

```bash
curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ccb-claude","messages":[{"role":"user","content":"Reply with exactly the word: pong"}]}' | jq .
```

Expected: choices[0].message.content contains "pong". The session must show
no operator customizations (no claude-mem observations, no plugin hooks in
the reply context).

### Smoke 2 — /clear isolation between requests

```bash
curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ccb-claude","messages":[{"role":"user","content":"Remember this codeword: ZANZIBAR. Reply OK."}]}' | jq -r '.choices[0].message.content'

curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ccb-claude","messages":[{"role":"user","content":"What codeword did I give you earlier? If none, say NONE."}]}' | jq -r '.choices[0].message.content'
```

Expected: second reply says NONE (the /clear between turns wiped the first
request's context). If it answers ZANZIBAR, /clear injection is broken.

### Smoke 3 — tool-calling round trip

```bash
curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "ccb-claude",
    "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
    "tools": [{"type": "function", "function": {"name": "get_weather",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}}}}]
  }' | jq '.choices[0]'
```

Expected: finish_reason "tool_calls" and a get_weather call with city Paris.
Then complete the round trip (substitute the printed tool_call id):

```bash
curl -s http://127.0.0.1:18485/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "ccb-claude",
    "messages": [
      {"role": "user", "content": "What is the weather in Paris? Use the tool."},
      {"role": "assistant", "content": null, "tool_calls": [{"id": "<ID>", "type": "function",
        "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"}}]},
      {"role": "tool", "tool_call_id": "<ID>", "content": "{\"temp_c\": 18, \"sky\": \"sunny\"}"}
    ]
  }' | jq -r '.choices[0].message.content'
```

Expected: a sentence reporting ~18°C / sunny, finish_reason "stop".

### Smoke 4 — litellm end to end (non-streaming + streaming)

```bash
uv run --with litellm scripts/litellm-smoke.py
```

Expected: prints both replies and `OK`, exit 0.
````

- [ ] **Step 2: Run all four smokes** and record outcomes. If Smoke 1 fails at the gate, implement the fallback (swap `--safe-mode` for `CLAUDE_CONFIG_DIR` env injection in `ClaudeCodeSupervisor` — set `env.CLAUDE_CONFIG_DIR` to a per-session temp dir seeded with a copy of `~/.claude/.credentials.json` chmod 600 — with a red test on the spawn env first), then re-run.

- [ ] **Step 3: Commit**

```bash
git add docs/SMOKE.md
git commit -m "docs(smoke): OpenAI facade smoke runbook"
```

---

### Task 14: Post-task review

- [ ] Run the project's standard local review loop against the branch diff: `/pr-review-multi --models claude,gemini,codex` on `git diff main...` (user's standing post-task practice). Address findings, commit fixes.

---

## Self-review notes (resolved during planning)

- **`--disable-slash-commands` vs `/clear`:** current dev-flag args block slash commands, which would break `clear()`. Resolved: `cleanSession` replaces that flag with `--safe-mode` (Task 8), and non-clean sessions keep the old behavior — `clear()` on a non-clean dev-flag session will not work; the facade always uses `cleanSession: true`.
- **Event-stream subscription timing:** `runTurn` subscribes before sending; Task 10 documents the fallback (manual iterator priming) if live-tail semantics subscribe lazily.
- **Spec coverage check:** stateless lifecycle (Tasks 9–11), clean session (8, 13), raw-model (8), rendering (4), tool emulation (5, 13), streaming (11), errors/timeouts (10, 11), config flags (12), usage estimate (6), LiteLLM zero-change consumption (2, 13). The spec's `--cwd` flag is dropped: sessions anchor to the server's working directory (`--add-dir` uses `process.cwd()` already); start `ccb api` from the desired directory instead — noted here as a deliberate YAGNI deviation.
