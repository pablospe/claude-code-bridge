#!/usr/bin/env bun
// Build pipeline for @pablospe/claude-code-bridge: orchestrates the bin + library
// bundles via `bun build`, the declaration emit via `tsc`, and the
// post-processing hacks documented in `./build-post-process.ts`.
//
// Workflow:
//   1. clean dist/
//   2. for each entry → `bun build --target=node` → dist/bin/<name>.js or dist/index.js
//   3. for each bin → strip source shebang, prepend Node shebang, fix import.meta.main
//   4. `tsc --emitDeclarationOnly` → dist/types/...
//   5. flatten dist/types/src/index.d.ts to dist/types/index.d.ts and rewrite
//      `@ccb/*` specifiers in the emitted .d.ts files to relative paths
//
// The hacks in step 3 and 5 live in `./build-post-process.ts` with WHY
// comments referencing the upstream behaviors that necessitate them.

import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import { flattenDeclarations, rewriteBinShebang } from "./build-post-process.ts";

const ROOT = resolve(import.meta.dirname, "..");
const DIST = resolve(ROOT, "dist");
const BIN_DIR = resolve(DIST, "bin");
const TYPES_DIR = resolve(DIST, "types");

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
  { entry: "apps/ccb/src/cli.ts", outfile: "dist/bin/ccb.js", bin: true },
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
  { entry: "src/index.ts", outfile: "dist/index.js", bin: false },
];

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
    await rewriteBinShebang(outfile);
    await chmod(outfile, 0o755);
  }
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
  log("[build] flattening dist/types/");
  await flattenDeclarations(TYPES_DIR);
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
