import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export type ToolName = "bridge_reply" | "bridge_progress" | "bridge_done";

export type OnToolCallback = (
  name: ToolName,
  args: Record<string, unknown>,
) => void | Promise<void>;

export interface CreateChannelServerOptions {
  readonly sessionId: string;
  readonly onTool?: OnToolCallback;
}

export interface ChannelServerHandle {
  readonly server: Server;
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
  // sessionId is captured for future use (deliver in step 3).
  void options.sessionId;
  const { onTool } = options;

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
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      await onTool?.(name, args);
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

  return { server };
}
