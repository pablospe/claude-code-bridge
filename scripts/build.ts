#!/usr/bin/env bun
// Build pipeline for claudecode-bridge — produces dist/ with bundled bins,
// a self-contained library entry, and TypeScript declarations.
//
// Bun bundles each bin and the library entry with --target=node. The four
// runtime dependencies declared in the root package.json stay external so the
// native node-pty bindings load correctly and the bundles do not duplicate
// large libraries.

import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { $ } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = resolve(ROOT, "dist");
const BIN_DIR = resolve(DIST, "bin");

const EXTERNALS = [
  "@homebridge/node-pty-prebuilt-multiarch",
  "@modelcontextprotocol/sdk",
  "commander",
  "zod",
] as const;

interface BundleSpec {
  entry: string;
  outfile: string;
  bin: boolean;
}

const BUNDLES: readonly BundleSpec[] = [
  {
    entry: "apps/ccb/src/cli.ts",
    outfile: "dist/bin/ccb.js",
    bin: true,
  },
  {
    entry: "packages/mcp-channel/src/bin.ts",
    outfile: "dist/bin/ccb-channel-server.js",
    bin: true,
  },
  {
    entry: "packages/mcp-channel/src/hook-relay.ts",
    outfile: "dist/bin/ccb-hook-relay.js",
    bin: true,
  },
  {
    entry: "src/index.ts",
    outfile: "dist/index.js",
    bin: false,
  },
];

const NODE_SHEBANG = "#!/usr/bin/env node\n";

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function clean(): Promise<void> {
  log("[build] cleaning dist/");
  await rm(DIST, { recursive: true, force: true });
  await mkdir(BIN_DIR, { recursive: true });
}

async function bundle(spec: BundleSpec): Promise<void> {
  const entry = resolve(ROOT, spec.entry);
  const outfile = resolve(ROOT, spec.outfile);
  const externalFlags = EXTERNALS.flatMap((dep) => ["--external", dep]);
  // tsconfig.publish.json carries the @ccb/* paths map so bun build can
  // resolve workspace specifiers when the root package isn't itself a
  // workspace member (no node_modules/@ccb/ symlinks at the root).
  log(`[build] bundling ${spec.outfile}`);
  const result =
    await $`bun build ${entry} --target=node --outfile=${outfile} --tsconfig-override=tsconfig.publish.json ${externalFlags}`
      .cwd(ROOT)
      .quiet()
      .nothrow();
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr.toString());
    throw new Error(`bun build failed for ${spec.entry} (exit ${result.exitCode})`);
  }
  if (spec.bin) {
    await prependShebang(outfile);
    await chmod(outfile, 0o755);
  }
}

async function prependShebang(file: string): Promise<void> {
  // bun build preserves the source's `#!/usr/bin/env bun` as a regular line.
  // Strip any leading shebang(s) before prepending the canonical Node one so
  // the published bin runs under node (not bun) and parses cleanly.
  const current = await readFile(file, "utf8");
  const stripped = current.replace(/^(?:#![^\n]*\n)+/, "");
  // bun build lowers `import.meta.main` to `__require.main == __require.module`
  // even with --target=node + ESM output — neither identifier is defined in
  // an ESM bin under Node. The bin is invoked directly (never imported), so
  // collapse the guard to `true` and always run main().
  const fixed = stripped.replace(/__require\.main\s*==\s*__require\.module/g, "true");
  await writeFile(file, NODE_SHEBANG + fixed);
}

async function emitDeclarations(): Promise<void> {
  log("[build] emitting dist/types/ via tsc");
  const result = await $`bunx tsc -p tsconfig.publish.json --emitDeclarationOnly`
    .cwd(ROOT)
    .quiet()
    .nothrow();
  if (result.exitCode !== 0) {
    process.stderr.write(result.stdout.toString());
    process.stderr.write(result.stderr.toString());
    throw new Error(`tsc declaration emit failed (exit ${result.exitCode})`);
  }
  await flattenDeclarations();
}

const TYPES_DIR = resolve(DIST, "types");

// tsc with rootDir=. emits dist/types/src/index.d.ts and the transitive
// dist/types/packages/<pkg>/src/*.d.ts tree. Consumers expect the entry at
// dist/types/index.d.ts, and the @ccb/* import specifiers inside the emitted
// .d.ts files must be rewritten to relative paths so consumers don't need
// the private workspace packages installed.
async function flattenDeclarations(): Promise<void> {
  log("[build] flattening dist/types/");
  const srcEntry = resolve(TYPES_DIR, "src", "index.d.ts");
  const destEntry = resolve(TYPES_DIR, "index.d.ts");
  await rename(srcEntry, destEntry);
  await rm(resolve(TYPES_DIR, "src"), { recursive: true, force: true });
  await rewriteWorkspaceImports(TYPES_DIR);
}

const WORKSPACE_PACKAGES: Readonly<Record<string, string>> = {
  "@ccb/core": "packages/core/src/index",
  "@ccb/claude-code": "packages/claude-code/src/index",
  "@ccb/mcp-channel": "packages/mcp-channel/src/index",
  "@ccb/process": "packages/process/src/index",
};

async function rewriteWorkspaceImports(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteWorkspaceImports(path);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const content = await readFile(path, "utf8");
    let rewritten = content.replace(
      /(["'])@ccb\/(core|claude-code|mcp-channel|process)\1/g,
      (_match, quote, name) => {
        const target = WORKSPACE_PACKAGES[`@ccb/${name}`];
        if (!target) throw new Error(`unmapped workspace import @ccb/${name}`);
        const absoluteTarget = resolve(TYPES_DIR, target);
        const rel = relative(dirname(path), absoluteTarget) || ".";
        const normalized = rel.startsWith(".") ? rel : `./${rel}`;
        return `${quote}${normalized}${quote}`;
      },
    );
    // allowImportingTsExtensions preserves the .ts suffix in emitted .d.ts —
    // strip it so consumer toolchains resolve sibling .d.ts files normally.
    rewritten = rewritten.replace(
      /(["'])(\.{1,2}\/[^"']+?)\.ts\1/g,
      (_match, quote, path) => `${quote}${path}${quote}`,
    );
    if (rewritten !== content) {
      await writeFile(path, rewritten);
    }
  }
}

async function main(): Promise<void> {
  await clean();
  for (const spec of BUNDLES) {
    await bundle(spec);
  }
  await emitDeclarations();
  log("[build] done");
}

main().catch((err) => {
  process.stderr.write(`[build] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
