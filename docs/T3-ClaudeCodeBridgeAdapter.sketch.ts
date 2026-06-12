/**
 * ClaudeCodeBridgeAdapter — provider adapter that drives an interactive Claude
 * Code session via claude-code-bridge (ccb) instead of the Agent SDK.
 *
 * SKETCH — not wired into t3code/apps/server/src/provider/Drivers/ yet. Drop
 * this file into t3code/apps/server/src/provider/Layers/ once you're ready,
 * then add a sibling Driver in Drivers/ that constructs it (parallel to
 * ClaudeAdapter / ClaudeDriver).
 *
 * Trade-offs vs ClaudeAdapter:
 *  - Streaming granularity. ccb emits content at MESSAGE (whole bridge_reply /
 *    bridge_progress chunk) granularity, not token-level. Each agent.reply /
 *    agent.progress becomes one content.delta. The Agent SDK's
 *    `includePartialMessages` token stream is not available here.
 *  - Permissions. ccb has no permission-prompt relay yet — that's M5 (draft).
 *    M5 is narrowly scoped to tool-approval allow/deny via the channels-native
 *    `notifications/claude/channel/permission_request` surface. Phase 1
 *    launches claude with --allowed-tools so it never prompts; T3 sees only
 *    observational tool.events (PreToolUse/PostToolUse). See TODO(M5).
 *  - Free-text elicitation (AskUserQuestion / `user-input.requested`). M5
 *    explicitly does NOT cover this (M5.md §"Why a new variant, not
 *    `agent.input_requested`") — it stays reserved for a future, unscoped
 *    elicitation feature. Marked TODO(future: user-input relay).
 *  - Resume. ccb owns conversation state inside the live PTY claude process;
 *    there is no SDK-style resumeCursor. One bridge session must stay alive
 *    for the full thread lifetime — restart loses context.
 *  - ProviderDriverKind. The union must learn "claudeCodeBridge" before this
 *    compiles. Add it alongside "claudeAgent" / "codex" / etc. in
 *    packages/contracts/src/providerInstance.ts.
 */
import {
  Bridge,
  type BridgeEvent,
  claudeCodeSupervisorFactory,
} from "@pablospe/claude-code-bridge";
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";

// TODO: add "claudeCodeBridge" to ProviderDriverKind literal union.
const PROVIDER = ProviderDriverKind.make("claudeCodeBridge");

interface TranslatorCtx {
  readonly threadId: ThreadId;
  readonly ccbSessionId: string;
  readonly createdAt: string;
  readonly currentTurnId: Ref.Ref<TurnId | undefined>;
  // Stable item id per in-flight tool. PreToolUse opens; PostToolUse closes.
  // Keyed by tool name; ccb's tool.event payload has no stable id so this
  // assumes tools don't overlap by name within a turn (good enough for
  // phase 1; refine if claude starts nesting same-tool calls).
  readonly openToolItems: Ref.Ref<Map<string, RuntimeItemId>>;
}

interface SessionContext extends TranslatorCtx {
  readonly consumerFiber: Fiber.RuntimeFiber<void, never>;
}

export interface ClaudeCodeBridgeAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly storeDir: string;
  // Test seam: inject a pre-built Bridge (e.g. backed by mockSupervisorFactory)
  // instead of constructing the managed-launch one.
  readonly bridgeFactory?: () => Bridge;
}

