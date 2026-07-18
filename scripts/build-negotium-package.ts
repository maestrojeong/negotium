#!/usr/bin/env bun

import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageRoot = resolve(root, "apps/negotium");
const outdir = resolve(packageRoot, "dist");

const packageEntrypoints = new Map<string, string>([
  ["@negotium/adapter-sdk", "packages/adapter-sdk/src/index.ts"],
  ["@negotium/adapter-sdk/outbox", "packages/adapter-sdk/src/outbox.ts"],
  ["@negotium/adapter-sdk/testkit", "packages/adapter-sdk/src/testkit.ts"],
  ["@negotium/core", "packages/core/src/index.ts"],
  ["@negotium/core/hosted-agent", "packages/core/src/agents/hosted-agent.ts"],
  ["@negotium/core/registry", "packages/core/src/agents/registry.ts"],
  ["@negotium/core/rollout", "packages/core/src/agents/rollout/index.ts"],
  ["@negotium/core/vault", "packages/core/src/storage/vault-public.ts"],
  ["@negotium/core/storage", "packages/core/src/storage/storage-public.ts"],
  ["@negotium/core/prompts", "packages/core/src/prompts/builders.ts"],
  ["@negotium/core/runtime-helpers", "packages/core/src/runtime/public-helpers.ts"],
  [
    "@negotium/core/peer-session-bridge-ipc",
    "packages/core/src/mcp/session-comm/bridge-ipc-config.ts",
  ],
  ["@negotium/core/canonical-mcp-bridge", "packages/core/src/mcp/canonical-bridge-config.ts"],
  ["@negotium/mcp", "packages/mcp/src/index.ts"],
  ["@negotium/mcp-host", "packages/mcp-host/src/index.ts"],
  ["@negotium/module-cron", "packages/module-cron/src/index.ts"],
  ["@negotium/node", "packages/node/src/index.ts"],
  ["@negotium/adapter-terminal", "adapters/terminal/src/index.ts"],
  ["@negotium/adapter-terminal/cli", "adapters/terminal/src/cli.ts"],
  ["@negotium/adapter-telegram", "adapters/telegram/src/index.ts"],
  ["@negotium/adapter-telegram/cli", "adapters/telegram/src/cli.ts"],
  ["@negotium/adapter-otium", "adapters/otium/src/index.ts"],
  ["@negotium/adapter-otium/cli", "adapters/otium/src/cli.ts"],
  ["@negotium/adapter-otium/node-runtime", "adapters/otium/src/node-runtime.ts"],
  ["@negotium/adapter-otium/relay", "adapters/otium/src/relay.ts"],
  ["@negotium/adapter-otium/sidecar", "adapters/otium/src/sidecar.ts"],
  ["@negotium/cli", "apps/cli/src/main.ts"],
]);

const localSourceRoots = [
  resolve(root, "apps/cli/src"),
  resolve(root, "adapters/terminal/src"),
  resolve(root, "adapters/telegram/src"),
  resolve(root, "adapters/otium/src"),
];

const packageImportRoots = [
  resolve(root, "packages/core/src"),
  resolve(root, "packages/mcp/src"),
  resolve(root, "packages/mcp-host/src"),
  resolve(root, "packages/module-cron/src"),
];

