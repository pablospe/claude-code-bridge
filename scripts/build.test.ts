import { beforeAll, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = resolve(ROOT, "dist");

const BINS = ["ccb.js", "ccb-channel-server.js", "ccb-hook-relay.js"] as const;

// Externals must remain as runtime imports — bundling them would either break
// native bindings (node-pty) or inflate every bin needlessly.
const EXTERNALS = [
  "@homebridge/node-pty-prebuilt-multiarch",
  "@modelcontextprotocol/sdk",
  "commander",
  "zod",
] as const;

describe("bun run build", () => {
  beforeAll(async () => {
    const result = await $`bun run build`.cwd(ROOT).quiet().nothrow();
    if (result.exitCode !== 0) {
      throw new Error(
        `bun run build failed (exit ${result.exitCode}):\n${result.stderr.toString()}`,
      );
    }
  });

  test("emits each bin with the Node shebang", async () => {
    for (const name of BINS) {
      const file = resolve(DIST, "bin", name);
      const content = await readFile(file, "utf8");
      expect(content.startsWith("#!/usr/bin/env node\n")).toBe(true);
    }
  });

  test("marks each bin executable", async () => {
    for (const name of BINS) {
      const file = resolve(DIST, "bin", name);
      const info = await stat(file);
      expect(info.mode & 0o111).not.toBe(0);
    }
  });

  test("emits dist/index.js as a non-empty ESM bundle", async () => {
    const file = resolve(DIST, "index.js");
    const content = await readFile(file, "utf8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("export");
  });

  test("emits dist/types/index.d.ts with the locked public surface", async () => {
    const file = resolve(DIST, "types", "index.d.ts");
    const content = await readFile(file, "utf8");
    for (const symbol of [
      "Bridge",
      "BridgeEvent",
      "JsonlEventStore",
      "claudeCodeSupervisorFactory",
      "mockSupervisorFactory",
      "StartTimeoutError",
      "CRASH_AGENT_DONE_REASON",
      "CRASH_SESSION_ENDED_REASON",
    ]) {
      expect(content).toContain(symbol);
    }
  });

  test("respects externals — node-pty path is not inlined into any bin", async () => {
    // Bundling node-pty inlines a path of the form
    // `@homebridge/node-pty-prebuilt-multiarch/build/Release/...`. A clean
    // external import keeps only the bare specifier in the bundle.
    const needle = "@homebridge/node-pty-prebuilt-multiarch/";
    for (const name of BINS) {
      const file = resolve(DIST, "bin", name);
      const content = await readFile(file, "utf8");
      expect(content).not.toContain(needle);
    }
  });

  test("keeps locked externals as runtime imports in the library bundle", async () => {
    const content = await readFile(resolve(DIST, "index.js"), "utf8");
    for (const ext of EXTERNALS) {
      // Any reference to an external must look like a runtime specifier —
      // either `from "<pkg>"` / `from "<pkg>/sub"` or `require("<pkg>")`. A
      // bundled-in version would have the package source inlined and the
      // bare specifier would not survive.
      const escaped = ext.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
      const importRe = new RegExp(
        `(?:from\\s*["']${escaped}(?:/[^"']+)?["']|require\\(\\s*["']${escaped}(?:/[^"']+)?["']\\s*\\))`,
      );
      if (content.includes(ext)) {
        expect(content).toMatch(importRe);
      }
    }
  });

  test("bundles @ccb/* workspace packages — no runtime import to @ccb/", async () => {
    // Internal workspace packages are private; the published artifact must be
    // self-contained for the @ccb/* graph.
    const content = await readFile(resolve(DIST, "index.js"), "utf8");
    expect(content).not.toMatch(/from\s*["']@ccb\//);
  });
});
