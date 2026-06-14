import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  NotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { validateWireMeta } from "./meta-validation.ts";

export type ToolName = "bridge_reply" | "bridge_progress" | "bridge_done";

const BridgeReplyArgsSchema = z.object({
  content: z.string(),
  final: z.boolean(),
  messageId: z.string().optional(),
});

const BridgeProgressArgsSchema = z.object({
  content: z.string(),
  messageId: z.string().optional(),
});

const BridgeDoneArgsSchema = z.object({
  reason: z.string().optional(),
  messageId: z.string().optional(),
});

const TOOL_ARG_SCHEMAS: Record<ToolName, z.ZodTypeAny> = {
  bridge_reply: BridgeReplyArgsSchema,
  bridge_progress: BridgeProgressArgsSchema,
  bridge_done: BridgeDoneArgsSchema,
};

export type OnToolCallback = (
  name: ToolName,
  args: Record<string, unknown>,
) => void | Promise<void>;

export interface PermissionRequest {
  readonly requestId: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputPreview: string;
}

export interface CreateChannelServerOptions {
  readonly sessionId: string;
  readonly onTool?: OnToolCallback;
  /**
   * Invoked once claude completes the MCP `initialize` handshake (the SDK's
   * `oninitialized`). Callers gate the bridge `hello` on this so the first
   * channel notification is never delivered before claude has finished
   * initializing — claude drops, rather than queues, notifications that arrive
   * mid-handshake.
   */
  readonly onInitialized?: () => void;
  /**
   * Opt-in permission relay. The `claude/channel/permission` capability is
   * declared only when this is true — it is a security-sensitive opt-in
   * because the capability documents (and the live protocol confirms) that only
   * channels that authenticate the sender should advertise it: whoever can
   * answer through the channel can approve tool use in the session.
   */
  readonly enablePermissionRelay?: boolean;
  /** Invoked when claude relays a tool-permission prompt; forward the verdict via the handle's respondPermission(). */
  readonly onPermissionRequest?: (req: PermissionRequest) => void | Promise<void>;
}

export interface DeliverOptions {
  readonly messageId?: string;
  readonly meta?: Readonly<Record<string, string>>;
}

export interface ChannelServerHandle {
  readonly server: Server;
  deliver(content: string, opts?: DeliverOptions): Promise<void>;
  respondPermission(requestId: string, behavior: "allow" | "deny"): Promise<void>;
}

const INSTRUCTIONS =
  'Messages from the bridge arrive as <channel source="ccb" session_id="..." message_id="...">content</channel>. ' +
  "When you have a final reply, call bridge_reply with the content and final:true — that ends the turn. " +
  "For intermediate progress, call bridge_progress. " +
  "Call bridge_done only if your turn ends without a final reply (e.g. you acted on the message but have nothing to say back); otherwise the consumer waits forever for a completion signal. " +
  "Always pass the message_id from the channel tag.";

const TOOLS: readonly Tool[] = [
  {
    name: "bridge_reply",
    description:
      "Send a reply to the bridge. Set final:true when this is the complete response — that also ends the turn (no bridge_done needed).",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Reply content." },
        final: {
          type: "boolean",
          description: "True if this is the final reply for the message (no further replies).",
        },
        messageId: {
          type: "string",
          description: "Optional message_id from the inbound channel tag.",
        },
      },
      required: ["content", "final"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_progress",
    description: "Send an intermediate progress update back to the bridge before the final reply.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Progress content." },
        messageId: {
          type: "string",
          description: "Optional message_id from the inbound channel tag.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "bridge_done",
    description:
      "End the turn when you send no final reply (e.g. you acted but have nothing to say back). A bridge_reply with final:true already ends the turn, so don't call this after one.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Optional reason for completing the turn." },
        messageId: {
          type: "string",
          description: "Optional message_id from the inbound channel tag.",
        },
      },
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set<ToolName>(["bridge_reply", "bridge_progress", "bridge_done"]);

const PermissionRequestParamsSchema = z.object({
  request_id: z.string(),
  tool_name: z.string(),
  description: z.string(),
  input_preview: z.string(),
});

function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.has(name as ToolName);
}

export function createChannelServer(options: CreateChannelServerOptions): ChannelServerHandle {
  const { sessionId, onTool, onInitialized, enablePermissionRelay, onPermissionRequest } = options;

  const server = new Server(
    { name: "ccb", version: "0.0.1" },
    {
      capabilities: {
        tools: {},
        // The permission capability is opt-in because the docs require it only
        // on channels that authenticate the sender — whoever can answer through
        // the channel can approve tool use in the session.
        experimental: enablePermissionRelay
          ? { "claude/channel": {}, "claude/channel/permission": {} }
          : { "claude/channel": {} },
      },
      instructions: INSTRUCTIONS,
    },
  );

  if (onInitialized) {
    server.oninitialized = onInitialized;
  }

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: TOOLS.map((t) => ({ ...t })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (!isToolName(name)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
      };
    }
    const rawArgs = request.params.arguments ?? {};
    const parsed = TOOL_ARG_SCHEMAS[name].safeParse(rawArgs);
    if (!parsed.success) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: parsed.error.message }],
      };
    }
    try {
      await onTool?.(name, parsed.data as Record<string, unknown>);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
    return {
      content: [{ type: "text" as const, text: "ok" }],
    };
  });

  if (enablePermissionRelay) {
    // Use NotificationSchema.extend (SDK's zod v3) for the dispatch key so
    // setNotificationHandler's AnyObjectSchema constraint is satisfied; parse
    // params separately with the zod/v4 schema for type-safe field access.
    const dispatchSchema = NotificationSchema.extend({
      method: z.literal(
        "notifications/claude/channel/permission_request",
      ) as unknown as import("zod").ZodLiteral<"notifications/claude/channel/permission_request">,
    });
    server.setNotificationHandler(dispatchSchema, async (n) => {
      const parsed = PermissionRequestParamsSchema.safeParse(n.params);
      if (!parsed.success) {
        console.error(
          `channel-server: dropping malformed permission_request: ${parsed.error.message}`,
        );
        return;
      }
      try {
        await onPermissionRequest?.({
          requestId: parsed.data.request_id,
          toolName: parsed.data.tool_name,
          description: parsed.data.description,
          inputPreview: parsed.data.input_preview,
        });
      } catch (err) {
        console.error(
          `channel-server: onPermissionRequest threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  const deliver = async (content: string, opts?: DeliverOptions): Promise<void> => {
    const meta: Record<string, string> = opts?.meta ? validateWireMeta(opts.meta) : {};
    meta.session_id = sessionId;
    if (opts?.messageId !== undefined) {
      meta.message_id = opts.messageId;
    }
    await server.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  };

  // A verdict always answers a permission_request claude emitted after its own
  // MCP handshake completed (bin.ts dials the control link only after
  // `initialized`), so unlike deliver there is no mid-handshake drop window.
  const respondPermission = async (
    requestId: string,
    behavior: "allow" | "deny",
  ): Promise<void> => {
    await server.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: requestId, behavior },
    });
  };

  return { server, deliver, respondPermission };
}
