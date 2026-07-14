#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type ReleaseMode = "check" | "dry-run" | "smoke" | "publish" | "ci" | "status";

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  files?: string[];
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type ReleasePackage = {
  name: string;
  directory: string;
  manifest?: PackageManifest;
};

const root = resolve(import.meta.dir, "..");
const releasePackages: ReleasePackage[] = [
  { name: "@negotium/adapter-sdk", directory: "packages/adapter-sdk" },
  { name: "@negotium/core", directory: "packages/core" },
  { name: "@negotium/mcp-host", directory: "packages/mcp-host" },
  { name: "@negotium/module-cron", directory: "packages/module-cron" },
  { name: "@negotium/mcp", directory: "packages/mcp" },
  { name: "@negotium/node", directory: "packages/node" },
  { name: "@negotium/adapter-testkit", directory: "packages/adapter-testkit" },
  { name: "@negotium/adapter-terminal", directory: "adapters/terminal" },
  { name: "@negotium/adapter-telegram", directory: "adapters/telegram" },
  { name: "@negotium/adapter-otium", directory: "adapters/otium" },
  { name: "@negotium/cli", directory: "apps/cli" },
  { name: "negotium", directory: "apps/negotium" },
];

const mode = (process.argv[2] ?? "check") as ReleaseMode;
const args = new Set(process.argv.slice(3));
const supportedModes = new Set<ReleaseMode>([
  "check",
  "dry-run",
  "smoke",
  "publish",
  "ci",
  "status",
]);

function fail(message: string): never {
  throw new Error(message);
}

async function run(
  command: string,
  commandArgs: string[],
  cwd = root,
  printOutput = true,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const child = Bun.spawn([command, ...commandArgs], {
    cwd,
    env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (printOutput && output) process.stdout.write(output);
  if (exitCode !== 0) {
    fail(`${command} ${commandArgs.join(" ")} exited with status ${exitCode}`);
  }
  return output;
}

async function loadAndValidatePackages(): Promise<void> {
  const versions = new Set<string>();
  const packageIndexes = new Map(releasePackages.map((pkg, index) => [pkg.name, index]));

  for (const [index, pkg] of releasePackages.entries()) {
    const manifestPath = resolve(root, pkg.directory, "package.json");
    if (!(await Bun.file(manifestPath).exists())) fail(`missing manifest: ${manifestPath}`);
    const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
    pkg.manifest = manifest;

    if (manifest.name !== pkg.name) {
      fail(
        `${pkg.directory}: expected package name ${pkg.name}, found ${manifest.name ?? "<none>"}`,
      );
    }
    if (!manifest.version) fail(`${pkg.name}: version is required`);
    if (manifest.private) fail(`${pkg.name}: release package cannot be private`);
    if (manifest.publishConfig?.access !== "public") {
      fail(`${pkg.name}: publishConfig.access must be public`);
    }
    if (!manifest.files?.length) fail(`${pkg.name}: an explicit files allowlist is required`);
    if (!manifest.files.includes("LICENSE")) {
      fail(`${pkg.name}: files allowlist must include LICENSE`);
    }
    if (!(await Bun.file(resolve(root, pkg.directory, "LICENSE")).exists())) {
      fail(`${pkg.name}: package-local LICENSE is required`);
    }
    versions.add(manifest.version);

    const productionDependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const dependency of Object.keys(productionDependencies)) {
      const dependencyIndex = packageIndexes.get(dependency);
      if (dependencyIndex !== undefined && dependencyIndex >= index) {
        fail(`${pkg.name}: internal dependency ${dependency} must appear earlier in release order`);
      }
    }
  }

  if (versions.size !== 1) {
    fail(`Negotium packages release in lockstep; found versions: ${[...versions].join(", ")}`);
  }
}

function selectedPackages(): ReleasePackage[] {
  const onlyArg = [...args].find((arg) => arg.startsWith("--only="));
  const fromArg = [...args].find((arg) => arg.startsWith("--from="));
  if (onlyArg && fromArg) fail("use either --only=<package> or --from=<package>, not both");

  if (onlyArg) {
    const name = onlyArg.slice("--only=".length);
    const pkg = releasePackages.find((candidate) => candidate.name === name);
    if (!pkg) fail(`unknown package passed to --only: ${name}`);
    return [pkg];
  }

  if (fromArg) {
    const name = fromArg.slice("--from=".length);
    const index = releasePackages.findIndex((candidate) => candidate.name === name);
    if (index < 0) fail(`unknown package passed to --from: ${name}`);
    return releasePackages.slice(index);
  }

  return releasePackages;
}

async function isPublished(pkg: ReleasePackage): Promise<boolean> {
  const version = pkg.manifest?.version;
  if (!version) fail(`${pkg.name}: manifest was not loaded`);
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(version)}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return false;
  if (!response.ok) fail(`registry lookup failed for ${pkg.name}@${version}: ${response.status}`);
  return true;
}

