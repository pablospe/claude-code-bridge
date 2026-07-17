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
  // A tool name with internal whitespace (or that is empty) can never match a
  // single permission.requested toolName, so it is always a bug — and on the
  // supervisor side it would be split into multiple pre-approved --allowed-tools
  // entries, silently granting more access than intended. Reject structurally.
  for (const tool of tools) {
    if (tool.length === 0 || /\s/.test(tool)) {
      throw new TypeError(`invalid tool name in allowlist: ${JSON.stringify(tool)}`);
    }
  }
  const allowed = new Set(tools);
  return { decide: (toolName) => (allowed.has(toolName) ? "allow" : "deny") };
}
