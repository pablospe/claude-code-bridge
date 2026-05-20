import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, ".claude-plugin/plugin.json");

interface PluginManifest {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly mcpServers?: Record<string, McpServerEntry>;
  readonly channels?: ReadonlyArray<ChannelEntry>;
  readonly hooks?: Record<string, ReadonlyArray<HookMatcher>>;
}

interface McpServerEntry {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
}

interface ChannelEntry {
  readonly server: string;
}

interface HookMatcher {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<HookCommand>;
}

interface HookCommand {
  readonly type: "command";
  readonly command: string;
}

async function readManifest(): Promise<PluginManifest> {
  const text = await Bun.file(manifestPath).text();
  return JSON.parse(text) as PluginManifest;
}

describe("ccb plugin manifest", () => {
  test("manifest file exists at .claude-plugin/plugin.json", async () => {
    expect(await Bun.file(manifestPath).exists()).toBe(true);
  });

  test("manifest parses as valid JSON", async () => {
    const text = await Bun.file(manifestPath).text();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test("name is 'ccb'", async () => {
    const manifest = await readManifest();
    expect(manifest.name).toBe("ccb");
  });

  test("description states the `bun add -g` global-install prereq", async () => {
    const manifest = await readManifest();
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description).toContain("bun add -g");
    expect(manifest.description).toContain("@pablospe/claude-code-bridge");
  });

  test("mcp server entry uses the bare bin name (no path, no bunx, no shell metachars)", async () => {
    const manifest = await readManifest();
    const ccb = manifest.mcpServers?.ccb;
    expect(ccb?.command).toBe("ccb-channel-server");
    // No args: the bare bin reads CCB_BRIDGE_ENDPOINT / CCB_SESSION_ID from env.
    expect(ccb?.args ?? []).toEqual([]);
  });

  test("mcp server env declares CCB_BRIDGE_ENDPOINT and CCB_SESSION_ID placeholders", async () => {
    const manifest = await readManifest();
    const env = manifest.mcpServers?.ccb?.env ?? {};
    // The literal `${...}` strings are claude's substitution syntax, not JS
    // template placeholders — claude resolves them at plugin-load time.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: claude-plugin substitution placeholder, not a JS template literal.
    expect(env.CCB_BRIDGE_ENDPOINT).toBe("${CCB_BRIDGE_ENDPOINT}");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: claude-plugin substitution placeholder, not a JS template literal.
    expect(env.CCB_SESSION_ID).toBe("${CCB_SESSION_ID}");
  });

  test("declares a channel bound to the ccb mcp server", async () => {
    const manifest = await readManifest();
    expect(Array.isArray(manifest.channels)).toBe(true);
    expect(manifest.channels?.length ?? 0).toBeGreaterThan(0);
    const channel = manifest.channels?.find((c) => c.server === "ccb");
    expect(channel).toBeDefined();
  });

  test("declares hooks for the three M3 minimum events", async () => {
    const manifest = await readManifest();
    expect(manifest.hooks).toBeDefined();
    const eventNames = Object.keys(manifest.hooks ?? {});
    expect(eventNames).toEqual(expect.arrayContaining(["PreToolUse", "PostToolUse", "Stop"]));
  });

  test("each hook command invokes `ccb-hook-relay <event>` by bare bin name", async () => {
    const manifest = await readManifest();
    const hooks = manifest.hooks ?? {};
    for (const event of ["PreToolUse", "PostToolUse", "Stop"] as const) {
      const matchers = hooks[event] ?? [];
      expect(matchers.length).toBeGreaterThan(0);
      const first = matchers[0]?.hooks?.[0];
      expect(first?.type).toBe("command");
      expect(first?.command).toBe(`ccb-hook-relay ${event}`);
    }
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: the test name documents the literal claude placeholder we are forbidding.
  test("manifest text contains zero `${CLAUDE_PROJECT_DIR}` references", async () => {
    // The dev-flag channels mode uses CLAUDE_PROJECT_DIR; the published
    // plugin manifest does not. This guard fails loudly if the workspace
    // path leaks back in via copy-paste from a future edit.
    const text = await Bun.file(manifestPath).text();
    expect(text).not.toContain("CLAUDE_PROJECT_DIR");
  });

  test("manifest commands do not invoke `bunx` (would risk M3 500ms hook budget)", async () => {
    const manifest = await readManifest();
    const ccbCommand = manifest.mcpServers?.ccb?.command ?? "";
    expect(ccbCommand.startsWith("bunx")).toBe(false);
    for (const matchers of Object.values(manifest.hooks ?? {})) {
      for (const matcher of matchers) {
        for (const hook of matcher.hooks) {
          expect(hook.command.startsWith("bunx")).toBe(false);
        }
      }
    }
  });
});
