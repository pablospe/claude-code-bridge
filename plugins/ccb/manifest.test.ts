import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, ".claude-plugin/plugin.json");
const repoRoot = resolve(here, "../..");

interface PluginManifest {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly mcpServers?: Record<string, McpServerEntry>;
  readonly channels?: ReadonlyArray<ChannelEntry>;
}

interface McpServerEntry {
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Record<string, string>;
}

interface ChannelEntry {
  readonly server: string;
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

  test("description is present and a non-empty string", async () => {
    const manifest = await readManifest();
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description?.length ?? 0).toBeGreaterThan(0);
  });

  test("declares the ccb MCP server entry", async () => {
    const manifest = await readManifest();
    expect(manifest.mcpServers).toBeDefined();
    expect(manifest.mcpServers?.ccb).toBeDefined();
    const ccb = manifest.mcpServers?.ccb;
    expect(typeof ccb?.command).toBe("string");
    expect(Array.isArray(ccb?.args)).toBe(true);
    expect(ccb?.args?.length ?? 0).toBeGreaterThan(0);
  });

  test("mcp server entry args resolve to a real channel-server file", async () => {
    const manifest = await readManifest();
    const ccb = manifest.mcpServers?.ccb;
    const lastArg = ccb?.args?.[ccb.args.length - 1] ?? "";
    const placeholder = `\${CLAUDE_PROJECT_DIR}`;
    const resolved = lastArg.replace(placeholder, repoRoot);
    expect(existsSync(resolved)).toBe(true);
  });

  test("mcp server env declares CCB_BRIDGE_ENDPOINT and CCB_SESSION_ID", async () => {
    const manifest = await readManifest();
    const env = manifest.mcpServers?.ccb?.env ?? {};
    expect(Object.keys(env)).toEqual(
      expect.arrayContaining(["CCB_BRIDGE_ENDPOINT", "CCB_SESSION_ID"]),
    );
  });

  test("declares a channel bound to the ccb mcp server", async () => {
    const manifest = await readManifest();
    expect(Array.isArray(manifest.channels)).toBe(true);
    expect(manifest.channels?.length ?? 0).toBeGreaterThan(0);
    const channel = manifest.channels?.find((c) => c.server === "ccb");
    expect(channel).toBeDefined();
  });
});