export const makeClaudeCodeBridgeAdapter = Effect.fn("makeClaudeCodeBridgeAdapter")(function* (
  options: ClaudeCodeBridgeAdapterOptions,
) {
  const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("claudeCodeBridge");

  const bridge =
    options.bridgeFactory?.() ??
    new Bridge({
      storeDir: options.storeDir,
      supervisorFactory: claudeCodeSupervisorFactory({
        channels: "dev-flag",
        // Hook relay gives observational PreToolUse / PostToolUse, mapped
        // below to item.started / item.completed. Stop is captured for
        // completeness but the translator drives turn.completed off
        // agent.done / agent.reply{final:true} instead.
        hooks: { events: ["PreToolUse", "PostToolUse", "Stop"] },
      }),
    });

  const sessions = new Map<ThreadId, SessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
  const stamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
  const offer = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  // -------------------------------------------------------------------------
  // ccb BridgeEvent → ProviderRuntimeEvent translator
  // -------------------------------------------------------------------------
  // This is the heart of the adapter. Every line of the switch encodes a
  // design decision; treat each `case` as a separate review surface.
  const translate = (ctx: TranslatorCtx, ev: BridgeEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const { eventId, createdAt } = yield* stamp();
      const turnId = yield* Ref.get(ctx.currentTurnId);
      const base = {
        eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: ctx.threadId,
        createdAt,
        turnId,
      } as const;

      switch (ev.type) {
        // ccb's session lifecycle is informational — T3 already emits
        // session.started from startSession's return, and session.exited
        // from stopSession. Skip the ccb echoes to avoid double-emission.
        case "session.started":
          return;
        case "message.sent":
          return;

        // Whole-chunk content delta. ccb is NOT token-level; each
        // bridge_progress / bridge_reply is a complete chunk of text.
        case "agent.progress":
        case "agent.reply": {
          yield* offer({
            ...base,
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: ev.content },
          });
          if (ev.type === "agent.reply" && ev.final) {
            // Final reply closes the turn. bridge_done was relaxed in ccb's
            // M5 work — it may or may not arrive after a final reply — so we
            // close from here and gate the agent.done branch below.
            yield* offer({
              ...base,
              type: "turn.completed",
              payload: { state: "completed" },
            });
            yield* Ref.set(ctx.currentTurnId, undefined);
          }
          return;
        }

        // agent.done is the explicit close; emit only if the final-reply
        // branch didn't already close the turn (currentTurnId still set).
        case "agent.done": {
          if (turnId !== undefined) {
            yield* offer({
              ...base,
              type: "turn.completed",
              payload: { state: "completed" },
            });
            yield* Ref.set(ctx.currentTurnId, undefined);
          }
          return;
        }

        // TODO(future: user-input relay) — NOT M5. M5 explicitly keeps this
        // variant reserved for a future free-text elicitation /
        // AskUserQuestion feature. Today ccb does not mint this event; the
        // case is a placeholder so the union stays exhaustive.
        case "agent.input_requested": {
          yield* offer({
            ...base,
            type: "user-input.requested",
            requestId: ApprovalRequestId.make(ev.requestId),
            payload: {
              questions: [
                {
                  id: "default",
                  header: "input",
                  question: ev.prompt,
                  options: [],
                  multiSelect: false,
                },
              ],
            },
          });
          return;
        }

        // PreToolUse / PostToolUse via the hook relay. Observational only —
        // T3 sees tool runs after the fact (no canUseTool gating yet).
        case "tool.event": {
          const { event: hookEvent, data } = ev.payload;
          const toolName = (data as { tool_name?: string }).tool_name ?? "unknown_tool";
          const itemType = toolName.startsWith("mcp__")
            ? ("mcp_tool_call" as const)
            : toolName === "Bash"
              ? ("command_execution" as const)
              : ("dynamic_tool_call" as const);

          if (hookEvent === "PreToolUse") {
            const itemId = RuntimeItemId.make(yield* Random.nextUUIDv4);
            yield* Ref.update(ctx.openToolItems, (m) => {
              const next = new Map(m);
              next.set(toolName, itemId);
              return next;
            });
            yield* offer({
              ...base,
              type: "item.started",
              itemId,
              payload: { itemType, status: "inProgress", title: toolName, data },
            });
            return;
          }
          if (hookEvent === "PostToolUse") {
            const open = yield* Ref.get(ctx.openToolItems);
            const itemId = open.get(toolName);
            if (!itemId) return;
            yield* Ref.update(ctx.openToolItems, (m) => {
              const next = new Map(m);
              next.delete(toolName);
              return next;
            });
            yield* offer({
              ...base,
              type: "item.completed",
              itemId,
              payload: { itemType, status: "completed", title: toolName, data },
            });
            return;
          }
          // Stop and any other hook events: no canonical mapping needed.
          return;
        }

        // TODO(M5): when ccb mints `permission.requested` and
        // `permission.resolved` variants on BridgeEvent (M5.md §"The event"),
        // add two cases here:
        //   case "permission.requested":  -> offer T3 `request.opened` with
        //     payload.requestType: tool-derived CanonicalRequestType (e.g.
        //     "command_execution_approval" for Bash, "file_change_approval"
        //     for Edit/Write), payload.detail: ev.description, payload.args:
        //     { toolName, inputPreview }. Use ev.requestId as the
        //     ApprovalRequestId.
        //   case "permission.resolved":  -> offer T3 `request.resolved` with
        //     payload.decision = ev.outcome ("allow" | "deny" |
        //     "unanswered-remotely" | "aborted").
        // The respondToRequest method above sends the verdict back.
        case "session.ended": {
          yield* offer({
            ...base,
            type: "session.exited",
            payload: { kind: "graceful" },
          });
          return;
        }
      }
    });

  const startConsumer = (ctx: TranslatorCtx) =>
    Effect.gen(function* () {
      const iter = bridge.events(ctx.ccbSessionId);
      for await (const ev of iter) {
        yield* translate(ctx, ev);
      }
    }).pipe(
      Effect.catchAll((cause) => Effect.logError("ccb event stream error", cause)),
      Effect.fork,
    );

  // -------------------------------------------------------------------------
  // ProviderAdapterShape methods
  // -------------------------------------------------------------------------

  const startSession = (
    input: ProviderSessionStartInput,
  ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
    Effect.gen(function* () {
      const handle = yield* Effect.tryPromise({
        try: () => bridge.startSession({}),
        catch: (cause) =>
          new ProviderAdapterRequestError({ message: "ccb startSession failed", cause }),
      });
      const createdAt = yield* nowIso;
      const currentTurnId = yield* Ref.make<TurnId | undefined>(undefined);
      const openToolItems = yield* Ref.make(new Map<string, RuntimeItemId>());
      const translatorCtx: TranslatorCtx = {
        threadId: input.threadId,
        ccbSessionId: handle.id,
        createdAt,
        currentTurnId,
        openToolItems,
      };
      const consumerFiber = yield* startConsumer(translatorCtx);
      sessions.set(input.threadId, { ...translatorCtx, consumerFiber });

      return {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd: input.cwd,
        threadId: input.threadId,
        createdAt,
        updatedAt: createdAt,
      };
    });

  const sendTurn = (
    input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
    Effect.gen(function* () {
      const ctx = sessions.get(input.threadId);
      if (!ctx) {
        return yield* Effect.fail(
          new ProviderAdapterSessionNotFoundError({ threadId: input.threadId }),
        );
      }
      const turnId = TurnId.make(yield* Random.nextUUIDv4);
      yield* Ref.set(ctx.currentTurnId, turnId);

      // Emit turn.started up-front so T3's UI flips to in-flight before ccb
      // streams the first agent.progress back.
      const { eventId, createdAt } = yield* stamp();
      yield* offer({
        eventId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        createdAt,
        turnId,
        type: "turn.started",
        payload: {},
      });

      yield* Effect.tryPromise({
        try: () => bridge.sendMessage(ctx.ccbSessionId, input.input ?? ""),
        catch: (cause) =>
          new ProviderAdapterRequestError({ message: "ccb sendMessage failed", cause }),
      });

      return { threadId: input.threadId, turnId };
    });

  const interruptTurn = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx) return;
      yield* Effect.tryPromise({
        try: () => bridge.interrupt(ctx.ccbSessionId),
        catch: (cause) =>
          new ProviderAdapterRequestError({ message: "ccb interrupt failed", cause }),
      });
    });

  const stopSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const ctx = sessions.get(threadId);
      if (!ctx) return;
      yield* Effect.tryPromise({
        try: () => bridge.close(ctx.ccbSessionId),
        catch: (cause) => new ProviderAdapterRequestError({ message: "ccb close failed", cause }),
      });
      yield* Fiber.interrupt(ctx.consumerFiber);
      sessions.delete(threadId);
    });

  // TODO(M5): when ccb's permission relay lands, this routes T3's
  // allow/deny back to claude. The wire call would be approximately:
  //   const ctx = sessions.get(threadId);
  //   if (!ctx) return Effect.void;
  //   const behavior = decision === "allow" ? "allow" : "deny";
  //   return Effect.tryPromise({
  //     try: () => bridge.respond(ctx.ccbSessionId, requestId, behavior),
  //     catch: (cause) => new ProviderAdapterRequestError({ ... }),
  //   });
  // Until then, phase 1 pre-authorizes tools via --allowed-tools so claude
  // shouldn't be prompting — this stays a no-op.
  const respondToRequest = (
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ) => Effect.void;

  // TODO(future: user-input relay) — NOT M5. Pairs with the reserved
  // agent.input_requested variant; needs its own design (event shape, wire
  // protocol, bridge.respondInput method).
  const respondToUserInput = (
    _threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ) => Effect.void;

  const listSessions = () =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      return Array.from(sessions.values()).map((ctx) => ({
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready" as const,
        runtimeMode: "interactive" as const,
        threadId: ctx.threadId,
        createdAt: ctx.createdAt,
        updatedAt: now,
      })) satisfies ReadonlyArray<ProviderSession>;
    });

  const hasSession = (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId));

  // ccb has Bridge.readStoredEvents(sessionId) returning the JSONL log. For
  // phase 1 we let T3's canonical-event replay reconstruct threads from the
  // event stream and return an empty snapshot here; revisit if the WS RPC
  // layer needs a synchronous snapshot.
  const readThread = (threadId: ThreadId) => Effect.succeed({ threadId, turns: [] });

  // ccb has no rollback primitive — the live PTY claude owns context. A real
  // rollback would mean killing + restarting the session and replaying the
  // first N turns through bridge.sendMessage. Out of scope for the sketch.
  const rollbackThread = (threadId: ThreadId, _numTurns: number) =>
    Effect.succeed({ threadId, turns: [] });

  const stopAll = () => Effect.forEach(Array.from(sessions.keys()), stopSession, { discard: true });

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" as const },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  };
});
