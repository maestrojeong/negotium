#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type ReleaseMode = "check" | "dry-run" | "smoke" | "publish" | "status";

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
  { name: "negotium", directory: "apps/negotium" },
];

const privatePackages: ReleasePackage[] = [
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
];

const mode = (process.argv[2] ?? "check") as ReleaseMode;
const args = new Set(process.argv.slice(3));
const supportedModes = new Set<ReleaseMode>(["check", "dry-run", "smoke", "publish", "status"]);

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

async function runInteractive(command: string, commandArgs: string[], cwd = root): Promise<void> {
  const child = Bun.spawn([command, ...commandArgs], {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    fail(`${command} ${commandArgs.join(" ")} exited with status ${exitCode}`);
  }
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
      if (privatePackages.some((candidate) => candidate.name === dependency)) {
        fail(`${pkg.name}: public release cannot depend on private workspace ${dependency}`);
      }
      const dependencyIndex = packageIndexes.get(dependency);
      if (dependencyIndex !== undefined && dependencyIndex >= index) {
        fail(`${pkg.name}: internal dependency ${dependency} must appear earlier in release order`);
      }
      if (
        dependencyIndex !== undefined &&
        productionDependencies[dependency] !== manifest.version
      ) {
        fail(
          `${pkg.name}: internal dependency ${dependency} must use the release version ${manifest.version}, found ${productionDependencies[dependency]}`,
        );
      }
    }
  }

  if (versions.size !== 1) {
    fail(`Negotium packages release in lockstep; found versions: ${[...versions].join(", ")}`);
  }

  const runtimeVersionSource = await Bun.file(resolve(root, "packages/core/src/version.ts")).text();
  const runtimeVersion = runtimeVersionSource.match(/NEGOTIUM_VERSION\s*=\s*"([^"]+)"/)?.[1];
  const releaseVersion = releasePackages[0]?.manifest?.version;
  if (runtimeVersion !== releaseVersion) {
    fail(
      `runtime version ${runtimeVersion ?? "<missing>"} does not match release ${releaseVersion}`,
    );
  }

  for (const pkg of privatePackages) {
    const manifestPath = resolve(root, pkg.directory, "package.json");
    const manifest = (await Bun.file(manifestPath).json()) as PackageManifest;
    if (manifest.name !== pkg.name) fail(`${pkg.directory}: unexpected package name`);
    if (!manifest.private) fail(`${pkg.name}: internal workspace package must be private`);
    if (manifest.publishConfig) fail(`${pkg.name}: private package must not have publishConfig`);
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
    const packRoot = await mkdtemp(join(tmpdir(), `negotium-npm-pack-${randomUUID()}-`));
    try {
      await run("npm", ["pack", "--pack-destination", packRoot], resolve(root, pkg.directory));
      const packedFiles = (await readdir(packRoot)).filter((entry) => entry.endsWith(".tgz"));
      if (packedFiles.length !== 1) {
        fail(`${pkg.name}: expected one npm tarball, found ${packedFiles.length}`);
      }
      const tarball = join(packRoot, packedFiles[0] ?? fail(`${pkg.name}: npm tarball missing`));
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

      const internalNames = new Set(
        [...releasePackages, ...privatePackages].map((candidate) => candidate.name),
      );
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
      await rm(packRoot, { recursive: true, force: true });
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
      const packRoot = join(smokeRoot, "packs", safeName);
      await mkdir(packRoot, { recursive: true });
      await run(
        "npm",
        ["pack", "--pack-destination", packRoot],
        resolve(root, pkg.directory),
        false,
      );
      const packedFiles = (await readdir(packRoot)).filter((entry) => entry.endsWith(".tgz"));
      if (packedFiles.length !== 1) {
        fail(`${pkg.name}: expected one npm tarball, found ${packedFiles.length}`);
      }
      const tarball = join(packRoot, packedFiles[0] ?? fail(`${pkg.name}: npm tarball missing`));
      dependencies[pkg.name] = `file:${tarball}`;
    }

    await Bun.write(
      join(smokeRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "negotium-release-smoke",
          private: true,
          dependencies,
          devDependencies: { "bun-types": "^1.3.11", typescript: "^5" },
          overrides: dependencies,
        },
        null,
        2,
      )}\n`,
    );
    const installTmp = join(smokeRoot, "tmp");
    await mkdir(installTmp, { recursive: true });
    const smokeEnv = {
      ...process.env,
      CODEX_HOME: join(smokeRoot, ".codex"),
      NEGOTIUM_STATE_DIR: join(smokeRoot, "state"),
      TMPDIR: installTmp,
    };
    await run("npm", ["install", "--ignore-scripts=false"], smokeRoot, true, smokeEnv);

    await Bun.write(
      join(smokeRoot, "imports.ts"),
      `import { join } from "node:path";
