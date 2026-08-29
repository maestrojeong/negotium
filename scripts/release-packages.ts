#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

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
  exports?: Record<
    string,
    {
      types?: string;
      import?: string;
      default?: string;
    }
  >;
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

const npmInvocation = Bun.which("npm")
  ? [Bun.which("npm") as string]
  : [process.execPath, "x", "npm@10"];

function runNpm(
  commandArgs: string[],
  cwd = root,
  printOutput = true,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const [command, ...prefix] = npmInvocation;
  return run(command ?? process.execPath, [...prefix, ...commandArgs], cwd, printOutput, env);
}

function runNpmInteractive(commandArgs: string[], cwd = root): Promise<void> {
  const [command, ...prefix] = npmInvocation;
  return runInteractive(command ?? process.execPath, [...prefix, ...commandArgs], cwd);
}

const nodeInvocation = Bun.which("node")
  ? [Bun.which("node") as string]
  : [process.execPath, "x", "node@22.13.0"];

function runNode(
  commandArgs: string[],
  cwd = root,
  printOutput = true,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const [command, ...prefix] = nodeInvocation;
  return run(command ?? process.execPath, [...prefix, ...commandArgs], cwd, printOutput, env);
}

function runTsc(
  commandArgs: string[],
  cwd = root,
  printOutput = true,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  return run(process.execPath, ["x", "tsc", ...commandArgs], cwd, printOutput, env);
}

function unusedLoopbackPort(): number {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("port reservation"),
  });
  const port = server.port;
  server.stop(true);
  if (!port) fail("could not reserve a loopback port for the packed startup smoke");
  return port;
}

function captureStream(stream: ReadableStream<Uint8Array>): {
  text: () => string;
  done: Promise<void>;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const done = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      output += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  })();
  return { text: () => output, done };
}

