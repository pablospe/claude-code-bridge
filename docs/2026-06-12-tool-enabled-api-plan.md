# Tool-enabled `ccb api` (M5 permission relay) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the M5 permission relay (per `docs/M5.md`) and an allowlist policy layer so `ccb api --allow-tools ...` runs pool sessions with Claude's built-in tools enabled.

**Architecture:** Two new frames on the existing JSON-lines control transport carry the permission request (claude → bridge) and verdict (bridge → claude). The channel server declares the `claude/channel/permission` capability only when opted in via `CCB_PERMISSION_RELAY=1`. `Bridge` tracks open requests per session and exposes `respond()`; `SessionPool` answers `permission.requested` events from an allowlist policy. Allowlisted tools are additionally pre-approved at launch via `--allowed-tools`, so the relay is only the deny backstop on the hot path.

**Tech Stack:** Bun + TypeScript workspaces, zod, @modelcontextprotocol/sdk, bun:test. Spec: `docs/2026-06-12-tool-enabled-api-design.md`; authoritative M5 detail: `docs/M5.md`.

**Conventions (apply to every task):**
- TDD: write the failing test, see it fail, implement, see it pass, commit.
- `git add` only the specific files you touched — never `git add -A` or `git add .`.
- Commit messages: no Claude/AI mention.
- Run `bun run typecheck && bun run lint` before each commit.
- Known suite quirk: run the full suite with `bun test`; all 510+ tests must stay green.

---

## File map

| File | Change |
|---|---|
| `scripts/spike-permission/server.ts` + `run.ts` | NEW, throwaway live spike |
| `docs/2026-06-12-spike-findings.md` | NEW, spike results |
| `packages/mcp-channel/src/control.ts` | 2 frames; client send + callback; server event + `respond()` |
| `packages/mcp-channel/src/control.test.ts` | frame round-trip tests |
| `packages/mcp-channel/src/channel-server.ts` | capability opt-in, notification handler, `respondPermission` |
| `packages/mcp-channel/src/channel-server.test.ts` | capability + handler tests |
| `packages/mcp-channel/src/bin.ts` | env opt-in + wiring both directions |
| `packages/claude-code/src/config.ts` (+ test) | `enablePermissionRelay` → `CCB_PERMISSION_RELAY` env |
| `packages/core/src/events.ts` | `permission.requested` / `permission.resolved` variants |
| `apps/ccb/src/format.ts` (+ test) | two new `formatPretty` arms |
| `packages/core/src/supervisor.ts` | optional `respond?()` |
| `packages/claude-code/src/claude-supervisor.ts` (+ test) | options, event wiring, `respond()`, `--allowed-tools` extension |
| `packages/core/src/bridge.ts` (+ test) | registry, `respond()`, timeout, abort flush, `permissionTimeoutMs` |
| `packages/claude-code/src/mock-supervisor.ts` | `respond` + `triggerPermissionRequest` test seams |
| `packages/http/src/permission-policy.ts` (+ test) | NEW `createAllowlistPolicy` |
| `packages/http/src/pool.ts` (+ test) | `permissionPolicy` option, per-session watcher |
| `apps/ccb/src/cli.ts` (+ test), `apps/ccb/src/api.ts` (+ test) | `--allow-tools` plumbing |
| `docs/SMOKE.md`, `README.md`, `docs/ROADMAP.md`, `docs/M5.md` | docs + status |

---

### Task 1: Live spike — verify the relay protocol against real claude

**Files:**
- Create: `scripts/spike-permission/server.ts`
- Create: `scripts/spike-permission/run.ts`
- Create: `docs/2026-06-12-spike-findings.md`

This task verifies, against real claude (2.1.174, dev-flag launch path), that (a) `notifications/claude/channel/permission_request` arrives at a channel declaring the `claude/channel/permission` capability, (b) an `allow` verdict notification unblocks the gated tool call, and (c) `--allowed-tools <name>` pre-approves a built-in tool so no prompt fires. **If (a) or (b) fails, STOP — report BLOCKED with the captured logs; the design must be revisited.**

- [ ] **Step 1: Write the spike MCP server**

`scripts/spike-permission/server.ts` — a stdio MCP server like `packages/mcp-channel/src/bin.ts` but standalone: declares both capabilities, logs every permission request to `CCB_SPIKE_LOG` (JSON lines), immediately replies `allow`.

```ts
#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const LOG = process.env.CCB_SPIKE_LOG;
if (!LOG) throw new Error("CCB_SPIKE_LOG is required");
const log = (entry: Record<string, unknown>): void => {
  appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};

const server = new Server(
  { name: "ccb-spike", version: "0.0.1" },
  {
    capabilities: {
      experimental: { "claude/channel": {}, "claude/channel/permission": {} },
    },
  },
);

const PermissionRequestNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

server.setNotificationHandler(PermissionRequestNotificationSchema, async (n) => {
  log({ kind: "permission_request", ...n.params });
  await server.notification({
    method: "notifications/claude/channel/permission",
    params: { request_id: n.params.request_id, behavior: "allow" },
  });
  log({ kind: "verdict_sent", request_id: n.params.request_id, behavior: "allow" });
});

server.oninitialized = () => log({ kind: "initialized" });
await server.connect(new StdioServerTransport());
log({ kind: "connected" });
```

- [ ] **Step 2: Write the spike driver**

`scripts/spike-permission/run.ts` — launches real claude over a PTY with the dev-flag/cleanSession recipe (mirrors `claude-supervisor.ts#buildClaudeArgs`), auto-confirms the dev-channels gate with blind `\r` writes, types a prompt that forces a Bash call, and polls the log + proof file. Run `bun scripts/spike-permission/run.ts` (phase A) and `bun scripts/spike-permission/run.ts --pre-approve` (phase B).

```ts
#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "@ccb/process";

const preApprove = process.argv.includes("--pre-approve");
const dir = await mkdtemp(join(tmpdir(), "ccb-spike-"));
const logPath = join(dir, "spike.jsonl");
const proofPath = join(dir, `proof-${Date.now()}`);
await writeFile(logPath, "");

const serverPath = resolve(import.meta.dirname, "server.ts");
const mcpPath = join(dir, "mcp.json");
await writeFile(
  mcpPath,
  JSON.stringify({
    mcpServers: {
      ccb: {
        command: process.execPath,
        args: [serverPath],
        env: { CCB_SPIKE_LOG: logPath },
      },
    },
  }),
);

const args = [
  "--dangerously-load-development-channels", "server:ccb",
  "--mcp-config", mcpPath,
  "--strict-mcp-config",
  "--setting-sources", "project,local",
  "--add-dir", dir,
];
if (preApprove) args.push("--allowed-tools", "Bash");

const child = launch("claude", args, { env: { ...process.env } as Record<string, string> });
const out: string[] = [];
child.onData((chunk) => out.push(chunk));

// Blind dev-channels confirm (mirrors supervisor auto-confirm: 500ms, then every 3s x6).
const confirms = [500, 3500, 6500, 9500, 12500, 15500].map((ms) =>
  setTimeout(() => child.write("\r"), ms),
);

// After boot settles, type the prompt that forces a Bash call.
setTimeout(() => {
  child.write(`Use the Bash tool to run exactly this command: touch ${proofPath}\r`);
}, 18_000);

const deadline = Date.now() + 120_000;
let sawRequest = false;
let proof = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  const log = await readFile(logPath, "utf8").catch(() => "");
  sawRequest = log.includes('"permission_request"');
  proof = await readFile(proofPath).then(() => true, () => false);
  if (proof && (preApprove ? true : sawRequest)) break;
}
for (const t of confirms) clearTimeout(t);
await child.kill("graceful", { gracefulInput: "/exit\r" }).catch(() => child.kill("force"));

console.log(JSON.stringify({ preApprove, sawRequest, proof, logPath, dir }, null, 2));
console.log(await readFile(logPath, "utf8"));
if (preApprove) {
  // Pre-approval must produce the proof WITHOUT a permission_request.
  process.exit(proof && !sawRequest ? 0 : 1);
}
process.exit(proof && sawRequest ? 0 : 1);
await rm(dir, { recursive: true, force: true });
```