import { Database } from "bun:sqlite";
await import("@negotium/adapter-sdk");
await import("@negotium/adapter-sdk/outbox");
await import("@negotium/adapter-sdk/testkit");
import type {
  AgentExecutionHost,
  AgentQueryOptions,
  UnifiedEvent,
} from "negotium/hosted-agent";
import type { CanonicalMcpBridgeScope } from "negotium/canonical-mcp-bridge";
import type { CronDatabase, CronHost } from "negotium/cron";
import type { McpServerName } from "negotium/mcp-servers";
import type { AgentRegistry, WriteRolloutOptions } from "negotium/registry";
import type { ChatPair, CodexContextUsage } from "negotium/rollout";
import type { VaultStorageOptions } from "negotium/vault";
import type { SessionSystemPromptOpts } from "negotium/prompts";
import type { MermaidTheme } from "negotium/runtime-helpers";
import type { StorageHostOptions } from "negotium/storage";
const hostedAgent = await import("negotium/hosted-agent");
const canonicalBridge = await import("negotium/canonical-mcp-bridge");
const cron = await import("negotium/cron");
const mcpServers = await import("negotium/mcp-servers");
const registry = await import("negotium/registry");
const rollout = await import("negotium/rollout");
const vault = await import("negotium/vault");
const prompts = await import("negotium/prompts");
const runtimeHelpers = await import("negotium/runtime-helpers");
const storage = await import("negotium/storage");
if (typeof hostedAgent.configureAgentExecutionHost !== "function") {
  throw new Error("packed hosted-agent export is missing");
}
if (typeof hostedAgent.runHostedAgent !== "function") {
  throw new Error("packed hosted-agent runner is missing");
}
if (typeof canonicalBridge.registerCanonicalMcpBridgeEnvProvider !== "function") {
  throw new Error("packed canonical MCP bridge export is missing");
}
if (typeof canonicalBridge.canonicalMcpBridgeEnv !== "function") {
  throw new Error("packed canonical MCP bridge env helper is missing");
}
if (typeof canonicalBridge.revokeCanonicalMcpBridgeTurn !== "function") {
  throw new Error("packed canonical MCP bridge revoker is missing");
}
if (typeof cron.createCronModule !== "function") {
  throw new Error("packed cron export is missing");
}
if (typeof mcpServers.resolveMcpServerFile !== "function") {
  throw new Error("packed MCP server export is missing");
}
if (typeof mcpServers.resolveMcpServerTsconfig !== "function") {
  throw new Error("packed MCP server tsconfig helper is missing");
}
if (typeof registry.getRegistry !== "function" || typeof rollout.encodeClaudeCwd !== "function") {
  throw new Error("packed registry/rollout export is missing");
}
const rolloutRoot = join(process.cwd(), "rollout-smoke");
const restoreRolloutHost = rollout.configureRolloutHost({ workspaceRoots: [rolloutRoot] });
try {
  const encoded = registry.getRegistry("codex").writeRollout({ cwd: rolloutRoot, entries: [] });
  if (!encoded.rolloutPath.startsWith(process.env.CODEX_HOME ?? "")) {
    throw new Error("packed registry/rollout did not use the configured rollout host");
  }
} finally {
  restoreRolloutHost();
}
if (typeof vault.configureVaultStorage !== "function" || typeof prompts.buildTopicSystemPrompt !== "function") {
  throw new Error("packed vault/prompts export is missing");
}
if (typeof runtimeHelpers.buildMermaidHtml !== "function" || typeof runtimeHelpers.renderTaskPanel !== "function") {
  throw new Error("packed runtime helper export is missing");
}
if (
  typeof storage.configureStorageHost !== "function" ||
  typeof storage.getTopic !== "function" ||
  typeof storage.forum?.getTopicByName !== "function" ||
  typeof storage.sessionAsks?.createPendingAsk !== "function"
) {
  throw new Error("packed storage facade export is missing");
}
const storageDatabase = new Database(":memory:");
const storageHost: StorageHostOptions = {
  database: storageDatabase,
  dataDir: join(process.cwd(), "storage-data"),
  logDir: join(process.cwd(), "storage-logs"),
  sessionAsksDir: join(process.cwd(), "storage-asks"),
  workspaceDir: join(process.cwd(), "storage-workspace"),
};
const restoreStorageHost = storage.configureStorageHost(storageHost);
try {
  storage.listTopics();
  const table = storageDatabase
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='api_topics'")
    .get() as { name?: string } | null;
  if (table?.name !== "api_topics") throw new Error("packed storage schema was not initialized");
  storage.flushSessionCache();
  storageDatabase.query("SELECT 1").get();
} finally {
  restoreStorageHost();
  storageDatabase.close();
}
const publicTypes = {} as {
  host: Partial<AgentExecutionHost>;
  options: AgentQueryOptions;
  event: UnifiedEvent;
  bridgeScope: CanonicalMcpBridgeScope;
  cronDatabase: CronDatabase;
  cronHost: Partial<CronHost>;
  mcpServerName: McpServerName;
  registry: AgentRegistry;
  rolloutOptions: WriteRolloutOptions;
  chatPair: ChatPair;
  codexUsage: CodexContextUsage;
  vaultOptions: VaultStorageOptions;
  promptOptions: SessionSystemPromptOpts;
  mermaidTheme: MermaidTheme;
  storageHost: StorageHostOptions;
};
void publicTypes;