async function waitUntilPublished(pkg: ReleasePackage): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await isPublished(pkg)) return;
    await Bun.sleep(1_000);
  }
  fail(`${pkg.name}@${pkg.manifest?.version} was not visible in the registry after publishing`);
}

async function ensureCleanWorktree(): Promise<void> {
  const status = await run("git", ["status", "--porcelain"], root, false);
  if (status.trim()) fail("refusing to publish from a dirty worktree; commit the release first");
}

async function dryRun(packages: ReleasePackage[]): Promise<void> {
  for (const pkg of packages) {
    console.log(`\n==> dry-run ${pkg.name}@${pkg.manifest?.version}`);
    const safeName = pkg.name.replaceAll(/[^a-zA-Z0-9.-]/g, "-");
    const tarball = join(tmpdir(), `${safeName}-${pkg.manifest?.version}-${randomUUID()}.tgz`);
    try {
      await run("bun", ["pm", "pack", "--filename", tarball], resolve(root, pkg.directory));
      const packedManifestText = await run(
        "tar",
        ["-xOf", tarball, "package/package.json"],
        root,
        false,
      );
      const packedManifest = JSON.parse(packedManifestText) as PackageManifest;
      if (packedManifest.name !== pkg.name || packedManifest.version !== pkg.manifest?.version) {
        fail(`${pkg.name}: packed manifest identity changed unexpectedly`);
      }

      const internalNames = new Set(releasePackages.map((candidate) => candidate.name));
      const packedDependencies = {
        ...packedManifest.dependencies,
        ...packedManifest.optionalDependencies,
        ...packedManifest.peerDependencies,
      };
      for (const [dependency, version] of Object.entries(packedDependencies)) {
        if (!internalNames.has(dependency)) continue;
        if (version.startsWith("workspace:")) {
          fail(`${pkg.name}: packed dependency ${dependency} still uses ${version}`);
        }
      }

      const entries = await run("tar", ["-tzf", tarball], root, false);
      if (!entries.includes("package/package.json")) fail(`${pkg.name}: tarball has no manifest`);
      console.log(`verified ${entries.trim().split("\n").length} packed files`);
    } finally {
      await rm(tarball, { force: true });
    }
  }
}

