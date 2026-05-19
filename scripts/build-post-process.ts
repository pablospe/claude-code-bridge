// Post-processing helpers for the publish build.
//
// These exist because `bun build` and `tsc --emitDeclarationOnly` each
// produce output that's *almost* but not quite what an npm consumer expects.
// Rather than scatter the workarounds through `build.ts`, this module is the
// one place each hack lives with its rationale. If a future Bun release
// fixes any of these upstream, the corresponding function here goes away.
//
// Source-of-truth references:
//   - bun build shebang behavior: preserves source `#!/usr/bin/env bun` as a
//     code line and inserts a `// @bun` marker. The published bins run under
//     node, so the source shebang has to come off.
//   - bun build `import.meta.main` lowering: for ESM under --target=node the
//     bundler emits `__require.main == __require.module`, neither of which
//     is defined in ESM. Each bin is only ever invoked directly (never
//     imported), so collapsing to `true` is safe.
//   - tsc rootDir + `allowImportingTsExtensions`: tsc resolves `@ccb/*` to
//     `packages/<pkg>/src/index.ts` (the workspace `types` field) and emits
//     the declaration tree under `dist/types/packages/<pkg>/src/`. Consumers
//     don't have the private `@ccb/*` packages installed, so the workspace
//     specifiers in the emitted `.d.ts` files must be rewritten to relative
//     paths inside `dist/types/`, AND the `.ts` import suffixes the option
//     preserves must be stripped.

import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const NODE_SHEBANG = "#!/usr/bin/env node\n";

/**
 * Strip any leading shebang lines bun build preserved from the source and
 * prepend the canonical Node shebang. Also collapses `bun build`'s broken
 * `import.meta.main` lowering to `true` so each bin's main() always runs
 * (the bins are only ever invoked directly).
 */
export async function rewriteBinShebang(file: string): Promise<void> {
  const current = await readFile(file, "utf8");
  const stripped = current.replace(/^(?:#![^\n]*\n)+/, "");
  const fixed = stripped.replace(/__require\.main\s*==\s*__require\.module/g, "true");
  await writeFile(file, NODE_SHEBANG + fixed);
}

const WORKSPACE_PACKAGES: Readonly<Record<string, string>> = {
  "@ccb/core": "packages/core/src/index",
  "@ccb/claude-code": "packages/claude-code/src/index",
  "@ccb/mcp-channel": "packages/mcp-channel/src/index",
  "@ccb/process": "packages/process/src/index",
};

/**
 * Move `dist/types/src/index.d.ts` to `dist/types/index.d.ts` so the
 * `types` field in `package.json` resolves, and rewrite any remaining
 * `@ccb/*` specifiers in the emitted `.d.ts` files to relative paths
 * inside `dist/types/`. Internal `@ccb/*` packages stay `"private": true`
 * and are not published, so consumers must not see those module specifiers.
 */
export async function flattenDeclarations(typesDir: string): Promise<void> {
  const srcEntry = resolve(typesDir, "src", "index.d.ts");
  const destEntry = resolve(typesDir, "index.d.ts");
  await rename(srcEntry, destEntry);
  await rm(resolve(typesDir, "src"), { recursive: true, force: true });
  await rewriteWorkspaceImports(typesDir, typesDir);
}

async function rewriteWorkspaceImports(dir: string, typesDir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteWorkspaceImports(path, typesDir);
      continue;
    }
    if (!entry.name.endsWith(".d.ts")) continue;
    const content = await readFile(path, "utf8");
    let rewritten = content.replace(
      /(["'])@ccb\/(core|claude-code|mcp-channel|process)\1/g,
      (_match, quote, name) => {
        const target = WORKSPACE_PACKAGES[`@ccb/${name}`];
        if (!target) throw new Error(`unmapped workspace import @ccb/${name}`);
        const absoluteTarget = resolve(typesDir, target);
        const rel = relative(dirname(path), absoluteTarget) || ".";
        const normalized = rel.startsWith(".") ? rel : `./${rel}`;
        return `${quote}${normalized}${quote}`;
      },
    );
    // `allowImportingTsExtensions` (inherited from tsconfig.base.json) keeps
    // the `.ts` suffix on relative imports inside emitted `.d.ts` files.
    // Consumer toolchains expect sibling `.d.ts` resolution, so strip it.
    rewritten = rewritten.replace(
      /(["'])(\.{1,2}\/[^"']+?)\.ts\1/g,
      (_match, quote, p) => `${quote}${p}${quote}`,
    );
    if (rewritten !== content) {
      await writeFile(path, rewritten);
    }
  }
}