// The two public subpaths must share the same canonical bridge module state.
// Independently bundling them makes registration succeed here while hosted
// execution sees a different, empty registry and cannot revoke its leases.
const bridgeScope: CanonicalMcpBridgeScope = {
  surface: "task",
  userId: "smoke-user",
  topicId: "smoke-topic",
  queryId: "smoke-query",
  peerBridge: {
    hubCellId: "smoke-hub",
    hostTopicId: "smoke-host-topic",
    hostQueryId: "smoke-host-query",
    canSpawnSubagents: false,
  },
};
let revokedBridgeLeases = 0;
const disposeBridge = canonicalBridge.registerCanonicalMcpBridgeEnvProvider(() => ({
  env: { NEGOTIUM_RELEASE_SMOKE_BRIDGE: "1" },
  revoke: () => {
    revokedBridgeLeases += 1;
  },
}));
const issuedEnv = canonicalBridge.canonicalMcpBridgeEnv(bridgeScope);
if (issuedEnv?.NEGOTIUM_RELEASE_SMOKE_BRIDGE !== "1") {
  throw new Error("packed canonical MCP bridge provider was not invoked");
}
const disposeHost = hostedAgent.configureAgentExecutionHost({
  claudeCodeExecutablePath: () => "/definitely/missing/negotium-release-smoke-claude",
});
try {
  for await (const _event of hostedAgent.runHostedAgent({
    agent: "claude",
    prompt: "release smoke",
    cwd: process.cwd(),
    systemPrompt: "release smoke",
    userId: bridgeScope.userId,
    topicId: bridgeScope.topicId,
    queryId: bridgeScope.queryId,
    peerBridge: bridgeScope.peerBridge,
  })) {
    // The deliberately missing executable makes this path deterministic and
    // avoids contacting a provider; runHostedAgent's finally still revokes.
  }
} finally {
  disposeHost();
  disposeBridge();
}
if (revokedBridgeLeases !== 1) {
  throw new Error("packed hosted-agent and canonical MCP bridge do not share lease state");
}
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const packageRoot = resolve("node_modules/negotium");
for (const path of [
  resolve(packageRoot, "dist/runtime/scripts/faster-whisper-wrapper.py"),
  resolve(packageRoot, "dist/runtime/scripts/mcp-patchright-http.mjs"),
  resolve(packageRoot, "dist/runtime/src/mcp/session-comm/server.ts"),
  resolve(packageRoot, "dist/runtime/src/mcp/task-server.ts"),
  resolve(packageRoot, "dist/runtime/src/prompts/agents/wiki-archiver.md"),
  resolve(packageRoot, "dist/runtime/cron/mcp-server.ts"),
]) {
  if (!existsSync(path)) throw new Error(\`packed runtime resource is missing: \${path}\`);
}
for (const name of mcpServers.MCP_SERVER_NAMES) {
  const path = mcpServers.resolveMcpServerFile(name);
  if (!existsSync(path)) throw new Error(\`packed MCP server is missing: \${name} at \${path}\`);
}
const packedManifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
for (const subpath of [
  "./hosted-agent",
  "./canonical-mcp-bridge",
  "./cron",
  "./mcp-servers",
  "./registry",
  "./rollout",
  "./vault",
  "./prompts",
  "./runtime-helpers",
  "./storage",
]) {
  const types = packedManifest.exports?.[subpath]?.types;
  if (typeof types !== "string" || !types.endsWith(".d.ts")) {
    throw new Error(\`packed \${subpath} types must resolve to .d.ts, got \${String(types)}\`);
  }
}
`,
    );
    await run(
      "npx",
      [
        "tsc",
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--moduleResolution",
        "bundler",
        "--module",
        "esnext",
        "--target",
        "es2022",
        "--types",
        "bun-types",
        "imports.ts",
      ],
      smokeRoot,
      true,
      smokeEnv,
    );
    await run("bun", ["imports.ts"], smokeRoot, true, smokeEnv);

    const bin = join(smokeRoot, "node_modules", ".bin", "negotium");
    const help = await run("bun", [bin, "--help"], smokeRoot, false, smokeEnv);
    if (!help.includes("usage: negotium")) fail("packed negotium binary did not render CLI help");
    const otiumHelp = await run("bun", [bin, "otium", "--help"], smokeRoot, false, smokeEnv);
    if (!otiumHelp.includes("usage: negotium otium")) {
      fail("packed negotium binary did not load the Otium adapter CLI");
    }
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
    await runInteractive("npm", ["publish", "--access", "public"], resolve(root, pkg.directory));
    await waitUntilPublished(pkg);
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
  case "status":
    await printStatus(packages);
    break;
}
