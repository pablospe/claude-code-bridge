import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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

export interface CreateChannelServerOptions {
  readonly sessionId: string;
  readonly onTool?: OnToolCallback;
}

export interface DeliverOptions {
  readonly messageId?: string;
  readonly meta?: Readonly<Record<string, string>>;
}

export interface ChannelServerHandle {
  readonly server: Server;
  deliver(content: string, opts?: DeliverOptions): Promise<void>;
}

const INSTRUCTIONS =
  'Messages from the bridge arrive as <channel source="ccb" session_id="..." message_id="...">content</channel>. ' +
  "When you have a final reply for the user, call bridge_reply with the response content and final:true. " +
  "For intermediate progress, call bridge_progress with the partial content. " +
  "When you've completed your turn (no more replies coming), call bridge_done. " +
  "Always pass the message_id from the channel tag when responding to a specific message.";

const TOOLS: readonly Tool[] = [
  {
    name: "bridge_reply",
    description:
      "Send a reply back to the bridge. Set final:true when this is the complete response for the message.",
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
    description: "Signal that the turn is complete and no more replies are coming.",
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

function isToolName(name: string): name is ToolName {
  return TOOL_NAMES.has(name as ToolName);
}

export function createChannelServer(options: CreateChannelServerOptions): ChannelServerHandle {
  const { sessionId, onTool } = options;

  const server = new Server(
    { name: "ccb", version: "0.0.1" },
    {
      capabilities: {
        tools: {},
        experimental: { "claude/channel": {} },
      },
      instructions: INSTRUCTIONS,
    },
  );

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

  return { server, deliver };
}
