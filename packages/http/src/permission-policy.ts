/**
 * Decides tool-permission prompts for headless pool sessions. Pure function of
 * the tool name — description/inputPreview are deliberately not consulted (no
 * content sniffing). The relay is the deny backstop: allowlisted tools are
 * normally pre-approved at launch via --allowed-tools and never prompt; the
 * policy answers anything that still does (MCP tools, unlisted tools).
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