async function assertPackedServerStarts(
  bin: string,
  args: string[],
  healthPath: string,
  listeningLabel: string,
  cwd: string,
  env: Record<string, string | undefined>,
  validateBody?: (body: Record<string, unknown>) => boolean,
): Promise<void> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const port = unusedLoopbackPort();
    const child = Bun.spawn([bin, ...args, `--port=${port}`], {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = captureStream(child.stdout);
    const stderr = captureStream(child.stderr);
    const listeningMarker = `${listeningLabel} on 127.0.0.1:${port}`;
    let healthy = false;
    let timedOut = false;
    const deadline = Date.now() + 15_000;

    try {
      while (Date.now() < deadline && child.exitCode === null) {
        if (stdout.text().includes(listeningMarker)) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}${healthPath}`, {
              headers: env.NEGOTIUM_CONTROL_TOKEN
                ? { authorization: `Bearer ${env.NEGOTIUM_CONTROL_TOKEN}` }
                : undefined,
              signal: AbortSignal.timeout(500),
            });
            const body = (await response.json()) as Record<string, unknown>;
            const pidMatches = healthPath !== "/health" || body.pid === child.pid;
            if (
              response.ok &&
              body.ok === true &&
              pidMatches &&
              (!validateBody || validateBody(body))
            ) {
              healthy = true;
              break;
            }
          } catch {
            // The packed server printed its listener before the health route became ready.
          }
        }
        await Bun.sleep(100);
      }
      timedOut = !healthy && child.exitCode === null;
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      const exited = await Promise.race([
        child.exited.then(() => true),
        Bun.sleep(2_000).then(() => false),
      ]);
      if (!exited) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await Promise.all([stdout.done, stderr.done]);
    }

    if (healthy) return;
    lastFailure =
      `packed negotium ${args.join(" ")} did not become ready at ` +
      `http://127.0.0.1:${port}${healthPath} (attempt ${attempt}, ` +
      `${timedOut ? "timed out" : `status ${child.exitCode}`})\n` +
      `stdout:\n${stdout.text()}\nstderr:\n${stderr.text()}`;
    if (timedOut) break;
  }
  fail(lastFailure);
}

async function withPackedNodeDaemon(
  bin: string,
  cwd: string,
  env: Record<string, string | undefined>,
  action: () => Promise<void>,
): Promise<void> {
  const stateDir = env.NEGOTIUM_STATE_DIR;
  if (!stateDir) fail("packed node daemon smoke requires NEGOTIUM_STATE_DIR");
  const infoPath = join(stateDir, "runtime", "node-daemon.json");
  const child = Bun.spawn([bin, "__node-daemon", "--port=0"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = captureStream(child.stdout);
  const stderr = captureStream(child.stderr);
  let failure: unknown;

  try {
    let ready = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && child.exitCode === null) {
      if (await Bun.file(infoPath).exists()) {
        const info = (await Bun.file(infoPath).json()) as {
          pid?: unknown;
          port?: unknown;
          stateDir?: unknown;
        };
        if (
          info.pid === child.pid &&
          Number.isInteger(info.port) &&
          (info.port as number) > 0 &&
          info.stateDir === stateDir
        ) {
          try {
            const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
              signal: AbortSignal.timeout(500),
            });
            const body = (await response.json()) as {
              ok?: boolean;
              pid?: number;
              stateDir?: string;
            };
            if (
              response.ok &&
              body.ok === true &&
              body.pid === child.pid &&
              body.stateDir === stateDir
            ) {
              ready = true;
              break;
            }
          } catch {
            // The daemon state was published before its health route became ready.
          }
        }
      }
      await Bun.sleep(100);
    }
    if (!ready) {
      throw new Error(
        child.exitCode === null
          ? "packed managed node daemon did not become ready"
          : `packed managed node daemon exited with status ${child.exitCode}`,
      );
    }
    await action();
  } catch (error) {
    failure = error;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(8_000).then(() => false),
    ]);
    if (!exited) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await Promise.all([stdout.done, stderr.done]);
  }

  if (failure !== undefined) {
    const message = failure instanceof Error ? failure.message : String(failure);
    fail(
      `${message}\nmanaged daemon stdout:\n${stdout.text()}\nmanaged daemon stderr:\n${stderr.text()}`,
    );
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
  const response = await fetch(url, {
    headers: { accept: "application/json" },
  });
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
      await runNpm(["pack", "--pack-destination", packRoot], resolve(root, pkg.directory));
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

function isTypeOnlyExport(symbol: ts.Symbol): boolean {
  const declarations = symbol.getDeclarations();
  return Boolean(
    declarations?.length &&
      declarations.every((declaration) => {
        if (ts.isExportSpecifier(declaration)) {
          return declaration.isTypeOnly || declaration.parent.parent.isTypeOnly;
        }
        if (ts.isExportDeclaration(declaration)) return declaration.isTypeOnly;
        return false;
      }),
  );
}

async function assertPackedExportParity(
  smokeRoot: string,
  packages: ReleasePackage[],
): Promise<void> {
  const publicEntries: Array<{
    packageName: string;
    packageRoot: string;
    runtimePath: string;
    subpath: string;
    typePath: string;
  }> = [];
  for (const pkg of packages) {
    const packageRoot = join(smokeRoot, "node_modules", ...pkg.name.split("/"));
    const manifest = (await Bun.file(join(packageRoot, "package.json")).json()) as PackageManifest;
    for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
      const runtimePath = entry.import ?? entry.default;
      if (!entry.types || !runtimePath) continue;
      publicEntries.push({
        packageName: pkg.name,
        packageRoot,
        runtimePath,
        subpath,
        typePath: entry.types,
      });
    }
  }
  const typeFiles = publicEntries.map((entry) => resolve(entry.packageRoot, entry.typePath));
  const program = ts.createProgram(typeFiles, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const failures: string[] = [];

  for (const entry of publicEntries) {
    const typeFile = resolve(entry.packageRoot, entry.typePath);
    const sourceFile = program.getSourceFile(typeFile);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) {
      failures.push(
        `${entry.packageName}${entry.subpath}: could not inspect declarations at ${entry.typePath}`,
      );
      continue;
    }

    const declaredValues = checker
      .getExportsOfModule(moduleSymbol)
      .filter((symbol) => !isTypeOnlyExport(symbol))
      .filter((symbol) => {
        const target =
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        return Boolean(target.flags & ts.SymbolFlags.Value);
      })
      .map((symbol) => symbol.getName())
      .filter((name) => name !== "default")
      .sort();
    const runtimeModule = (await import(
      pathToFileURL(resolve(entry.packageRoot, entry.runtimePath)).href
    )) as Record<string, unknown>;
    const runtimeValues = new Set(Object.keys(runtimeModule));
    const missing = declaredValues.filter((name) => !runtimeValues.has(name));
    if (missing.length > 0)
      failures.push(
        `${entry.packageName}${entry.subpath}: missing runtime exports ${missing.join(", ")}`,
      );
  }

  if (failures.length > 0) {
    fail(
      `packed declaration/runtime export mismatch:\n${failures.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  console.log(`verified declaration/runtime parity for ${publicEntries.length} public subpaths`);
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
      await runNpm(["pack", "--pack-destination", packRoot], resolve(root, pkg.directory), false);
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
          devDependencies: {
            "@types/node": "^20",
            "bun-types": "^1.3.11",
            typescript: "^5",
          },
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
      NEGOTIUM_CRON: "0",
      NEGOTIUM_CONTROL_TOKEN: "release-smoke-control-token",
      NEGOTIUM_STATE_DIR: join(smokeRoot, "state"),
      // The smoke daemon is a *second* node, isolated from the developer's own.
      // It is spawned with `--port=0` to mean "ask the kernel for a free port",
      // but `NEGOTIUM_NODE_PORT` is read precisely when the requested port is 0
      // and silently wins over ephemeral allocation. Inheriting it therefore
      // aims the throwaway daemon at the workstation's real port, and the smoke
      // test fails with EADDRINUSE against the live node -- a failure about the
      // developer's machine, reported as if the tarball were broken. State is
      // already isolated above; the port is part of the same isolation.
      NEGOTIUM_NODE_PORT: undefined,
      TMPDIR: installTmp,
    };
    await runNpm(["install", "--ignore-scripts=false"], smokeRoot, true, smokeEnv);
    await assertPackedExportParity(smokeRoot, packages);

    await Bun.write(
      join(smokeRoot, "cron-mcp-smoke.ts"),
      `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const client = new Client({ name: "packed-cron-smoke", version: "1.0.0" });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
);
env.NEGOTIUM_STATE_DIR = resolve("cron-smoke-state");
env.TSX_TSCONFIG_PATH = resolve("node_modules/negotium/dist/runtime/tsconfig.json");
const tsxLoader = createRequire(resolve("node_modules/negotium/package.json")).resolve("tsx");
const transport = new StdioClientTransport({
  command: "node",
  args: [
    "--import",
    tsxLoader,
    resolve("node_modules/negotium/dist/runtime/cron/mcp-server.ts"),
    "--user-id=local",
  ],
  env,
  stderr: "pipe",
});

await client.connect(transport);
try {
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  if (!names.includes("cron_list") || !names.includes("cron_create")) {
    throw new Error("packed cron MCP contract is incomplete");
  }
} finally {
  await client.close();
}
`,
    );
    await run("bun", ["cron-mcp-smoke.ts"], smokeRoot, true, smokeEnv);

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
import type { ForumMcpClassification, RuntimeMcpPolicyEntry } from "negotium/mcp-catalog";
import type {
  ActiveTopicArchiveOptions,
  AgentAuthHost,
  AgentForkHost,
  ArchiverHost,
  AskUserRuntimeHost,
  CodexTreeHost,
  CodexProcStamp,
  ForkHandle,
  SelfConfigHost,
  SelfConfigRuntimeOptions,
  SubagentLifecycleHost,
  SubagentLifecycleLimits,
  TopicConversationEntry,
  TopicLogMaintenanceHost,
  TaskEventHost,
  ToolCallSummaryInput,
} from "negotium/agent-helpers";
import type { BackgroundBashManager, BackgroundBashManagerOptions } from "negotium/background-bash";
import type {
  PlaywrightManagerHost,
  PlaywrightProfileBinding,
} from "negotium/browser-runtime";
import type {
  OutboxFileHost,
  OutboxFileOps,
  OutboxWatchOps,
} from "negotium/outbox";
import type { RuntimeEnvironment, StdioLogger } from "negotium/platform-runtime";
import type {
  QueryStateStoreOptions,
  RoomQueryRegistryHost,
} from "negotium/query-runtime";
import type {
  TaskMcpContext,
  TaskMcpHost,
  SystemHealthMcpHost,
  SystemHealthSnapshot,
  SessionCommContext,
  SessionCommMcpHost,
  SessionTargetCatalogHost,
  TokenStatsMcpContext,
  TokenStatsMcpHost,
  VaultMcpContext,
  VaultMcpHost,
  WikiMcpContext,
  WikiMcpHost,
} from "negotium/mcp-factories";
import type {
  AgentRegistry,
  AgentRegistryOperations,
  WriteRolloutOptions,
} from "negotium/registry";
import type { ChatPair, CodexContextUsage } from "negotium/rollout";
import type { VaultStorageOptions } from "negotium/vault";
import type {
  PromptBuilderHost,
  PromptSectionContext,
  SessionSystemPromptOpts,
} from "negotium/prompts";
import type {
  AgentKind,
  BashrsCompletion,
  BashrsCompletionSink,
  ContextOccupancy,
  ContextWarningState,
  LifecycleManager,
  LifecycleProcessHost,
  McpContent,
  McpErrorResponse,
  McpResponse,
  McpToolResult,
  MermaidTheme,
  SharedMcpTool,
} from "negotium/runtime-helpers";
import type {
  StorageDatabase,
  StorageDatabaseInput,
  StorageHostConfig,
  StorageHostOptions,
} from "negotium/storage";
const hostedAgent = await import("negotium/hosted-agent");
const canonicalBridge = await import("negotium/canonical-mcp-bridge");
const cron = await import("negotium/cron");
const mcpServers = await import("negotium/mcp-servers");
const mcpCatalog = await import("negotium/mcp-catalog");
const mcpFactories = await import("negotium/mcp-factories");
const agentHelpers = await import("negotium/agent-helpers");
const backgroundBash = await import("negotium/background-bash");
const browserRuntime = await import("negotium/browser-runtime");
const outbox = await import("negotium/outbox");
const platformRuntime = await import("negotium/platform-runtime");
const queryRuntime = await import("negotium/query-runtime");
const registry = await import("negotium/registry");
const rollout = await import("negotium/rollout");
const vault = await import("negotium/vault");
const prompts = await import("negotium/prompts");
const runtimeHelpers = await import("negotium/runtime-helpers");
const runtimeGateway = await import("negotium/runtime-gateway");
const storage = await import("negotium/storage");
const sqlite = await import("negotium/sqlite");
if (typeof hostedAgent.configureAgentExecutionHost !== "function") {
  throw new Error("packed hosted-agent export is missing");
}
if (typeof runtimeGateway.RuntimeGatewayClient !== "function") {
  throw new Error("packed runtime-gateway client export is missing");
}
if (typeof runtimeGateway.RuntimeGatewayClient.prototype.deleteMessage !== "function") {
  throw new Error("packed runtime-gateway message delete client is missing");
}
if (typeof browserRuntime.configurePlaywrightManagerHost !== "function") {
  throw new Error("packed browser runtime host configurator is missing");
}
if (typeof browserRuntime.buildPlaywrightMcpTransport !== "function") {
  throw new Error("packed browser runtime MCP transport builder is missing");
}
if (typeof browserRuntime.stopPlaywrightProfile !== "function") {
  throw new Error("packed browser runtime profile stop is missing");
}
if (typeof browserRuntime.reapPlaywrightOrphans !== "function") {
  throw new Error("packed browser runtime orphan sweep is missing");
}
if (typeof queryRuntime.createQueryStateStore !== "function") {
  throw new Error("packed query-state factory is missing");
}
if (typeof agentHelpers.formatToolUse !== "function") {
  throw new Error("packed tool-format helper is missing");
}
if (typeof runtimeHelpers.setBashrsCompletionSink !== "function") {
  throw new Error("packed bash-rs completion sink configurator is missing");
}
if (typeof runtimeHelpers.startBashrsCompletionsWorker !== "function") {
  throw new Error("packed bash-rs completion worker is missing");
}
if (
  typeof agentHelpers.defaultAskUserDurabilityHost !== "object" ||
  typeof agentHelpers.defaultAskUserDurabilityHost?.gates?.prepare !== "function" ||
  typeof agentHelpers.defaultAskUserDurabilityHost?.processLeases?.acquire !== "function"
) {
  throw new Error("packed default ask-user durability host is missing");
}
if (typeof agentHelpers.createTopicLogMaintenance !== "function") {
  throw new Error("packed topic-log maintenance factory is missing");
}
if (typeof agentHelpers.createAskUserRuntime !== "function") {
  throw new Error("packed ask-user runtime factory is missing");
}
if (typeof agentHelpers.createArchiverRuntime !== "function") {
  throw new Error("packed archiver runtime factory is missing");
}
if (typeof agentHelpers.createSelfConfigRuntime !== "function") {
  throw new Error("packed self-config runtime factory is missing");
}
if (typeof agentHelpers.createSubagentLifecycle !== "function") {
  throw new Error("packed subagent lifecycle factory is missing");
}
if (typeof mcpFactories.createSessionTargetCatalog !== "function") {
  throw new Error("packed session-target catalog factory is missing");
}
if (typeof prompts.createPromptBuilders !== "function") {
  throw new Error("packed prompt-builder factory is missing");
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
if (typeof mcpCatalog.classifyForumMcpServers !== "function") {
  throw new Error("packed MCP catalog policy export is missing");
}
if (!mcpCatalog.COMMON_RUNTIME_MCP_POLICY.playwright?.forumRequired) {
  throw new Error("packed MCP catalog policy is incomplete");
}
if (typeof mcpFactories.createTaskMcpServer !== "function") {
  throw new Error("packed MCP factory export is missing");
}
if (typeof agentHelpers.forkAgentSession !== "function") {
  throw new Error("packed fork helper export is missing");
}
const archiveOptions: ActiveTopicArchiveOptions = { reason: "reset", minMessages: 1 };
if (
  typeof agentHelpers.archiveActiveTopicForMemory !== "function" ||
  agentHelpers.MIN_MEMORY_ARCHIVE_EXCHANGES !== 6 ||
  agentHelpers.showPngTool.name !== "show_png" ||
  !agentHelpers.otiumVisualToolDefinitions.includes(agentHelpers.showPngTool) ||
  archiveOptions.reason !== "reset"
) {
  throw new Error("packed active-topic memory/visual helper export is missing");
}
const forkHost = null as AgentForkHost | null;
const treeHost = null as CodexTreeHost | null;
if (forkHost || treeHost) throw new Error("unreachable host smoke");
const codexStamp: CodexProcStamp = { pid: 1, lstart: "smoke" };
if (typeof agentHelpers.killCodexTrees !== "function" || codexStamp.pid !== 1) {
  throw new Error("packed codex process helper export is missing");
}
if (typeof backgroundBash.createBackgroundBashManager !== "function") {
  throw new Error("packed background-bash manager export is missing");
}
const backgroundBashOptions: BackgroundBashManagerOptions = { capability: "a".repeat(64) };
const backgroundBashManager: BackgroundBashManager =
  backgroundBash.createBackgroundBashManager(backgroundBashOptions);
if (backgroundBashManager.contextCapability("smoke", "topic").length !== 64) {
  throw new Error("packed background-bash manager capability is invalid");
}
const outboxHost: OutboxFileHost = {
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  readJsonlLines: () => [],
};
const outboxOps: OutboxFileOps = outbox.createOutboxFileOps(outboxHost);
if (outboxOps.parseOutboxLine<{ ok: boolean }>('{"ok":true}', "smoke")?.ok !== true) {
  throw new Error("packed outbox factory export is invalid");
}
const outboxWatchOps: OutboxWatchOps = outbox.createOutboxWatchOps({
  logger: { error() {}, warn() {} },
});
if (typeof outboxWatchOps.debouncedFlush !== "function") {
  throw new Error("packed outbox watcher factory export is invalid");
}
const runtimeEnvironment: RuntimeEnvironment = { NEGOTIUM_STATE_DIR: "/tmp/state" };
const stdioLogger: StdioLogger = platformRuntime.createStdioLogger({ development: false });
if (
  platformRuntime.parseRuntimePort("1234", 80) !== 1234 ||
  platformRuntime.readEnvText(runtimeEnvironment, "NEGOTIUM_STATE_DIR") !== "/tmp/state" ||
  !stdioLogger
) {
  throw new Error("packed platform runtime export is invalid");
}
if (typeof sqlite.Database !== "function") {
  throw new Error("packed sqlite export is invalid");
}
const queryHost: RoomQueryRegistryHost<
  { topicId: string; queryId: string; ownerId: string },
  "internal" | "external"
> = {
  instanceId: "smoke",
  internalAbortReason: "internal",
  externalAbortReason: "external",
  listLeases: () => [],
  getLease: () => null,
  claimLease: () => true,
  heartbeatLease: () => ({ owned: true, abortRequested: false }),
  releaseLease: () => {},
  requestAbort: () => false,
};
if (typeof queryRuntime.createRoomQueryRegistry !== "function" || !queryHost.instanceId) {
  throw new Error("packed query-runtime factory export is invalid");
}
const runtimeAgent: AgentKind = "codex";
if (
  runtimeAgent !== "codex" ||
  typeof runtimeHelpers.connectStdio !== "function" ||
  !runtimeHelpers.EFFORT_VALUES.includes("xhigh")
) {
  throw new Error("packed shared query/runtime type exports are invalid");
}
const lifecycleProcess: LifecycleProcessHost = {
  once() {},
  removeListener() {},
  exit(): never { throw new Error("unexpected lifecycle exit"); },
};
const lifecycle: LifecycleManager = runtimeHelpers.createLifecycleManager({
  logger: { info() {}, warn() {}, error() {} },
  process: lifecycleProcess,
});
if (lifecycle.handlerCount() !== 0) {
  throw new Error("packed lifecycle manager export is invalid");
}
if (typeof mcpFactories.createTokenStatsMcpServer !== "function") {
  throw new Error("packed token-stats MCP factory export is missing");
}
if (typeof mcpFactories.createSystemHealthMcpServer !== "function") {
  throw new Error("packed system-health MCP factory export is missing");
}
if (typeof mcpFactories.createVaultMcpServer !== "function") {
  throw new Error("packed vault MCP factory export is missing");
}
if (typeof mcpFactories.protectMcpStdio !== "function") {
  throw new Error("packed MCP stdio protection export is missing");
}
if (typeof mcpFactories.createWikiMcpServer !== "function") {
  throw new Error("packed wiki MCP factory export is missing");
}
if (typeof mcpFactories.createSessionCommMcpServer !== "function") {
  throw new Error("packed session-comm MCP factory export is missing");
}
const packedTaskServer = mcpFactories.createTaskMcpServer({
  userId: "smoke-user",
  topic: "smoke-topic",
});
await packedTaskServer.close();
const packedVaultServer = mcpFactories.createVaultMcpServer(
  { userId: "smoke-user" },
  { list: () => [] },
);
await packedVaultServer.close();
const packedWikiContext: WikiMcpContext = { userId: "smoke-user", surface: "wiki" };
const packedWikiHost: WikiMcpHost = { wikiRoot: join(process.cwd(), "wiki-smoke") };
await mcpFactories.createWikiMcpServer(packedWikiContext, packedWikiHost).close();
const packedSessionContext: SessionCommContext = {
  userId: "smoke-user",
  currentTopic: "smoke-topic",
  depth: 0,
  replyOnly: true,
  agent: "codex",
};
const packedSessionHost = new Proxy({}, {
  get: () => () => ({ content: [{ type: "text", text: "ok" }] }),
}) as SessionCommMcpHost;
await mcpFactories.createSessionCommMcpServer(packedSessionContext, packedSessionHost).close();
if (typeof agentHelpers.checkAgentAuth !== "function") {
  throw new Error("packed agent auth helper export is missing");
}
if (typeof agentHelpers.resolveTaskEventScope !== "function") {
  throw new Error("packed task event helper export is missing");
}
if (
  typeof registry.getRegistry !== "function" ||
  typeof registry.getRegistryOperations !== "function" ||
  typeof rollout.writeCodexRollout !== "function" ||
  typeof rollout.encodeClaudeCwd !== "function"
) {
  throw new Error("packed registry/rollout export is missing");
}
const packedRegistryOperations: AgentRegistryOperations = registry.getRegistryOperations("codex");
if (
  typeof packedRegistryOperations.writeRollout !== "function" ||
  typeof packedRegistryOperations.forkSession !== "function" ||
  typeof packedRegistryOperations.cleanupRollouts !== "function"
) {
  throw new Error("packed registry operations export is incomplete");
}
const rolloutRoot = join(process.cwd(), "rollout-smoke");
const restoreRolloutHost = rollout.configureRolloutHost({ workspaceRoots: [rolloutRoot] });
try {
  const encoded = rollout.writeCodexRollout({ cwd: rolloutRoot, pairs: [] });
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
for (const helper of [
  "deepMapStrings",
  "delay",
  "errorResult",
  "errMsg",
  "isSensitivePath",
  "mcpError",
  "mcpOk",
  "parseJsonlText",
  "parseUserIdArg",
  "readJsonFile",
  "readJsonlLines",
  "sanitizeFileName",
  "sanitizeId",
  "sanitizeTopicName",
  "textResult",
  "topicAppLink",
  "topicMarkdownLink",
  "writeJsonFileAtomic",
  "writeJsonlFile",
] as const) {
  if (typeof runtimeHelpers[helper] !== "function") {
    throw new Error("packed runtime helper export is missing: " + helper);
  }
}
const warningState = runtimeHelpers.createContextWarningState();
const warning = runtimeHelpers.nextContextWarning(warningState, {
  key: "smoke:topic",
  topicTitle: "smoke",
  usage: { contextTokens: 80, contextWindow: 100 },
  supportsCompact: false,
});
if (!warning?.includes("80%") || warning.includes("/compact")) {
  throw new Error("packed context warning policy is missing or ignored consumer capabilities");
}
if (
  runtimeHelpers.claudeRequestContextTokens({
    input_tokens: 10,
    cache_read_input_tokens: 20,
    output_tokens: 5,
  }) !== 35
) {
  throw new Error("packed Claude context helper returned the wrong latest-request usage");
}
if (
  runtimeHelpers.errMsg(new Error("smoke")) !== "smoke" ||
  runtimeHelpers.sanitizeId("a.b") !== "a_b" ||
  runtimeHelpers.parseUserIdArg(["--user-id=user_1"]) !== "user_1" ||
  runtimeHelpers.topicAppLink("a/b") !== "otium://topic/a%2Fb" ||
  runtimeHelpers.textResult("ok").content[0]?.text !== "ok"
) {
  throw new Error("packed shared runtime helper behavior is missing");
}
if (
  typeof storage.configureStorageHost !== "function" ||
  typeof storage.resetStorageHost !== "function" ||
  typeof storage.getTopic !== "function" ||
  typeof storage.forum?.getTopicByName !== "function" ||
  typeof storage.sessionAsks?.createPendingAsk !== "function"
) {
  throw new Error("packed storage facade export is missing");
}
const storageDatabase = new Database(":memory:");
const structuralDatabase: StorageDatabaseInput = storageDatabase;
const storageHost: StorageHostConfig = {
  database: structuralDatabase,
  dataDir: join(process.cwd(), "storage-data"),
  logDir: join(process.cwd(), "storage-logs"),
  sessionAsksDir: join(process.cwd(), "storage-asks"),
  workspaceDir: join(process.cwd(), "storage-workspace"),
  sharedWikiDir: join(process.cwd(), "storage-shared-wiki"),
  usersLogDir: join(process.cwd(), "storage-user-logs"),
};
const restoreStorageHost = storage.configureStorageHost(storageHost);
try {
  storage.listTopics();
  const table = storageDatabase
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='api_topics'")
    .get() as { name?: string } | null;
  if (table?.name !== "api_topics") throw new Error("packed storage schema was not initialized");
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
  mcpCatalogViews: ForumMcpClassification;
  publicMcpCatalogEntry: RuntimeMcpPolicyEntry;
  agentAuthHost: AgentAuthHost;
  forkHandle: ForkHandle;
  taskEventHost: TaskEventHost;
  taskMcpContext: TaskMcpContext;
  taskMcpHost: TaskMcpHost;
  systemHealthMcpHost: SystemHealthMcpHost;
  systemHealthSnapshot: SystemHealthSnapshot;
  tokenStatsMcpContext: TokenStatsMcpContext;
  tokenStatsMcpHost: TokenStatsMcpHost;
  vaultMcpHost: VaultMcpHost;
  vaultMcpContext: VaultMcpContext;
  registry: AgentRegistry;
  rolloutOptions: WriteRolloutOptions;
  chatPair: ChatPair;
  codexUsage: CodexContextUsage;
  vaultOptions: VaultStorageOptions;
  promptOptions: SessionSystemPromptOpts;
  mermaidTheme: MermaidTheme;
  contextOccupancy: ContextOccupancy;
  contextWarningState: ContextWarningState;
  mcpContent: McpContent;
  mcpErrorResponse: McpErrorResponse;
  mcpResponse: McpResponse;
  mcpToolResult: McpToolResult;
  sharedMcpTool: SharedMcpTool;
  storageHost: StorageHostOptions;
  storageConfig: StorageHostConfig;
  storageDatabase: StorageDatabase;
  storageDatabaseInput: StorageDatabaseInput;
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
try {
  try {
    for await (const _event of hostedAgent.runHostedAgent({
      agent: "release-smoke-invalid" as AgentKind,
      prompt: "release smoke",
      cwd: process.cwd(),
      systemPrompt: "release smoke",
      userId: bridgeScope.userId,
      topicId: bridgeScope.topicId,
      queryId: bridgeScope.queryId,
      peerBridge: bridgeScope.peerBridge,
    })) {
      throw new Error("invalid smoke agent unexpectedly emitted an event");
    }
  } catch {
    // The invalid agent fails before provider startup while finally still
    // exercises hosted-agent's canonical bridge revocation.
  }
} finally {
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
  resolve(packageRoot, "dist/runtime/src/mcp/session-comm/server.ts"),
  resolve(packageRoot, "dist/runtime/src/mcp/task-server.ts"),
  resolve(packageRoot, "dist/runtime/src/agents/fixtures/codex-shell.jsonl"),
  resolve(packageRoot, "dist/runtime/src/agents/fixtures/claude-attachments.jsonl"),
  resolve(packageRoot, "dist/runtime/src/prompts/agents/wiki-archiver.md"),
  resolve(packageRoot, "dist/runtime/cron/mcp-server.ts"),
]) {
  if (!existsSync(path)) throw new Error(\`packed runtime resource is missing: \${path}\`);
}
for (const name of mcpServers.MCP_SERVER_FILE_NAMES) {
  const path = mcpServers.resolveMcpServerFile(name);
  if (!existsSync(path)) throw new Error(\`packed MCP server is missing: \${name} at \${path}\`);
}
const packedManifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
for (const subpath of [
  "./hosted-agent",
  "./canonical-mcp-bridge",
  "./cron",
  "./mcp-servers",
  "./mcp-catalog",
  "./mcp-factories",
  "./agent-helpers",
  "./background-bash",
  "./browser-runtime",
  "./outbox",
  "./query-runtime",
  "./platform-runtime",
  "./registry",
  "./rollout",
  "./vault",
  "./prompts",
  "./runtime-helpers",
  "./runtime-gateway",
  "./sqlite",
  "./storage",
]) {
  const types = packedManifest.exports?.[subpath]?.types;
  if (typeof types !== "string" || !types.endsWith(".d.ts")) {
    throw new Error(\`packed \${subpath} types must resolve to .d.ts, got \${String(types)}\`);
  }
}
// Runtime imports intentionally initialize persistent storage handles. All
// smoke assertions are complete at this point, so do not wait on those handles.
process.exit(0);
`,
    );
    await Bun.write(
      join(smokeRoot, "storage-node-types.ts"),
      `import {
  configureStorageHost,
  type StorageDatabase,
  type StorageHostConfig,
} from "negotium/storage";

const statement = {
  get: (..._params: any[]) => undefined,
  all: (..._params: any[]) => [],
  run: (..._params: any[]) => ({ changes: 0, lastInsertRowid: 0 }),
};
const database: StorageDatabase = {
  query: () => statement,
  prepare: () => statement,
  exec: () => undefined,
  run: () => ({ changes: 0, lastInsertRowid: 0 }),
  transaction: (fn: (...args: any[]) => any) =>
    Object.assign(fn, { deferred: fn, immediate: fn, exclusive: fn }),
};
const config: StorageHostConfig = {
  database,
  dataDir: "./data",
  sharedWikiDir: "./workspace/wiki",
  usersLogDir: "./data/users",
};
const dispose = configureStorageHost(config);
dispose();
`,
    );
    await runTsc(
      [
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
    await runTsc(
      [
        "--noEmit",
        "--strict",
        "--moduleResolution",
        "bundler",
        "--module",
        "esnext",
        "--target",
        "es2022",
        "--types",
        "node",
        "storage-node-types.ts",
      ],
      smokeRoot,
      true,
      smokeEnv,
    );
    await runNode(
      [
        "--input-type=module",
        "-e",
        `const storage = await import("negotium/storage");
const restore = storage.configureStorageHost({
  dataDir: "./node-storage-data",
  logDir: "./node-storage-logs",
  sessionAsksDir: "./node-storage-asks",
  workspaceDir: "./node-storage-workspace",
});
try {
  if (!Array.isArray(storage.listTopics())) throw new Error("Node storage facade failed");
} finally {
  restore();
}`,
      ],
      smokeRoot,
      true,
      smokeEnv,
    );

    const bin = join(smokeRoot, "node_modules", ".bin", "negotium");
    const help = await run(bin, ["--help"], smokeRoot, false, smokeEnv);
    if (!help.includes("usage: negotium")) fail("packed negotium binary did not render CLI help");
    if (help.includes("chat [topic]") || help.includes("start <terminal|telegram|otium>")) {
      fail("packed negotium binary exposed removed CLI commands");
    }
    const expectedVersion = packages.find((pkg) => pkg.name === "negotium")?.manifest?.version;
    const version = (await run(bin, ["--version"], smokeRoot, false, smokeEnv)).trim();
    if (!expectedVersion || version !== expectedVersion) {
      fail(`packed negotium binary reported version ${version}, expected ${expectedVersion}`);
    }
    const otiumHelp = await run(bin, ["otium", "--help"], smokeRoot, false, smokeEnv);
    if (!otiumHelp.includes("usage: negotium otium")) {
      fail("packed negotium binary did not load the Otium adapter CLI");
    }
    await assertPackedServerStarts(
      bin,
      ["serve"],
      "/api/v1/control/runtime/v1/health",
      "negotium node listening",
      smokeRoot,
      smokeEnv,
      (body) =>
        Array.isArray(body.capabilities) && body.capabilities.includes("canonical-message-delete"),
    );
    const otiumEnv = {
      ...smokeEnv,
      OTIUM_CENTRAL_URL: "http://127.0.0.1:1",
      OTIUM_CELL_ID: "release-smoke-worker",
      OTIUM_CELL_SECRET: "release-smoke-secret",
    };
    await withPackedNodeDaemon(bin, smokeRoot, otiumEnv, async () => {
      await assertPackedServerStarts(
        bin,
        ["serve", "otium"],
        "/ready",
        "negotium Otium adapter listening",
        smokeRoot,
        otiumEnv,
      );
    });
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
    try {
      await runNpmInteractive(["publish", "--access", "public"], resolve(root, pkg.directory));
    } catch (publishError) {
      // npm may accept a version into its staging pipeline, return E409 on an
      // immediate retry, and expose the version through the registry moments
      // later. Treat that race as success only after registry verification;
      // a genuine publish failure still surfaces unchanged.
      try {
        await waitUntilPublished(pkg);
        console.log(`recovered ${pkg.name}@${pkg.manifest?.version} after publish race`);
        continue;
      } catch {
        throw publishError;
      }
    }
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