async function smokePackedInstall(packages: ReleasePackage[]): Promise<void> {
  if (packages.length !== releasePackages.length) {
    fail("smoke mode installs the complete release graph and does not support --only or --from");
  }

  const smokeRoot = await mkdtemp(join(tmpdir(), "negotium-release-smoke-"));
  try {
    const dependencies: Record<string, string> = {};
    for (const pkg of packages) {
      const safeName = pkg.name.replaceAll(/[^a-zA-Z0-9.-]/g, "-");
      const tarball = join(smokeRoot, `${safeName}-${pkg.manifest?.version}.tgz`);
      await run("bun", ["pm", "pack", "--filename", tarball], resolve(root, pkg.directory), false);
      dependencies[pkg.name] = `file:${tarball}`;
    }

    await Bun.write(
      join(smokeRoot, "package.json"),
      `${JSON.stringify(
        { name: "negotium-release-smoke", private: true, dependencies, overrides: dependencies },
        null,
        2,
      )}\n`,
    );
    const installTmp = join(smokeRoot, "tmp");
    await mkdir(installTmp, { recursive: true });
    const smokeEnv = {
      ...process.env,
      NEGOTIUM_STATE_DIR: join(smokeRoot, "state"),
      TMPDIR: installTmp,
    };
    await run("bun", ["install"], smokeRoot, true, smokeEnv);

    const importTargets = packages
      .map((pkg) => pkg.name)
      .filter((name) => name !== "@negotium/cli" && name !== "negotium");
    await Bun.write(
      join(smokeRoot, "imports.ts"),
      `${importTargets.map((name) => `await import(${JSON.stringify(name)});`).join("\n")}
import { existsSync } from "node:fs";
const runtimeConfig = await import("@negotium/core/src/platform/config.ts");
for (const path of [
  runtimeConfig.FASTER_WHISPER_WRAPPER,
  runtimeConfig.PLAYWRIGHT_MCP_BIN,
  runtimeConfig.SESSION_COMM_SERVER,
  runtimeConfig.TASK_SERVER,
  runtimeConfig.META_DIR,
]) {
  if (!existsSync(path)) throw new Error(\`packed core runtime resource is missing: \${path}\`);
}
`,
    );
    await run("bun", ["imports.ts"], smokeRoot, true, smokeEnv);

    const bin = join(smokeRoot, "node_modules", ".bin", "negotium");
    const help = await run("bun", [bin, "--help"], smokeRoot, false, smokeEnv);
    if (!help.includes("usage: negotium")) fail("packed negotium binary did not render CLI help");
    console.log(`packed install smoke passed for ${packages.length} packages`);
  } finally {
    await rm(smokeRoot, { recursive: true, force: true });
  }
}

async function localPublish(packages: ReleasePackage[]): Promise<void> {
  if (!args.has("--confirm")) {
    fail("publishing changes npm permanently; rerun with --confirm after reviewing the dry-run");
  }
  await ensureCleanWorktree();

  for (const pkg of packages) {
    if (await isPublished(pkg)) {
      console.log(`skip ${pkg.name}@${pkg.manifest?.version}: already published`);
      continue;
    }
    console.log(`\n==> publish ${pkg.name}@${pkg.manifest?.version}`);
    await run("bun", ["publish", "--access", "public"], resolve(root, pkg.directory));
    await waitUntilPublished(pkg);
  }
}

async function ciPublish(packages: ReleasePackage[]): Promise<void> {
  if (process.env.GITHUB_ACTIONS !== "true") {
    fail("ci mode is reserved for the trusted-publishing GitHub Actions workflow");
  }
  await ensureCleanWorktree();

  for (const pkg of packages) {
    if (await isPublished(pkg)) {
      console.log(`skip ${pkg.name}@${pkg.manifest?.version}: already published`);
      continue;
    }

    const safeName = pkg.name.replaceAll(/[^a-zA-Z0-9.-]/g, "-");
    const tarball = join(tmpdir(), `${safeName}-${pkg.manifest?.version}-${randomUUID()}.tgz`);
    console.log(`\n==> trusted publish ${pkg.name}@${pkg.manifest?.version}`);
    try {
      await run("bun", ["pm", "pack", "--filename", tarball], resolve(root, pkg.directory));
      await run("npm", ["publish", tarball, "--access", "public", "--provenance"]);
      await waitUntilPublished(pkg);
    } finally {
      await rm(tarball, { force: true });
    }
  }
}

async function printStatus(packages: ReleasePackage[]): Promise<void> {
  for (const pkg of packages) {
    const published = await isPublished(pkg);
    console.log(`${published ? "published" : "available "} ${pkg.name}@${pkg.manifest?.version}`);
  }
}

if (!supportedModes.has(mode)) {
  fail(`usage: release-packages <${[...supportedModes].join("|")}> [--only=<name>|--from=<name>]`);
}

await loadAndValidatePackages();
const packages = selectedPackages();

switch (mode) {
  case "check":
    console.log(
      `release manifests valid: ${releasePackages.length} packages at ${releasePackages[0]?.manifest?.version}`,
    );
    break;
  case "dry-run":
    await dryRun(packages);
    break;
  case "smoke":
    await smokePackedInstall(packages);
    break;
  case "publish":
    await localPublish(packages);
    break;
  case "ci":
    await ciPublish(packages);
    break;
  case "status":
    await printStatus(packages);
    break;
}
