#!/usr/bin/env bun

import { existsSync, statSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const packageRoot = resolve(root, "apps/negotium");
const outdir = resolve(packageRoot, "dist");

const packageEntrypoints = new Map<string, string>([
  ["@negotium/adapter-sdk", "packages/adapter-sdk/src/index.ts"],
  ["@negotium/adapter-sdk/outbox", "packages/adapter-sdk/src/outbox.ts"],
  ["@negotium/adapter-sdk/testkit", "packages/adapter-sdk/src/testkit.ts"],
  ["@negotium/core", "packages/core/src/index.ts"],
  ["@negotium/core/hosted-agent", "packages/core/src/agents/hosted-agent.ts"],
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
  ["@negotium/adapter-otium/relay", "adapters/otium/src/relay.ts"],
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

await rm(outdir, { recursive: true, force: true });

const build = await Bun.build({
  entrypoints: [resolve(root, "apps/cli/src/main.ts")],
  outdir,
  target: "bun",
  packages: "external",
  splitting: true,
  sourcemap: "external",
  minify: false,
  plugins: [
    {
      name: "bundle-negotium-workspaces",
      setup(builder) {
        builder.onResolve({ filter: /^@negotium\// }, ({ path }) => {
          const entrypoint = packageEntrypoints.get(path);
          if (!entrypoint) throw new Error(`unmapped internal package import: ${path}`);
          return { path: resolve(root, entrypoint) };
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

const runtimeRoot = resolve(outdir, "runtime");
await mkdir(runtimeRoot, { recursive: true });
await cp(resolve(root, "packages/core/src"), resolve(runtimeRoot, "src"), { recursive: true });
await cp(resolve(root, "packages/core/scripts"), resolve(runtimeRoot, "scripts"), {
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

const main = resolve(outdir, "main.js");
if (!(await Bun.file(main).exists())) {
  throw new Error(`bundled CLI entrypoint missing: ${main}`);
}
