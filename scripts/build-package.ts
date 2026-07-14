#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const entrypoints = process.argv.slice(2).map((entry) => resolve(entry));
if (entrypoints.length === 0) {
  throw new Error("usage: build-package <entrypoint...>");
}

const outdir = resolve("dist");
const sourceRoot = resolve("src");
if (outdir === resolve("/") || !outdir.endsWith("/dist")) {
  throw new Error(`refusing to clean unexpected output directory: ${outdir}`);
}
await rm(outdir, { recursive: true, force: true });

function resolveSourceAlias(specifier: string): string {
  const requested = resolve(sourceRoot, specifier.slice(2));
  for (const candidate of [requested, `${requested}.ts`, resolve(requested, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve package-local alias: ${specifier}`);
}

for (const entrypoint of entrypoints) {
  // Build public entrypoints independently. This keeps a CLI importing the
  // package's library entrypoint from creating cyclic shared chunks.
  const build = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    packages: "external",
    splitting: true,
    plugins: [
      {
        name: "package-local-source-alias",
        setup(builder) {
          builder.onResolve({ filter: /^@\// }, ({ path }) => ({
            path: resolveSourceAlias(path),
          }));
        },
      },
    ],
    sourcemap: "external",
    minify: false,
  });
  if (!build.success) {
    for (const log of build.logs) console.error(log);
    process.exit(1);
  }
}

const declarations = Bun.spawn(["bunx", "tsc", "-p", "tsconfig.build.json"], {
  cwd: process.cwd(),
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await declarations.exited;
if (exitCode !== 0) process.exit(exitCode);

async function declarationFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await declarationFiles(path)));
    else if (entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function declarationPath(fromFile: string, aliasTarget: string): string {
  const target = resolve(outdir, aliasTarget.slice(2));
  const path = relative(dirname(fromFile), target).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

// TypeScript preserves `paths` aliases in declarations. Published packages cannot
// resolve a package-local `@/`, so make those references portable before packing.
for (const file of await declarationFiles(outdir)) {
  const source = await readFile(file, "utf8");
  const portable = source.replace(/(["'])@\/([^"']+)\1/g, (_match, quote, path) => {
    return `${quote}${declarationPath(file, `@/${path}`)}${quote}`;
  });
  if (portable !== source) await writeFile(file, portable);
}
