import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const marketplacePath = resolve(repoRoot, ".claude-plugin/marketplace.json");

interface MarketplaceManifest {
  readonly name: string;
  readonly owner?: { readonly name: string; readonly email?: string };
  readonly plugins: ReadonlyArray<MarketplacePluginEntry>;
}

interface MarketplacePluginEntry {
  readonly name: string;
  readonly source: string;
  readonly description?: string;
}

async function readMarketplace(): Promise<MarketplaceManifest> {
  const text = await Bun.file(marketplacePath).text();
  return JSON.parse(text) as MarketplaceManifest;
}

describe("ccb-local marketplace", () => {
  test("marketplace.json exists at .claude-plugin/marketplace.json", async () => {
    expect(await Bun.file(marketplacePath).exists()).toBe(true);
  });

  test("parses as valid JSON", async () => {
    const text = await Bun.file(marketplacePath).text();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  test("declares name 'ccb-local'", async () => {
    const m = await readMarketplace();
    expect(m.name).toBe("ccb-local");
  });

  test("declares an owner with a name", async () => {
    const m = await readMarketplace();
    expect(typeof m.owner?.name).toBe("string");
    expect((m.owner?.name ?? "").length).toBeGreaterThan(0);
  });

  test("plugins array contains the ccb entry", async () => {
    const m = await readMarketplace();
    expect(Array.isArray(m.plugins)).toBe(true);
    const ccb = m.plugins.find((p) => p.name === "ccb");
    expect(ccb).toBeDefined();
    expect(typeof ccb?.source).toBe("string");
  });

  test("ccb plugin source resolves to a directory containing plugin.json", async () => {
    const m = await readMarketplace();
    const ccb = m.plugins.find((p) => p.name === "ccb");
    expect(ccb?.source.startsWith("./")).toBe(true);
    const pluginDir = resolve(repoRoot, ccb?.source ?? "");
    const manifest = Bun.file(`${pluginDir}/.claude-plugin/plugin.json`);
    expect(await manifest.exists()).toBe(true);
    const parsed = JSON.parse(await manifest.text()) as { name?: string };
    expect(parsed.name).toBe("ccb");
  });
});