Note: `launch`'s exact signature is in `packages/process/src/launcher.ts` — adapt the call if it differs (it returns a handle with `write`/`onData`/`kill`). The spike is throwaway code; iterate freely on timings (boot settle, confirm cadence) until claude reliably reaches the prompt. What must NOT be negotiated away: the capability declaration, the notification schema, and the verdict shape — those are the protocol facts under test.

- [ ] **Step 3: Run phase A (relay round-trip)**

Run: `bun scripts/spike-permission/run.ts`
Expected: exit 0; output shows `sawRequest: true, proof: true`; the log contains a `permission_request` entry with `request_id`/`tool_name`/`description`/`input_preview` and a `verdict_sent` entry. Capture the exact `permission_request` params JSON.

- [ ] **Step 4: Run phase B (pre-approval)**

Run: `bun scripts/spike-permission/run.ts --pre-approve`
Expected: exit 0; `proof: true, sawRequest: false` — `--allowed-tools Bash` suppressed the prompt entirely.

- [ ] **Step 5: Record findings**

Write `docs/2026-06-12-spike-findings.md`: claude version, both phase outcomes, the verbatim `permission_request` params observed, any deviation from `docs/M5.md` (field names, casing, timing). If a deviation affects the schemas in Tasks 2–3, note the corrected shape — later tasks must use the observed truth.

- [ ] **Step 6: Commit**

```bash
git add scripts/spike-permission/server.ts scripts/spike-permission/run.ts docs/2026-06-12-spike-findings.md
git commit -m "spike: verify channels permission relay round-trip against real claude"
```

---

### Task 2: Control-protocol frames (`permission_request` / `permission_response`)

**Files:**
- Modify: `packages/mcp-channel/src/control.ts`
- Test: `packages/mcp-channel/src/control.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `control.test.ts`; follow the existing real-socket pattern — see the `sendTool` test and its `until()` helper):

```ts
test("ControlClient.sendPermissionRequest reaches the ControlServer permission-request listener", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });
  type Req = { sessionId: string; requestId: string; toolName: string; description: string; inputPreview: string };
  const reqs: Req[] = [];
  server.on("permission-request", (sessionId, requestId, toolName, description, inputPreview) => {
    reqs.push({ sessionId, requestId, toolName, description, inputPreview });
  });
  const client = new ControlClient({ endpoint: info.endpoint, sessionId: "sess-p1", onDeliver: () => {} });
  await client.connect();
  await client.sendPermissionRequest("abcde", "Bash", "run ls", '{"command":"ls"}');
  await until(() => reqs.length > 0);
  expect(reqs).toEqual([
    { sessionId: "sess-p1", requestId: "abcde", toolName: "Bash", description: "run ls", inputPreview: '{"command":"ls"}' },
  ]);
  await client.close();
  await server.close();
});

