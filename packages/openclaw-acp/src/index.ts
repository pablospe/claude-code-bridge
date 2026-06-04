import { join } from "node:path";
import { Bridge } from "@ccb/core";
import { type ChannelsMode, claudeCodeSupervisorFactory, type HookEvent } from "@ccb/claude-code";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import {
  definePluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { CLAUDE_BRIDGE_BACKEND_ID, createClaudeBridgeRuntime } from "./adapter.ts";

const DEFAULT_HOOKS: HookEvent[] = ["PreToolUse", "PostToolUse", "Stop"];

/**
 * OpenClaw plugin entry. Registers the `claude-bridge` ACP runtime backend,
 * which drives a genuine interactive `claude` (Max subscription) via
 * claude-code-bridge. The backend reasons inside Claude Code; OpenClaw keeps
 * session/turn/channel routing. The interactive session spends interactive
 * subscription quota — not the headless/SDK credit.
 *
 * Requirements on the host running the gateway: the `claude` CLI authenticated
 * with a Pro/Max login, channels-preview eligibility, node-pty support, and a
 * NON-sandboxed agent (OpenClaw denies ACP for sandboxed agents).
 */
export default definePluginEntry({
  id: "claude-bridge",
  name: "Claude Bridge ACP Runtime",
  description:
    "ACP runtime backend that drives an interactive Claude Code session (Max subscription) via claude-code-bridge.",
  register(api: OpenClawPluginApi) {
    const channels: ChannelsMode = "dev-flag";
    api.registerService({
      id: "claude-bridge-runtime",
      start(ctx) {
        // Per-session JSONL stores live under the plugin's state dir.
        const storeDir = join(ctx.stateDir, "claude-bridge-sessions");
        const bridge = new Bridge({
          storeDir,
          supervisorFactory: claudeCodeSupervisorFactory({
            channels,
            hooks: { events: DEFAULT_HOOKS },
          }),
        });
        const runtime = createClaudeBridgeRuntime({ bridge });
        registerAcpRuntimeBackend({
          id: CLAUDE_BRIDGE_BACKEND_ID,
          runtime,
          healthy: () => true,
        });
        ctx.logger.info(`registered ACP backend "${CLAUDE_BRIDGE_BACKEND_ID}" (claude-code-bridge)`);
      },
      stop() {
        unregisterAcpRuntimeBackend(CLAUDE_BRIDGE_BACKEND_ID);
      },
    });
  },
});