function resolveTypeScriptSource(requested: string): string {
  for (const candidate of [requested, `${requested}.ts`, resolve(requested, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve bundled source: ${requested}`);
}

function resolveLocalAlias(specifier: string, importer: string): string {
  const sourceRoot = localSourceRoots.find(
    (candidate) => importer === candidate || importer.startsWith(`${candidate}/`),
  );
  if (!sourceRoot) throw new Error(`cannot resolve ${specifier} from ${importer}`);
  return resolveTypeScriptSource(resolve(sourceRoot, specifier.slice(2)));
}

function resolvePackageImport(specifier: string, importer: string): string {
  const sourceRoot = packageImportRoots.find(
    (candidate) => importer === candidate || importer.startsWith(`${candidate}/`),
  );
  if (!sourceRoot) throw new Error(`cannot resolve ${specifier} from ${importer}`);
  return resolveTypeScriptSource(resolve(sourceRoot, specifier.slice(1)));
}

async function bundle(entrypoints: string[], splitting = true): Promise<void> {
  const build = await Bun.build({
    // Keep every public entrypoint in one build graph. Stateful core modules
    // (for example canonical MCP bridge registrations) must be emitted once
    // into a shared chunk rather than copied into independently-built bundles.
    entrypoints: entrypoints.map((entrypoint) => resolve(root, entrypoint)),
    outdir,
    target: "bun",
    packages: "external",
    splitting,
    naming: {
      entry: "[name].[ext]",
      chunk: "chunk-[hash].[ext]",
    },
    sourcemap: "external",
    minify: false,
    plugins: [
      {
        name: "bundle-negotium-workspaces",
        setup(builder) {
          builder.onResolve({ filter: /^@negotium\// }, ({ path }) => {
            const mappedEntrypoint = packageEntrypoints.get(path);
            if (!mappedEntrypoint) throw new Error(`unmapped internal package import: ${path}`);
            return { path: resolve(root, mappedEntrypoint) };
          });
          builder.onResolve({ filter: /^@\// }, ({ path, importer }) => ({
            path: resolveLocalAlias(path, importer),
          }));
          builder.onResolve({ filter: /^#/ }, ({ path, importer }) => ({
            path: resolvePackageImport(path, importer),
          }));
        },
      },
    ],
  });

  if (!build.success) {
    for (const log of build.logs) console.error(log);
    process.exit(1);
  }
}

await rm(outdir, { recursive: true, force: true });
// The CLI dynamically loads every adapter. Building it in a split graph with
// public library entrypoints can make Bun re-export an imported binding twice
// in a shared adapter chunk, which newer Bun runtimes reject as invalid ESM.
await bundle(["apps/cli/src/main.ts"], false);
await bundle(["apps/negotium/src/hosted-agent.ts", "apps/negotium/src/canonical-mcp-bridge.ts"]);

// Registry writers consume the mutable rollout-host configuration. Keep both
// public entrypoints in one graph so configureRolloutHost() and getRegistry()
// observe the same singleton instead of two independently bundled copies.
await bundle(["apps/negotium/src/registry.ts", "apps/negotium/src/rollout.ts"]);

// These remaining leaf entrypoints do not share mutable runtime registrations
// with one another. Building them independently avoids Bun exposing both a source
// module's exports and @negotium/core's re-exports in the same split chunk,
// which produces invalid duplicate ESM export names.
for (const entrypoint of [
  "apps/negotium/src/cron.ts",
  "apps/negotium/src/mcp-servers.ts",
  "apps/negotium/src/vault.ts",
  "apps/negotium/src/storage.ts",
  "apps/negotium/src/prompts.ts",
  "apps/negotium/src/runtime-helpers.ts",
]) {
  await bundle([entrypoint], false);
}

const runtimeRoot = resolve(outdir, "runtime");
await mkdir(runtimeRoot, { recursive: true });
await cp(resolve(root, "packages/core/src"), resolve(runtimeRoot, "src"), { recursive: true });
await cp(resolve(root, "packages/core/scripts"), resolve(runtimeRoot, "scripts"), {
  recursive: true,
});
await cp(resolve(root, "packages/module-cron/src"), resolve(runtimeRoot, "cron"), {
  recursive: true,
});
await Bun.write(
  resolve(runtimeRoot, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "#*": ["src/*.ts"] },
      },
    },
    null,
    2,
  )}\n`,
);

const typesRoot = resolve(outdir, "types");
const declarations = Bun.spawn(
  [
    "bunx",
    "tsc",
    "--noEmit",
    "false",
    "--emitDeclarationOnly",
    "--declaration",
    "--declarationMap",
    "false",
    "--moduleResolution",
    "bundler",
    "--module",
    "esnext",
    "--target",
    "esnext",
    "--lib",
    "esnext",
    "--types",
    "bun-types",
    "--skipLibCheck",
    "--strict",
    "--rootDir",
    root,
    "--outDir",
    typesRoot,
    resolve(root, "packages/core/src/agents/hosted-agent.ts"),
    resolve(root, "packages/core/src/mcp/canonical-bridge-config.ts"),
    resolve(root, "packages/module-cron/src/index.ts"),
    resolve(root, "apps/negotium/src/mcp-servers.ts"),
    resolve(root, "packages/core/src/agents/registry.ts"),
    resolve(root, "packages/core/src/agents/rollout/index.ts"),
    resolve(root, "packages/core/src/storage/vault-public.ts"),
    resolve(root, "packages/core/src/storage/storage-public.ts"),
    resolve(root, "packages/core/src/prompts/builders.ts"),
    resolve(root, "packages/core/src/runtime/public-helpers.ts"),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if ((await declarations.exited) !== 0) process.exit(1);

async function declarationFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await declarationFiles(path)));
    else if (entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function relativeDeclaration(fromFile: string, targetWithoutExtension: string): string {
  const path = relative(dirname(fromFile), targetWithoutExtension).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

for (const file of await declarationFiles(typesRoot)) {
  const source = await readFile(file, "utf8");
  const packageSource = relative(typesRoot, file).replaceAll("\\", "/");
  const aliasRoot = packageSource.startsWith("packages/module-cron/src/")
    ? resolve(typesRoot, "packages/module-cron/src")
    : resolve(typesRoot, "packages/core/src");
  const portable = source
    .replace(/(["'])#([^"']+)\1/g, (_match, quote, specifier) => {
      return `${quote}${relativeDeclaration(file, resolve(aliasRoot, specifier))}${quote}`;
    })
    .replace(/(["'])@negotium\/core\/hosted-agent\1/g, (_match, quote) => {
      const target = resolve(typesRoot, "packages/core/src/agents/hosted-agent");
      return `${quote}${relativeDeclaration(file, target)}${quote}`;
    })
    .replace(/(["'])@negotium\/core\1/g, (_match, quote) => {
      const target = resolve(typesRoot, "packages/core/src/index");
      return `${quote}${relativeDeclaration(file, target)}${quote}`;
    });
  if (portable !== source) await writeFile(file, portable);
}

const main = resolve(outdir, "main.js");
if (!(await Bun.file(main).exists())) {
  throw new Error(`bundled CLI entrypoint missing: ${main}`);
}
for (const publicEntrypoint of [
  "hosted-agent.js",
  "canonical-mcp-bridge.js",
  "cron.js",
  "mcp-servers.js",
  "registry.js",
  "rollout.js",
  "vault.js",
  "storage.js",
  "prompts.js",
  "runtime-helpers.js",
]) {
  const path = resolve(outdir, publicEntrypoint);
  if (!(await Bun.file(path).exists())) {
    throw new Error(`bundled public entrypoint missing: ${path}`);
  }
}