test("ControlServer.respond delivers a permission_response to the client callback", async () => {
  const server = new ControlServer();
  const info = await server.listen({ host: "127.0.0.1", port: 0 });
  const verdicts: Array<{ requestId: string; behavior: "allow" | "deny" }> = [];
  const client = new ControlClient({
    endpoint: info.endpoint,
    sessionId: "sess-p2",
    onDeliver: () => {},
    onPermissionResponse: (requestId, behavior) => {
      verdicts.push({ requestId, behavior });
    },
  });
  await client.connect();
  await server.respond("sess-p2", "abcde", "deny");
  await until(() => verdicts.length > 0);
  expect(verdicts).toEqual([{ requestId: "abcde", behavior: "deny" }]);
  await client.close();
  await server.close();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/mcp-channel/src/control.test.ts`
Expected: FAIL — `sendPermissionRequest is not a function` / type errors on `permission-request`.

- [ ] **Step 3: Implement.** In `control.ts`:

(a) Two schemas + union entries (next to the existing variants, ~L45; union at ~L49):

```ts
const PermissionRequestMessageSchema = z.object({
  type: z.literal("permission_request"),
  requestId: z.string(),
  toolName: z.string(),
  description: z.string(),
  inputPreview: z.string(),
});

const PermissionResponseMessageSchema = z.object({
  type: z.literal("permission_response"),
  requestId: z.string(),
  behavior: z.enum(["allow", "deny"]),
});
```

Append both to the `ControlMessageSchema` discriminated-union array.

(b) `ControlServerEvents` (~L87) gains:

```ts
  "permission-request": (
    sessionId: string,
    requestId: string,
    toolName: string,
    description: string,
    inputPreview: string,
  ) => void;
```

(c) In `ControlServer`'s `#handleSocket` dispatch (~L285, next to the `tool` arm — reuse the same hello-bound `sessionId` the `tool` arm uses):

```ts
if (msg.type === "permission_request") {
  this.#emitter.emit(
    "permission-request",
    sessionId,
    msg.requestId,
    msg.toolName,
    msg.description,
    msg.inputPreview,
  );
  return;
}
```

(d) `ControlServer.respond` (next to `deliver`, mirroring its socket lookup; reuse `deliver`'s exact wait-for-socket code path):

```ts
async respond(sessionId: string, requestId: string, behavior: "allow" | "deny"): Promise<void> {
  let socket = this.#sessionSockets.get(sessionId);
  if (!socket) {
    socket = await this.#waitForSessionSocket(sessionId, DEFAULT_DELIVER_WAIT_MS);
  }
  await writeLineNormal(socket, { type: "permission_response", requestId, behavior }, writeTimeoutMs());
}
```

(e) `ControlClientOptions` gains `readonly onPermissionResponse?: (requestId: string, behavior: "allow" | "deny") => void;` (store it in the constructor like `onDeliver`).

(f) Client `readLines` dispatch (~L436) gains:

```ts
if (msg.type === "permission_response") {
  this.#onPermissionResponse?.(msg.requestId, msg.behavior);
  return;
}
```

(g) `ControlClient.sendPermissionRequest` (mirror `sendTool`):

```ts
async sendPermissionRequest(
  requestId: string,
  toolName: string,
  description: string,
  inputPreview: string,
): Promise<void> {
  const socket = this.#socket;
  if (!socket) throw new Error("not connected");
  await writeLineNormal(
    socket,
    { type: "permission_request", requestId, toolName, description, inputPreview },
    writeTimeoutMs(),
  );
}
```

- [ ] **Step 4: Run tests** — `bun test packages/mcp-channel/src/control.test.ts` → PASS; then `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-channel/src/control.ts packages/mcp-channel/src/control.test.ts
git commit -m "feat(mcp-channel): permission_request/permission_response control frames"
```

---

### Task 3: Channel server — capability opt-in, request handler, verdict send

**Files:**
- Modify: `packages/mcp-channel/src/channel-server.ts`
- Test: `packages/mcp-channel/src/channel-server.test.ts`

- [ ] **Step 1: Write the failing tests.** Follow the file's existing pattern (MCP `Client` + `InMemoryTransport` pair; see the existing capability assertion around L282):

```ts
test("permission capability is declared only when enablePermissionRelay is set", async () => {
  const plain = createChannelServer({ sessionId: "s-cap" });
  expect(
    // biome-ignore lint/suspicious/noExplicitAny: reaching into SDK internals for capability assertion
    (plain.server as any)._capabilities.experimental["claude/channel/permission"],
  ).toBeUndefined();

  const enabled = createChannelServer({ sessionId: "s-cap2", enablePermissionRelay: true });
  expect(
    // biome-ignore lint/suspicious/noExplicitAny: reaching into SDK internals for capability assertion
    (enabled.server as any)._capabilities.experimental["claude/channel/permission"],
  ).toEqual({});
});

test("permission_request notification invokes onPermissionRequest with camelCase fields", async () => {
  const reqs: Array<Record<string, string>> = [];
  const handle = createChannelServer({
    sessionId: "s-pr",
    enablePermissionRelay: true,
    onPermissionRequest: (req) => {
      reqs.push({ ...req });
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const peer = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await Promise.all([handle.server.connect(serverTransport), peer.connect(clientTransport)]);
  await peer.notification({
    method: "notifications/claude/channel/permission_request",
    params: { request_id: "abcde", tool_name: "Bash", description: "run ls", input_preview: "{}" },
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(reqs).toEqual([
    { requestId: "abcde", toolName: "Bash", description: "run ls", inputPreview: "{}" },
  ]);
  await peer.close();
  await handle.server.close();
});

test("respondPermission emits the verdict notification", async () => {
  const handle = createChannelServer({ sessionId: "s-rv", enablePermissionRelay: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const seen: Array<Record<string, unknown>> = [];
  const peer = new Client({ name: "t", version: "0" }, { capabilities: {} });
  peer.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel/permission") seen.push(n.params as Record<string, unknown>);
  };
  await Promise.all([handle.server.connect(serverTransport), peer.connect(clientTransport)]);
  await handle.respondPermission("abcde", "allow");
  await new Promise((r) => setTimeout(r, 50));
  expect(seen).toEqual([{ request_id: "abcde", behavior: "allow" }]);
  await peer.close();
  await handle.server.close();
});
```

Adapt the capability-introspection line to however the existing test at ~L282 asserts `claude/channel` — copy that mechanism exactly.

- [ ] **Step 2: Run to verify failure** — `bun test packages/mcp-channel/src/channel-server.test.ts` → FAIL (unknown option / missing method).

- [ ] **Step 3: Implement.** In `channel-server.ts`:

(a) Options + handle:

```ts
export interface PermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputPreview: string;
}

export interface CreateChannelServerOptions {
  readonly sessionId: string;
  readonly onTool?: OnToolCallback;
  readonly onInitialized?: () => void;
  readonly enablePermissionRelay?: boolean;
  readonly onPermissionRequest?: (req: PermissionRequest) => void | Promise<void>;
}

export interface ChannelServerHandle {
  readonly server: Server;
  deliver(content: string, opts?: DeliverOptions): Promise<void>;
  respondPermission(requestId: string, behavior: "allow" | "deny"): Promise<void>;
}
```

(b) Conditional capability (replace the static `experimental` object at ~L139):

```ts
      experimental: options.enablePermissionRelay
        ? { "claude/channel": {}, "claude/channel/permission": {} }
        : { "claude/channel": {} },
```

(c) Notification handler (after the existing `setRequestHandler` calls), registered only when the relay is enabled. The schema keys on the top-level `method` literal — that is the SDK's dispatch key:

```ts
const PermissionRequestNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});
```

```ts
  if (options.enablePermissionRelay) {
    server.setNotificationHandler(PermissionRequestNotificationSchema, async (n) => {
      await options.onPermissionRequest?.({
        requestId: n.params.request_id,
        toolName: n.params.tool_name,
        description: n.params.description,
        inputPreview: n.params.input_preview,
      });
    });
  }
```

(d) Verdict send (next to `deliver`; same `server.notification` surface). Note on M5.md's `oninitialized` concern: a verdict can only answer a request claude sent post-handshake, and `bin.ts` only dials the control connection after `initialized` + settle — so the verdict cannot race the handshake; no extra gate is needed (record this as a comment):

```ts
  // A verdict always answers a permission_request claude emitted after its own
  // MCP handshake completed (bin.ts dials the control link only after
  // `initialized`), so unlike deliver there is no mid-handshake drop window.
  const respondPermission = async (requestId: string, behavior: "allow" | "deny"): Promise<void> => {
    await server.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: requestId, behavior },
    });
  };
```

Return it from the handle. If Task 1's spike findings recorded different field names/casing than `request_id`/`tool_name`/`description`/`input_preview`, use the observed names here and in the test.

- [ ] **Step 4: Run tests** — package tests PASS; `bun run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-channel/src/channel-server.ts packages/mcp-channel/src/channel-server.test.ts
git commit -m "feat(mcp-channel): permission relay capability, request handler, verdict send"
```

---

### Task 4: Channel-server child wiring + mcp.json env opt-in

**Files:**
- Modify: `packages/mcp-channel/src/bin.ts`
- Modify: `packages/claude-code/src/config.ts`
- Test: `packages/claude-code/src/config.test.ts`

- [ ] **Step 1: Failing test** (append to `config.test.ts`, following its existing `generateMcpConfig` tests):

```ts
test("generateMcpConfig sets CCB_PERMISSION_RELAY only when enablePermissionRelay is set", () => {
  const base = generateMcpConfig({ sessionId: "s", endpoint: "tcp://127.0.0.1:1" });
  expect(base.mcpServers.ccb.env.CCB_PERMISSION_RELAY).toBeUndefined();
  const enabled = generateMcpConfig({
    sessionId: "s",
    endpoint: "tcp://127.0.0.1:1",
    enablePermissionRelay: true,
  });
  expect(enabled.mcpServers.ccb.env.CCB_PERMISSION_RELAY).toBe("1");
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/claude-code/src/config.test.ts` → FAIL.

- [ ] **Step 3: Implement.**

`config.ts`: add `readonly enablePermissionRelay?: boolean;` to `McpConfigOptions`; change the env type to `{ readonly CCB_BRIDGE_ENDPOINT: string; readonly CCB_SESSION_ID: string; readonly CCB_PERMISSION_RELAY?: "1" }`; in `generateMcpConfig` build env as:

```ts
        env: {
          CCB_BRIDGE_ENDPOINT: opts.endpoint,
          CCB_SESSION_ID: opts.sessionId,
          ...(opts.enablePermissionRelay ? { CCB_PERMISSION_RELAY: "1" as const } : {}),
        },
```

`bin.ts`: read the flag and wire both directions (the `handle`/`controlClient` mutual reference already exists for `onTool` — follow it):

```ts
const enablePermissionRelay = process.env.CCB_PERMISSION_RELAY === "1";
```

In `createChannelServer({...})` add:

```ts
    enablePermissionRelay,
    onPermissionRequest: async (req) => {
      if (!controlClient) throw new Error("control client not initialized");
      await controlClient.sendPermissionRequest(
        req.requestId,
        req.toolName,
        req.description,
        req.inputPreview,
      );
    },
```

In the `new ControlClient({...})` options add:

```ts
    onPermissionResponse: (requestId, behavior) => {
      void handle.respondPermission(requestId, behavior).catch((err: unknown) => {
        console.error(
          `ccb-channel-server: permission verdict send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
```

- [ ] **Step 4: Run** — `bun test packages/claude-code/src/config.test.ts packages/mcp-channel` → PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-channel/src/bin.ts packages/claude-code/src/config.ts packages/claude-code/src/config.test.ts
git commit -m "feat: thread permission relay opt-in through mcp config env into the channel server child"
```

---

### Task 5: Bridge events + pretty formatting

**Files:**
- Modify: `packages/core/src/events.ts`
- Modify: `apps/ccb/src/format.ts`
- Test: `apps/ccb/src/format.test.ts`

- [ ] **Step 1: Failing tests** (append to `format.test.ts`, matching its existing style):

```ts
test("formatPretty renders permission.requested", () => {
  expect(
    formatPretty({
      type: "permission.requested",
      sessionId: "s",
      requestId: "abcde",
      toolName: "Bash",
      description: "run ls",
      inputPreview: '{"command":"ls"}',
    }),
  ).toBe('[permission.requested] abcde Bash "run ls"');
});

test("formatPretty renders permission.resolved", () => {
  expect(
    formatPretty({ type: "permission.resolved", sessionId: "s", requestId: "abcde", outcome: "allow" }),
  ).toBe("[permission.resolved] abcde allow");
});
```

- [ ] **Step 2: Run to verify failure** — type error (variants don't exist) counts as the red step.

- [ ] **Step 3: Implement.**

`events.ts` — add to the `BridgeEvent` union:

```ts
  | {
      type: "permission.requested";
      sessionId: string;
      requestId: string;
      toolName: string;
      description: string;
      inputPreview: string;
    }
  | {
      type: "permission.resolved";
      sessionId: string;
      requestId: string;
      outcome: "allow" | "deny" | "unanswered-remotely" | "aborted" | "terminal";
      approver?: { userId: string; displayName?: string };
    }
```

`format.ts` — two arms in the `formatPretty` switch (the exhaustiveness `never` tail forces this to compile):

```ts
    case "permission.requested":
      return `[permission.requested] ${event.requestId} ${event.toolName} ${JSON.stringify(event.description)}`;
    case "permission.resolved":
      return `[permission.resolved] ${event.requestId} ${event.outcome}`;
```

- [ ] **Step 4: Run** — `bun test apps/ccb/src/format.test.ts` PASS; **full** `bun run typecheck` (other exhaustive switches may now fail — if any do, add the analogous arm there, mirroring that file's style).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events.ts apps/ccb/src/format.ts apps/ccb/src/format.test.ts
git commit -m "feat(core): permission.requested/permission.resolved bridge events"
```

---

### Task 6: Supervisor layer — optional `respond`, event wiring, launch args

**Files:**
- Modify: `packages/core/src/supervisor.ts`
- Modify: `packages/claude-code/src/claude-supervisor.ts`
- Test: `packages/claude-code/src/claude-supervisor.test.ts`

- [ ] **Step 1: Failing tests** (append to `claude-supervisor.test.ts`; use the existing `startWithFakeLauncher` harness — its `helloClient` is a real `ControlClient` against the supervisor's real `ControlServer`):

```ts
test("permission-request from the channel surfaces as a permission.requested event", async () => {
  const { supervisor, emitted, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    enablePermissionRelay: true,
  });
  await startResult;
  await helloClient.sendPermissionRequest("abcde", "Bash", "run ls", "{}");
  await waitFor(() => emitted.some((e) => e.type === "permission.requested"));
  expect(emitted.find((e) => e.type === "permission.requested")).toEqual({
    type: "permission.requested",
    sessionId: FAKE_SESSION_ID,
    requestId: "abcde",
    toolName: "Bash",
    description: "run ls",
    inputPreview: "{}",
  });
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("supervisor.respond writes a permission_response frame to the channel client", async () => {
  const verdicts: Array<{ requestId: string; behavior: string }> = [];
  // startWithFakeLauncher constructs the helloClient internally; extend the harness
  // with an optional onPermissionResponse passthrough (see Step 3c).
  const { supervisor, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    enablePermissionRelay: true,
    onPermissionResponse: (requestId, behavior) => {
      verdicts.push({ requestId, behavior });
    },
  });
  await startResult;
  await supervisor.respond(FAKE_SESSION_ID, "abcde", "deny");
  await waitFor(() => verdicts.length > 0);
  expect(verdicts).toEqual([{ requestId: "abcde", behavior: "deny" }]);
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});

test("allowedBuiltinTools extends --allowed-tools and relay flag reaches mcp.json", async () => {
  const { supervisor, launcher, startResult, helloClient } = await startWithFakeLauncher({
    channels: "dev-flag",
    enablePermissionRelay: true,
    allowedBuiltinTools: ["Read", "Grep"],
  });
  await startResult;
  const args = [...launcher.args];
  const idx = args.indexOf("--allowed-tools");
  expect(args[idx + 1]).toBe(
    "mcp__ccb__bridge_reply mcp__ccb__bridge_progress mcp__ccb__bridge_done Read Grep",
  );
  expect(args).not.toContain("--disallowed-tools");
  const mcpIdx = args.indexOf("--mcp-config");
  const mcpPath = args[mcpIdx + 1];
  if (!mcpPath) throw new Error("missing --mcp-config value");
  const cfg = JSON.parse(await readFile(mcpPath, "utf8")) as {
    mcpServers: { ccb: { env: Record<string, string> } };
  };
  expect(cfg.mcpServers.ccb.env.CCB_PERMISSION_RELAY).toBe("1");
  await helloClient.close();
  await supervisor.close(FAKE_SESSION_ID);
});
```

- [ ] **Step 2: Run to verify failure** — `bun test packages/claude-code/src/claude-supervisor.test.ts` → FAIL (unknown options / missing method).

- [ ] **Step 3: Implement.**

(a) `packages/core/src/supervisor.ts` — add to the `Supervisor` interface, following `clear?`'s doc style:

```ts
  /**
   * Answer an open permission request. Optional: only channels-capable
   * supervisors with the permission relay enabled implement it. Bridge.respond
   * rejects with "supervisor does not support respond" when undefined.
   */
  respond?(sessionId: string, requestId: string, behavior: "allow" | "deny"): Promise<void>;
```

(b) `claude-supervisor.ts`:

- `ClaudeCodeSupervisorOptions` gains `readonly enablePermissionRelay?: boolean;` and `readonly allowedBuiltinTools?: ReadonlyArray<string>;` — copy both in the constructor (`#enablePermissionRelay = options.enablePermissionRelay ?? false`, `#allowedBuiltinTools = options.allowedBuiltinTools ?? []`).
- In `start()`, next to the other `server.on(...)` listeners:

```ts
    server.on("permission-request", (sid, requestId, toolName, description, inputPreview) => {
      if (sid !== sessionId) return;
      const current = this.#ctx;
      if (!current) return;
      current.emit({
        type: "permission.requested",
        sessionId: sid,
        requestId,
        toolName,
        description,
        inputPreview,
      });
    });
```

- `generateMcpConfig` call gains `enablePermissionRelay: this.#enablePermissionRelay`.
- In `#buildClaudeArgs`, replace the static `--allowed-tools` push:

```ts
  const allowedTools = [ALLOWED_TOOLS, ...this.#allowedBuiltinTools].join(" ");
  args.push("--allowed-tools", allowedTools);
```

- New method (mirror `sendMessage`'s guards):

```ts
  async respond(sessionId: string, requestId: string, behavior: "allow" | "deny"): Promise<void> {
    const server = this.#server;
    if (!server) throw new Error("supervisor not started");
    if (sessionId !== this.#ctx?.sessionId) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    await server.respond(sessionId, requestId, behavior);
  }
```

(c) Harness: `startWithFakeLauncher`'s opts gain `enablePermissionRelay?: boolean; allowedBuiltinTools?: ReadonlyArray<string>; onPermissionResponse?: (requestId: string, behavior: "allow" | "deny") => void` — forward the first two into the `ClaudeCodeSupervisor` constructor and the last into the harness's `ControlClient` construction.

- [ ] **Step 4: Run** — package tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/supervisor.ts packages/claude-code/src/claude-supervisor.ts packages/claude-code/src/claude-supervisor.test.ts
git commit -m "feat(claude-code): permission relay supervisor wiring, respond(), --allowed-tools extension"
```

---

### Task 7: Bridge — open-request registry, `respond()`, timeout, abort flush

**Files:**
- Modify: `packages/core/src/bridge.ts`
- Test: `packages/core/src/bridge.test.ts`

- [ ] **Step 1: Failing tests.** Extend `StubSupervisor` with `respond` recording:

```ts
  readonly responded: Array<{ sessionId: string; requestId: string; behavior: "allow" | "deny" }> = [];
  async respond(sessionId: string, requestId: string, behavior: "allow" | "deny"): Promise<void> {
    this.responded.push({ sessionId, requestId, behavior });
  }
```

Helper to push a request from the supervisor side:

```ts
function pushPermissionRequest(sup: StubSupervisor, sessionId: string, requestId: string, toolName = "Bash"): void {
  sup.push({
    type: "permission.requested",
    sessionId,
    requestId,
    toolName,
    description: "d",
    inputPreview: "{}",
  });
}
```

Tests (append; follow the existing `takeEvents` style):

```ts
test("respond(allow) persists permission.resolved before forwarding to the supervisor", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");
  await bridge.respond(handle.id, "abcde", "allow");
  expect(supervisor.responded).toEqual([{ sessionId: handle.id, requestId: "abcde", behavior: "allow" }]);
  const stored = await bridge.readStoredEvents(handle.id);
  const resolved = stored.find((e) => e.type === "permission.resolved");
  expect(resolved).toEqual({ type: "permission.resolved", sessionId: handle.id, requestId: "abcde", outcome: "allow" });
  await bridge.close(handle.id);
});

test("respond(deny) round-trips and records approver metadata", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "fghij");
  await bridge.respond(handle.id, "fghij", "deny", { approver: { userId: "u1" } });
  const stored = await bridge.readStoredEvents(handle.id);
  expect(stored.find((e) => e.type === "permission.resolved")).toEqual({
    type: "permission.resolved",
    sessionId: handle.id,
    requestId: "fghij",
    outcome: "deny",
    approver: { userId: "u1" },
  });
  await bridge.close(handle.id);
});

test("respond rejects an unknown requestId without touching the wire", async () => {
  const handle = await bridge.startSession({});
  await expect(bridge.respond(handle.id, "nope!", "allow")).rejects.toThrow(/no open permission request/);
  expect(supervisor.responded).toEqual([]);
  await bridge.close(handle.id);
});

test("respond is exactly-once under a concurrent double answer", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");
  const results = await Promise.allSettled([
    bridge.respond(handle.id, "abcde", "allow"),
    bridge.respond(handle.id, "abcde", "deny"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(supervisor.responded).toHaveLength(1);
  await bridge.close(handle.id);
});

test("respond rejects when the supervisor has no respond method", async () => {
  // StubSupervisor without respond: build a one-off bridge whose supervisor lacks it.
  const bare = new StubSupervisor();
  // biome-ignore lint/performance/noDelete: removing the method to simulate a non-relay supervisor
  delete (bare as Partial<StubSupervisor>).respond;
  const b2 = new Bridge({ storeDir: dir, supervisorFactory: () => bare });
  const handle = await b2.startSession({});
  pushPermissionRequest(bare, handle.id, "abcde");
  await expect(b2.respond(handle.id, "abcde", "allow")).rejects.toThrow(/supervisor does not support respond/);
  await b2.close(handle.id);
});

test("unanswered request ages out: resolved unanswered-remotely, no verdict sent", async () => {
  const b2 = new Bridge({ storeDir: dir, supervisorFactory: () => supervisor, permissionTimeoutMs: 50 });
  const handle = await b2.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");
  await new Promise((r) => setTimeout(r, 120));
  expect(supervisor.responded).toEqual([]); // recommendation (A): no verdict on timeout
  const stored = await b2.readStoredEvents(handle.id);
  expect(stored.find((e) => e.type === "permission.resolved")).toMatchObject({
    requestId: "abcde",
    outcome: "unanswered-remotely",
  });
  await expect(b2.respond(handle.id, "abcde", "allow")).rejects.toThrow(/no open permission request/);
  await b2.close(handle.id);
});

test("open requests are flushed as aborted on close, timers cleared", async () => {
  const handle = await bridge.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");
  pushPermissionRequest(supervisor, handle.id, "fghij");
  await bridge.close(handle.id);
  const stored = await bridge.readStoredEvents(handle.id);
  const aborted = stored.filter((e) => e.type === "permission.resolved" && e.outcome === "aborted");
  expect(aborted.map((e) => (e.type === "permission.resolved" ? e.requestId : ""))).toEqual(
    expect.arrayContaining(["abcde", "fghij"]),
  );
});

test("respond rejects after a store append failure and sends no verdict", async () => {
  // Follow the existing failing-store pattern in this file (storeFactory seam):
  // a store whose append rejects once armed. Open the request first (append OK),
  // then arm the failure, then respond.
  const failing = makeArmableFailingStore(); // reuse/extend the file's existing fake-store helper
  const b2 = new Bridge({ storeDir: dir, supervisorFactory: () => supervisor, storeFactory: () => failing.store });
  const handle = await b2.startSession({});
  pushPermissionRequest(supervisor, handle.id, "abcde");
  failing.arm();
  await expect(b2.respond(handle.id, "abcde", "allow")).rejects.toThrow();
  expect(supervisor.responded).toEqual([]);
  failing.disarm();
  await b2.close(handle.id);
});
```

Note: `bridge.test.ts` already contains a fake-store seam for store-failure tests — find it (search `storeFactory`) and reuse its construction; `makeArmableFailingStore` above is shorthand for whatever that existing helper looks like, extended with arm/disarm if needed. `readStoredEvents` is the existing Bridge read-back API (search the file for its existing usage).

- [ ] **Step 2: Run to verify failure** — `bun test packages/core/src/bridge.test.ts` → FAIL (`respond is not a function`, unknown `permissionTimeoutMs`).

- [ ] **Step 3: Implement.** In `bridge.ts`:

(a) `BridgeOptions` gains `permissionTimeoutMs?: number;` — default `const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;`, validated via the existing `assertPositiveInteger`.

(b) `Session` gains:

```ts
  readonly openPermissions: Map<string, { toolName: string; timer: ReturnType<typeof setTimeout> }>;
```

(initialize `new Map()` where sessions are constructed).

(c) In `#emitFromSupervisor`, after the closing/closed guard and after the bus/store emit block, on the non-terminal path:

```ts
    if (event.type === "permission.requested") {
      const requestId = event.requestId;
      const timer = setTimeout(() => {
        if (!session.openPermissions.has(requestId)) return;
        session.openPermissions.delete(requestId);
        // Recommendation (A): stop tracking, send NO verdict. The bridge does
        // not know the real outcome; consumers read the subsequent tool.event.
        this.#emitFromSupervisor(session, {
          type: "permission.resolved",
          sessionId: session.id,
          requestId,
          outcome: "unanswered-remotely",
        });
      }, this.#permissionTimeoutMs);
      timer.unref?.();
      session.openPermissions.set(requestId, { toolName: event.toolName, timer });
    }
```

(d) New `respond` method (next to `clear`, copying its guard ladder):

```ts
  async respond(
    sessionId: string,
    requestId: string,
    behavior: "allow" | "deny",
    options?: { approver?: { userId: string; displayName?: string } },
  ): Promise<void> {
    const session = this.#requireSession(sessionId);
    if (session.state !== "open") throw new Error(`session is closing: ${sessionId}`);
    if (session.supervisor.respond === undefined) {
      throw new Error("supervisor does not support respond");
    }
    const entry = session.openPermissions.get(requestId);
    if (entry === undefined) {
      throw new Error(`no open permission request: ${requestId}`);
    }
    // Exactly-once: clear synchronously before any await so a concurrent
    // respond or a timer firing in the same tick finds no entry.
    clearTimeout(entry.timer);
    session.openPermissions.delete(requestId);
    // Persist-before-send: durable record first; a store failure here means
    // no verdict crosses the wire.
    await this.#emitAwaited(session, {
      type: "permission.resolved",
      sessionId,
      requestId,
      outcome: behavior,
      ...(options?.approver !== undefined ? { approver: options.approver } : {}),
    });
    await session.supervisor.respond(sessionId, requestId, behavior);
  }
```

(e) Abort flush at the top of `#runClose` (before the `session.ended` emit), so the log never leaves a request unresolved:

```ts
    for (const [requestId, entry] of session.openPermissions) {
      clearTimeout(entry.timer);
      session.openPermissions.delete(requestId);
      try {
        await this.#emitAwaited(session, {
          type: "permission.resolved",
          sessionId: session.id,
          requestId,
          outcome: "aborted",
        });
      } catch {
        // A failing store must not block close; the close ladder handles
        // store teardown regardless.
      }
    }
```

(f) Add `respond` to the `ClaudeCodeBridge` interface (wherever `clear` is declared — search `packages/core/src` for the interface) with the same signature.

- [ ] **Step 4: Run** — `bun test packages/core/src/bridge.test.ts` PASS, then the full `bun test` (watch for exhaustive-switch fallout) and `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/bridge.ts packages/core/src/bridge.test.ts
git commit -m "feat(core): bridge.respond with open-request registry, age-out, abort flush"
```

---

### Task 8: MockSupervisor test seams

**Files:**
- Modify: `packages/claude-code/src/mock-supervisor.ts`
- Test: `packages/claude-code/src/mock-supervisor.test.ts` (or wherever MockSupervisor's tests live — search `mock-supervisor` in `packages/claude-code/src/*.test.ts`)

- [ ] **Step 1: Failing test:**

```ts
test("MockSupervisor records respond calls and can trigger permission requests", async () => {
  const sup = new MockSupervisor();
  const emitted: BridgeEvent[] = [];
  await sup.start({ sessionId: "s-mock", emit: (e) => emitted.push(e) });
  sup.triggerPermissionRequest("abcde", "Bash");
  expect(emitted.find((e) => e.type === "permission.requested")).toMatchObject({
    requestId: "abcde",
    toolName: "Bash",
  });
  await sup.respond("s-mock", "abcde", "deny");
  expect(sup.respondCalls).toEqual([{ sessionId: "s-mock", requestId: "abcde", behavior: "deny" }]);
  await sup.close("s-mock");
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** (mirror the `clearCalls` / `triggerCrash` seam style):

```ts
  #respondCalls: Array<{ sessionId: string; requestId: string; behavior: "allow" | "deny" }> = [];

  get respondCalls(): ReadonlyArray<{ sessionId: string; requestId: string; behavior: "allow" | "deny" }> {
    return [...this.#respondCalls];
  }

  async respond(sessionId: string, requestId: string, behavior: "allow" | "deny"): Promise<void> {
    this.#respondCalls.push({ sessionId, requestId, behavior });
  }

  /** Test seam: emit a permission.requested as if claude relayed a prompt. */
  triggerPermissionRequest(requestId: string, toolName: string, description = "d", inputPreview = "{}"): void {
    const ctx = this.#ctx;
    if (!ctx) throw new Error("not started");
    ctx.emit({
      type: "permission.requested",
      sessionId: ctx.sessionId,
      requestId,
      toolName,
      description,
      inputPreview,
    });
  }
```

- [ ] **Step 4: Run package tests** — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/claude-code/src/mock-supervisor.ts <the test file you modified>
git commit -m "feat(claude-code): mock supervisor permission relay test seams"
```

---

### Task 9: Allowlist policy

**Files:**
- Create: `packages/http/src/permission-policy.ts`
- Test: `packages/http/src/permission-policy.test.ts`

- [ ] **Step 1: Failing tests:**

```ts
import { describe, expect, test } from "bun:test";
import { createAllowlistPolicy } from "./permission-policy.ts";

test("listed tools are allowed, everything else denied", () => {
  const p = createAllowlistPolicy(["Read", "Grep"]);
  expect(p.decide("Read")).toBe("allow");
  expect(p.decide("Grep")).toBe("allow");
  expect(p.decide("Bash")).toBe("deny");
  expect(p.decide("")).toBe("deny");
});

test("'all' allows everything", () => {
  const p = createAllowlistPolicy("all");
  expect(p.decide("Bash")).toBe("allow");
  expect(p.decide("anything")).toBe("allow");
});

test("matching is exact and case-sensitive", () => {
  const p = createAllowlistPolicy(["Read"]);
  expect(p.decide("read")).toBe("deny");
});
```

- [ ] **Step 2: Run to verify failure** (module not found).

- [ ] **Step 3: Implement** `permission-policy.ts`:

```ts
/**
 * Decides tool-permission prompts for headless pool sessions. Pure function of
 * the tool name — description/inputPreview are deliberately not consulted (no
 * content sniffing). The relay is the deny backstop: allowlisted tools are
 * normally pre-approved at launch via --allowed-tools and never prompt.
 */
export interface PermissionPolicy {
  decide(toolName: string): "allow" | "deny";
}

export function createAllowlistPolicy(tools: ReadonlyArray<string> | "all"): PermissionPolicy {
  if (tools === "all") {
    return { decide: () => "allow" };
  }
  const allowed = new Set(tools);
  return { decide: (toolName) => (allowed.has(toolName) ? "allow" : "deny") };
}
```

Export both from the package index if `packages/http/src/index.ts` exists (check how `SessionPool` is exported and mirror it).

- [ ] **Step 4: Run** — PASS. **Step 5: Commit**

```bash
git add packages/http/src/permission-policy.ts packages/http/src/permission-policy.test.ts
git commit -m "feat(http): allowlist permission policy"
```

---

### Task 10: SessionPool answers prompts by policy

**Files:**
- Modify: `packages/http/src/pool.ts`
- Test: `packages/http/src/pool.test.ts`

- [ ] **Step 1: Failing tests** (use the file's existing `makeBridge(supervisors)` helper and MockSupervisor seams from Task 8):

```ts
test("pool answers permission.requested via the policy", async () => {
  const supervisors: MockSupervisor[] = [];
  const bridge = makeBridge(supervisors);
  const pool = new SessionPool({
    bridge,
    size: 1,
    permissionPolicy: createAllowlistPolicy(["Read"]),
  });
  await pool.start();
  const sup = supervisors[0];
  if (!sup) throw new Error("no supervisor");
  sup.triggerPermissionRequest("abcde", "Read");
  sup.triggerPermissionRequest("fghij", "Bash");
  await until(() => sup.respondCalls.length === 2);
  expect(sup.respondCalls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ requestId: "abcde", behavior: "allow" }),
      expect.objectContaining({ requestId: "fghij", behavior: "deny" }),
    ]),
  );
  await pool.close();
});

test("a respawned session is watched too", async () => {
  const supervisors: MockSupervisor[] = [];
  const bridge = makeBridge(supervisors);
  const pool = new SessionPool({ bridge, size: 1, permissionPolicy: createAllowlistPolicy("all") });
  await pool.start();
  // Poison the session so the pool replaces it.
  await pool.withSession(async () => {
    throw new Error("boom");
  }).catch(() => {});
  await until(() => supervisors.length === 2);
  const fresh = supervisors[1];
  if (!fresh) throw new Error("no respawned supervisor");
  fresh.triggerPermissionRequest("abcde", "Bash");
  await until(() => fresh.respondCalls.length === 1);
  expect(fresh.respondCalls[0]).toMatchObject({ requestId: "abcde", behavior: "allow" });
  await pool.close();
});

test("pool without a policy ignores permission events", async () => {
  const supervisors: MockSupervisor[] = [];
  const bridge = makeBridge(supervisors);
  const pool = new SessionPool({ bridge, size: 1 });
  await pool.start();
  const sup = supervisors[0];
  if (!sup) throw new Error("no supervisor");
  sup.triggerPermissionRequest("abcde", "Bash");
  await new Promise((r) => setTimeout(r, 100));
  expect(sup.respondCalls).toEqual([]);
  await pool.close();
});
```

Add an `until` helper if the file lacks one (copy from `control.test.ts`).

- [ ] **Step 2: Run to verify failure** (unknown `permissionPolicy` option).

- [ ] **Step 3: Implement** in `pool.ts`:

```ts
import type { PermissionPolicy } from "./permission-policy.ts";

export interface SessionPoolOptions {
  readonly bridge: ClaudeCodeBridge;
  readonly size: number;
  /** When set, the pool answers permission.requested events for every warm session. */
  readonly permissionPolicy?: PermissionPolicy;
}
```

Store `#policy = options.permissionPolicy`. Add:

```ts
  /**
   * Answer permission prompts for one session for its lifetime. The loop ends
   * naturally when the session's bus closes (session closed/replaced). respond
   * failures are logged, never fatal: the request either aged out or the
   * session is tearing down; the turn fails via its own timeout if a verdict
   * was genuinely lost.
   */
  #watchPermissions(sessionId: string): void {
    const policy = this.#policy;
    if (!policy) return;
    void (async () => {
      for await (const event of this.#bridge.events(sessionId)) {
        if (event.type !== "permission.requested") continue;
        try {
          await this.#bridge.respond(sessionId, event.requestId, policy.decide(event.toolName));
        } catch (err) {
          console.error(
            `ccb api: permission respond failed for ${event.requestId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    })();
  }
```

Call `this.#watchPermissions(id)` immediately after every successful `bridge.startSession({})` — in `start()` and in `#replace()` (both sites; find them via the `startSession` calls).

- [ ] **Step 4: Run** — `bun test packages/http` PASS. **Step 5: Commit**

```bash
git add packages/http/src/pool.ts packages/http/src/pool.test.ts
git commit -m "feat(http): session pool answers permission prompts from an allowlist policy"
```

---

### Task 11: CLI `--allow-tools` + api plumbing

**Files:**
- Modify: `apps/ccb/src/cli.ts`
- Modify: `apps/ccb/src/api.ts`
- Test: `apps/ccb/src/cli.test.ts`, `apps/ccb/src/api.test.ts`

- [ ] **Step 1: Failing tests.**

`cli.test.ts` (uses the existing `runCli` spawn helper):

```ts
test("ccb api --help lists --allow-tools", async () => {
  const { exitCode, stdout } = await runCli(["api", "--help"]);
  expect(exitCode).toBe(0);
  expect(stdout).toMatch(/--allow-tools/);
});

test("ccb api rejects --allow-tools all combined with names", async () => {
  const { exitCode, stderr } = await runCli(["api", "--allow-tools", "all,Read", "--supervisor", "mock"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/'all' cannot be combined/);
});

test("ccb api rejects empty --allow-tools entries", async () => {
  const { exitCode, stderr } = await runCli(["api", "--allow-tools", "Read,,Grep", "--supervisor", "mock"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/comma-separated tool names/);
});
```

Also export and unit-test the parser directly:

```ts
test("parseAllowTools parses names and the all sentinel", () => {
  expect(parseAllowTools("Read, Grep")).toEqual(["Read", "Grep"]);
  expect(parseAllowTools("all")).toBe("all");
});
```

`api.test.ts` — follow the file's existing mock-supervisor server-boot pattern; assert a pool with a policy answers prompts end to end:

```ts
test("runApi with allowTools answers permission prompts by policy", async () => {
  const api = await runApi({
    host: "127.0.0.1",
    port: 0,
    poolSize: 1,
    turnTimeoutMs: 5_000,
    supervisor: "mock",
    storeDir: dir,
    allowTools: ["Read"],
  });
  // Reach the MockSupervisor the same way existing api tests do; if none do,
  // assert indirectly: the server boots and stops cleanly with the option set.
  await api.stop();
});
```

(If the existing `api.test.ts` has no supervisor-reaching seam, keep this boot test plus rely on Task 10's pool tests for behavior — do not invent a new seam just for this.)

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**

`cli.ts` — exported parser + option:

```ts
export function parseAllowTools(value: string): string[] | "all" {
  const items = value.split(",").map((s) => s.trim());
  if (items.includes("all")) {
    if (items.length > 1) {
      throw new InvalidArgumentError("'all' cannot be combined with tool names");
    }
    return "all";
  }
  if (items.length === 0 || items.some((s) => s.length === 0)) {
    throw new InvalidArgumentError("expected comma-separated tool names or 'all'");
  }
  return items;
}
```

In the `api` command:

```ts
    .option(
      "--allow-tools <list>",
      "enable claude's built-in tools: comma-separated names auto-approved (others denied), or 'all'",
      parseAllowTools,
    )
```

and add `allowTools?: string[] | "all";` to the action's opts type (commander camel-cases `--allow-tools`).

`api.ts`:

```ts
import { createAllowlistPolicy, SessionPool, startApiServer } from "@ccb/http";

export interface ApiOptions {
  // ...existing fields...
  readonly allowTools?: ReadonlyArray<string> | "all";
}

function selectFactory(
  choice: "mock" | "claude",
  allowTools?: ReadonlyArray<string> | "all",
): SupervisorFactory {
  if (choice === "claude") {
    if (allowTools === undefined) {
      return claudeCodeSupervisorFactory({ channels: "dev-flag", cleanSession: true, rawModel: true });
    }
    return claudeCodeSupervisorFactory({
      channels: "dev-flag",
      cleanSession: true,
      rawModel: false,
      enablePermissionRelay: true,
      // 'all' has no enumerable pre-approval; every prompt relays and the
      // policy answers allow.
      allowedBuiltinTools: allowTools === "all" ? [] : allowTools,
    });
  }
  return mockSupervisorFactory();
}
```

In `runApi`: pass `options.allowTools` to `selectFactory`, and build the pool as:

```ts
  const pool = new SessionPool({
    bridge,
    size: options.poolSize,
    permissionPolicy:
      options.allowTools !== undefined ? createAllowlistPolicy(options.allowTools) : undefined,
  });
```

Check `claudeCodeSupervisorFactory`'s signature in `packages/claude-code` forwards the two new options (it forwards the whole options object today; extend its option type if it narrows).

- [ ] **Step 4: Run** — `bun test apps/ccb` PASS; full `bun test` + typecheck + lint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/ccb/src/cli.ts apps/ccb/src/api.ts apps/ccb/src/cli.test.ts apps/ccb/src/api.test.ts
git commit -m "feat(ccb): --allow-tools flag wires allowlist policy and tool-enabled sessions into ccb api"
```

---

### Task 12: Live smoke + docs

**Files:**
- Create: `scripts/tools-smoke.py`
- Modify: `docs/SMOKE.md`, `README.md`, `docs/ROADMAP.md`, `docs/M5.md`

- [ ] **Step 1: Write the smoke script** (`scripts/tools-smoke.py`, mirroring `scripts/litellm-smoke.py`'s structure — plain OpenAI SDK):

```python
#!/usr/bin/env python3
"""Smoke: tool-enabled ccb api. Prereq: `ccb api --allow-tools Read,Bash` running
from a directory containing this repo, and a file the model can read.

  python3 scripts/tools-smoke.py
"""
import sys
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:18485/v1", api_key="unused")

# 1. Allowed tool: claude reads a real file from the server's cwd.
r1 = client.chat.completions.create(
    model="ccb",
    messages=[{"role": "user", "content": "Read the file README.md in your working directory and tell me its first heading. Use your Read tool."}],
)
out1 = r1.choices[0].message.content or ""
print("read-tool answer:", out1[:200])
assert "claude-code-bridge" in out1.lower() or "bridge" in out1.lower(), "expected README content in answer"

# 2. Denied tool: graceful text degradation, not an error.
r2 = client.chat.completions.create(
    model="ccb",
    messages=[{"role": "user", "content": "Use your Write tool to create a file named should-not-exist.txt. If you cannot, say DENIED."}],
)
out2 = r2.choices[0].message.content or ""
print("denied-tool answer:", out2[:200])
assert r2.choices[0].finish_reason in ("stop", "length"), "denied tool must not break the turn"

print("SMOKE OK")
sys.exit(0)
```

- [ ] **Step 2: Run the live smoke.** In one terminal from the repo root: `bun apps/ccb/src/cli.ts api --allow-tools Read,Bash`. In another: `python3 scripts/tools-smoke.py`. Expected: `SMOKE OK`; the JSONL store (`.ccb-data/`) shows `tool.event` records for the Read call, and — for the denied Write — a `permission.requested`/`permission.resolved outcome:"deny"` pair. Verify `should-not-exist.txt` does not exist. Iterate on prompts if claude phrases differently; the assertions to keep are: allowed tool produced file-derived content, denied tool degraded to text.

- [ ] **Step 3: Docs.**
  - `docs/SMOKE.md`: add "Smoke 7: tool-enabled api (--allow-tools)" with the two-terminal walkthrough above and what to verify in the store.
  - `README.md`: in the `ccb api` section add the `--allow-tools` flag with the safety paragraph: sessions act on the server's cwd; `Write`/`Edit`/`Bash` hand API callers machine access; recommend `--api-key`; default (no flag) remains raw-model.
  - `docs/ROADMAP.md`: M5 row → implemented (link this plan).
  - `docs/M5.md`: change the Status block to "Implemented 2026-06-12 (see docs/2026-06-12-tool-enabled-api-plan.md); originally a proposal" and add one line noting the delivered facade consumer (`ccb api --allow-tools`).

- [ ] **Step 4: Full suite + lint + typecheck one last time** — all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/tools-smoke.py docs/SMOKE.md README.md docs/ROADMAP.md docs/M5.md
git commit -m "feat(ccb): tool-enabled api live smoke + docs; mark M5 implemented"
```

---

## Self-review notes

- **Spec coverage:** spike (Task 1) ↔ design "Spike"; frames/capability/bin (2–4) ↔ design Layer 1 wire; events/format (5) ↔ M5.md events; supervisor (6) + bridge (7) ↔ M5.md response API, correlation & lifecycle, persistence; policy (9) / pool (10) / CLI (11) ↔ design Layer 2; smoke+docs (12) ↔ design Testing. M5.md's "disconnect mid-request" case is covered by Task 7's abort-flush test (the supervisor-initiated close path drives the same `#runClose`); if the implementer finds `peer-close` takes a different close path, add a dedicated test there.
- **Deviation from M5.md noted:** no `oninitialized` gate for the verdict (current `bin.ts` already serializes control-connect after `initialized`; comment in Task 3 records why).
- **Type consistency:** `respond(sessionId, requestId, behavior, options?)` is identical in Supervisor (without options), ClaudeCodeSupervisor, MockSupervisor, Bridge (with options), and `ClaudeCodeBridge`. Event field names (`requestId`, `toolName`, `description`, `inputPreview`, `outcome`, `approver`) are identical across events.ts, control frames (camelCase on the wire frames; snake_case only at the MCP notification boundary), and tests.
