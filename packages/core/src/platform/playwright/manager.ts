import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BROWSER_PROFILES_DIR,
  BROWSER_RS_BIN,
  type BrowserProxyConfig,
  PATCHRIGHT_MCP_BIN,
  PLAYWRIGHT_BASE_PORT,
  PLAYWRIGHT_MAX_PORT,
  PLAYWRIGHT_MCP_BIN,
  PLAYWRIGHT_PORTS_DIR,
  resolveBrowserProxy,
} from "#platform/config";
import { delay } from "#platform/delay";
import { logger } from "#platform/logger";
import {
  cleanSingletonFiles,
  isPortInUse,
  killBrowserProcsForUserDataDir,
  killProcessTreeChildren,
  reapOrphanBrowsers,
  reserveAvailableLoopbackPort,
} from "#platform/playwright/browser-processes";
import {
  type HeadedPlaywrightSpawnSpec,
  resolveHeadedPlaywrightSpawn,
} from "#platform/playwright/headed-launch";
import { probePlaywrightMcpTransports } from "#platform/playwright/transport-probe";
import { sanitizeTopicName } from "#security/sanitize";
import {
  assignTopicBrowserProfile,
  getBrowserProfileOwner,
  getTopicBrowserProfile,
  hasBrowserProfileTopic,
  normalizeBrowserProfileName,
} from "#storage/browser-profiles";
import {
  isLiveOwnedChildProcess,
  matchesSpawnedBrowserHealth,
  selectIdleEvictionKey,
  waitForChildProcessExit,
} from "./manager-utils";

export interface PlaywrightProfileBinding {
  readonly instanceKey: string;
  readonly ownerId: string;
  readonly profile: string;
}

export interface PlaywrightChildEnvironmentContext {
  instanceKey: string;
  ownerId: string;
  capability: string;
  proxy: BrowserProxyConfig | null;
  browserRsBin?: string;
  environment: NodeJS.ProcessEnv;
}

export interface PlaywrightManagerHost {
  readonly portsDir: string;
  readonly basePort: number;
  readonly maxPort: number;
  readonly browserBin: string;
  readonly fallbackBrowserBin: string;
  readonly browserRsBin?: string;
  readonly resolveProxy: () => BrowserProxyConfig | null;
  readonly resolveTopicBinding: (userId: string, topic?: string) => PlaywrightProfileBinding;
  readonly resolveNamedBinding: (ownerId: string, rawProfile: string) => PlaywrightProfileBinding;
  readonly resolveInstanceDataDir: (instanceKey: string) => string;
  readonly createChildEnvironment: (
    context: PlaywrightChildEnvironmentContext,
  ) => NodeJS.ProcessEnv;
  /** Reap an orphan that owns this exact host-managed data directory. */
  readonly cleanupBrowserProcessesForDataDir: (userDataDir: string) => void;
  /** Reap host-managed browsers that are not represented by the supplied live directories. */
  readonly reapOrphanBrowsers: (liveUserDataDirs: Iterable<string>) => void;
}

export {
  cleanupZombiePlaywright,
  isBrowserJanitorOwner,
  reapOrphanBrowsers,
  selectOrphanBrowserPids,
} from "#platform/playwright/browser-processes";
export { probePlaywrightMcpTransports } from "#platform/playwright/transport-probe";
export {
  browserProcessMatchesExpectedProfile,
  extractUserDataDirArg,
  isLiveOwnedChildProcess,
  matchesSpawnedBrowserHealth,
  selectIdleEvictionKey,
  selectReusablePort,
  waitForChildProcessExit,
  waitForChildProcessSpawnError,
} from "./manager-utils";
export { PLAYWRIGHT_PORTS_DIR };

/** Multiple topics assigned to one profile reuse one browser process. */
export function makeInstanceKey(userId: string, topic: string | undefined): string {
  return resolvePlaywrightTopicBinding(userId, topic).instanceKey;
}

export function resolvePlaywrightTopicBinding(
  userId: string,
  topic: string | undefined,
): PlaywrightProfileBinding {
  return validateProfileBinding(managerHost.resolveTopicBinding(userId, topic));
}

function defaultTopicBinding(userId: string, topic: string | undefined): PlaywrightProfileBinding {
  if (!topic) return managerHost.resolveNamedBinding(userId, "default");
  const ownerId = getBrowserProfileOwner(topic, userId);
  const profile = migrateLegacyTopicProfile(ownerId, topic);
  return managerHost.resolveNamedBinding(ownerId, profile);
}

export function makeBrowserProfileInstanceKey(ownerId: string, rawProfile: string): string {
  return resolvePlaywrightProfileBinding(ownerId, rawProfile).instanceKey;
}

export function resolvePlaywrightProfileBinding(
  ownerId: string,
  rawProfile: string,
): PlaywrightProfileBinding {
  return validateProfileBinding(managerHost.resolveNamedBinding(ownerId, rawProfile));
}

function validateProfileBinding(binding: PlaywrightProfileBinding): PlaywrightProfileBinding {
  if (
    !binding ||
    typeof binding.instanceKey !== "string" ||
    !binding.instanceKey.trim() ||
    typeof binding.ownerId !== "string" ||
    !binding.ownerId.trim() ||
    typeof binding.profile !== "string" ||
    !binding.profile.trim()
  ) {
    throw new Error("invalid Playwright profile binding");
  }
  return Object.freeze({ ...binding });
}

function defaultNamedBinding(ownerId: string, rawProfile: string): PlaywrightProfileBinding {
  const profile = normalizeBrowserProfileName(rawProfile);
  const instanceKey = `profile:${encodeURIComponent(ownerId)}:${profile}`;
  return {
    instanceKey,
    ownerId,
    profile,
  };
}

export function legacyBrowserProfileName(topic: string): string {
  return `legacy_${createHash("sha256").update(topic).digest("hex").slice(0, 12)}`;
}

function migrateLegacyTopicProfile(ownerId: string, topic: string): string {
  const current = getTopicBrowserProfile(topic);
  if (current !== "default" || !hasBrowserProfileTopic(topic)) return current;

  const legacyDir = resolve(BROWSER_PROFILES_DIR, sanitizeTopicName(topic));
  if (!existsSync(legacyDir)) return current;

  const profile = legacyBrowserProfileName(topic);
  const profileDir = defaultProfileDir(ownerId, profile);
  mkdirSync(dirname(profileDir), { recursive: true });
  if (!existsSync(profileDir)) renameSync(legacyDir, profileDir);
  assignTopicBrowserProfile({ topicId: topic, actorUserId: ownerId, profile });
  logger.info({ ownerId, topic, profile }, "Adopted legacy topic browser profile");
  return profile;
}

function defaultChildEnvironment(context: PlaywrightChildEnvironmentContext): NodeJS.ProcessEnv {
  const { capability, ownerId, proxy, browserRsBin, environment } = context;
  return {
    ...environment,
    NEGOTIUM_BROWSER_CAPABILITY: capability,
    NEGOTIUM_BROWSER_VAULT_USER_ID: ownerId,
    ...(browserRsBin && !proxy ? { NEGOTIUM_BROWSER_RS_BIN: browserRsBin } : {}),
    ...(proxy
      ? {
          NEGOTIUM_BROWSER_PROXY_SERVER: proxy.server,
          ...(proxy.username ? { NEGOTIUM_BROWSER_PROXY_USERNAME: proxy.username } : {}),
          ...(proxy.password ? { NEGOTIUM_BROWSER_PROXY_PASSWORD: proxy.password } : {}),
          ...(proxy.bypass ? { NEGOTIUM_BROWSER_PROXY_BYPASS: proxy.bypass } : {}),
        }
      : {}),
  };
}

const defaultManagerHost: Readonly<PlaywrightManagerHost> = Object.freeze({
  portsDir: PLAYWRIGHT_PORTS_DIR,
  basePort: PLAYWRIGHT_BASE_PORT,
  maxPort: PLAYWRIGHT_MAX_PORT,
  browserBin: PLAYWRIGHT_MCP_BIN,
  fallbackBrowserBin: PATCHRIGHT_MCP_BIN,
  browserRsBin: BROWSER_RS_BIN,
  resolveProxy: resolveBrowserProxy,
  resolveTopicBinding: defaultTopicBinding,
  resolveNamedBinding: defaultNamedBinding,
  resolveInstanceDataDir(instanceKey: string) {
    const { ownerId, profile } = parseInstanceKey(instanceKey);
    return defaultProfileDir(ownerId, profile);
  },
  createChildEnvironment: defaultChildEnvironment,
  cleanupBrowserProcessesForDataDir: killBrowserProcsForUserDataDir,
  reapOrphanBrowsers,
});

let managerHost: Readonly<PlaywrightManagerHost> = defaultManagerHost;

/**
 * Configure product-specific profile storage and browser launch glue.
 * Call once during bootstrap, before any browser instance is started.
 */
export function configurePlaywrightManagerHost(
  overrides: Partial<PlaywrightManagerHost>,
): Readonly<PlaywrightManagerHost> {
  if (instances.size > 0 || spawning.size > 0 || pinnedInstances.size > 0) {
    throw new Error("cannot configure Playwright manager while browser instances are active");
  }
  const next = { ...managerHost, ...overrides };
  if (!next.portsDir || !Number.isInteger(next.basePort) || !Number.isInteger(next.maxPort)) {
    throw new Error("invalid Playwright manager paths or port range");
  }
  if (next.basePort < 1 || next.maxPort > 65_535 || next.basePort > next.maxPort) {
    throw new Error("invalid Playwright manager port range");
  }
  if (!next.browserBin || !next.fallbackBrowserBin) {
    throw new Error("Playwright manager browser binaries are required");
  }
  if (
    next.resolveInstanceDataDir !== defaultManagerHost.resolveInstanceDataDir &&
    (next.cleanupBrowserProcessesForDataDir ===
      defaultManagerHost.cleanupBrowserProcessesForDataDir ||
      next.reapOrphanBrowsers === defaultManagerHost.reapOrphanBrowsers)
  ) {
    throw new Error(
      "custom Playwright profile paths require host crash cleanup and orphan sweep hooks",
    );
  }
  managerHost = Object.freeze(next);
  return managerHost;
}

export function getPlaywrightManagerHost(): Readonly<PlaywrightManagerHost> {
  return managerHost;
}

/** Restore Negotium's built-in browser host after all instances are stopped. */
export function resetPlaywrightManagerHost(): void {
  configurePlaywrightManagerHost(defaultManagerHost);
}

interface InstanceKeyParts {
  ownerId: string;
  profile: string;
}

function parseInstanceKey(instanceKey: string): InstanceKeyParts {
  const match = /^profile:([^:]+):(.+)$/.exec(instanceKey);
  if (!match) return { ownerId: "legacy", profile: sanitizeTopicName(instanceKey) };
  return {
    ownerId: decodeURIComponent(match[1]!),
    profile: normalizeBrowserProfileName(match[2]!),
  };
}

function portFileName(instanceKey: string): string {
  return createHash("sha256").update(instanceKey).digest("hex").slice(0, 24);
}

function writePortFile(instanceKey: string, port: number) {
  try {
    mkdirSync(managerHost.portsDir, { recursive: true });
    writeFileSync(join(managerHost.portsDir, portFileName(instanceKey)), String(port));
  } catch (e) {
    logger.warn({ err: e, instanceKey, port }, "Failed to save playwright port file");
  }
}

function deletePortFile(instanceKey: string) {
  try {
    unlinkSync(join(managerHost.portsDir, portFileName(instanceKey)));
  } catch (e) {
    logger.warn({ err: e, instanceKey }, "Failed to delete playwright port file");
  }
}

function readPortFile(instanceKey: string): number | null {
  try {
    const port = Number.parseInt(
      readFileSync(join(managerHost.portsDir, portFileName(instanceKey)), "utf8").trim(),
      10,
    );
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

const MAX_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours idle → eligible for eviction

interface PlaywrightInstance {
  process: ChildProcess;
  port: number;
  ownerId: string;
  startedAt: number;
  lastUsedAt: number;
  capability: string;
}

const instances = new Map<string, PlaywrightInstance>();

function assertInstanceOwner(instanceKey: string, ownerId: string): void {
  const existing = instances.get(instanceKey);
  if (existing && existing.ownerId !== ownerId) {
    throw new Error(
      `Playwright profile binding owner changed for "${instanceKey}" (${existing.ownerId} -> ${ownerId})`,
    );
  }
}

// Track used ports to avoid collisions
const usedPorts = new Set<number>();

// Prevent concurrent spawns for the same key
const spawning = new Map<string, Promise<number | null>>();

export interface PlaywrightMaintenanceControl {
  /** Stop one of the locked instances before mutating its profile directory. */
  stopInstance(instanceKey: string): Promise<boolean>;
}

/** Serialize destructive profile maintenance with normal browser startup. */
export async function withPlaywrightInstanceMaintenance<T>(
  rawKeys: string[],
  operation: (control: PlaywrightMaintenanceControl) => Promise<T>,
): Promise<T> {
  const keys = [...new Set(rawKeys)].sort();
  const lockedKeys = new Set(keys);
  for (;;) {
    const pending = keys
      .map((key) => spawning.get(key))
      .filter((promise): promise is Promise<number | null> => promise !== undefined);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
      continue;
    }

    let releaseBarrier!: () => void;
    const barrier = new Promise<number | null>((resolveBarrier) => {
      releaseBarrier = () => resolveBarrier(null);
    });
    // No await occurs between the registry check and registration, so another
    // event-loop task cannot acquire any of these keys concurrently.
    for (const key of keys) spawning.set(key, barrier);

    try {
      return await operation({
        async stopInstance(instanceKey) {
          if (!lockedKeys.has(instanceKey)) {
            throw new Error(`Playwright maintenance does not own instance "${instanceKey}"`);
          }
          const process = instances.get(instanceKey)?.process;
          if (!process) return false;
          killInstance(instanceKey);
          if (!(await waitForChildProcessExit(process, 3000))) {
            logger.warn(
              { instanceKey, pid: process.pid },
              "Playwright MCP ignored SIGTERM during profile maintenance",
            );
            try {
              process.kill("SIGKILL");
            } catch (error) {
              logger.warn(
                { err: error, instanceKey, pid: process.pid },
                "Failed to SIGKILL Playwright MCP during profile maintenance",
              );
            }
            await waitForChildProcessExit(process, 1000);
          }
          return true;
        },
      });
    } finally {
      for (const key of keys) {
        if (spawning.get(key) === barrier) spawning.delete(key);
      }
      releaseBarrier();
    }
  }
}

/** Stop one managed instance under the same serialization used by startup and profile mutation. */
export function stopPlaywrightInstance(instanceKey: string): Promise<boolean> {
  return withPlaywrightInstanceMaintenance([instanceKey], ({ stopInstance }) =>
    stopInstance(instanceKey),
  );
}

/** Run owner-aware named-profile maintenance under one lifecycle barrier. */
export function withPlaywrightProfileMaintenance<T>(
  ownerId: string,
  rawProfile: string,
  operation: (
    binding: PlaywrightProfileBinding,
    control: PlaywrightMaintenanceControl,
  ) => Promise<T>,
): Promise<T> {
  const binding = resolvePlaywrightProfileBinding(ownerId, rawProfile);
  return withPlaywrightInstanceMaintenance([binding.instanceKey], async (control) => {
    assertInstanceOwner(binding.instanceKey, binding.ownerId);
    return operation(binding, control);
  });
}

/** Stop a named profile before deleting or replacing its host-managed data directory. */
export function stopPlaywrightProfile(ownerId: string, rawProfile: string): Promise<boolean> {
  return withPlaywrightProfileMaintenance(ownerId, rawProfile, (binding, { stopInstance }) =>
    stopInstance(binding.instanceKey),
  );
}

// A shared profile may have several concurrent turns. Reference counts keep an
// idle sweep from evicting the process until every borrower has finished.
const pinnedInstances = new Map<string, number>();

export function pinPlaywrightInstance(instanceKey: string): void {
  pinnedInstances.set(instanceKey, (pinnedInstances.get(instanceKey) ?? 0) + 1);
}

export function unpinPlaywrightInstance(instanceKey: string): void {
  const count = pinnedInstances.get(instanceKey);
  if (count === undefined) return;
  if (count <= 1) pinnedInstances.delete(instanceKey);
  else pinnedInstances.set(instanceKey, count - 1);
}

export function getPlaywrightCapability(instanceKey: string): string | undefined {
  return instances.get(instanceKey)?.capability;
}

/** Resolve a live browser capability back to its owning user. */
export function resolvePlaywrightCapabilityOwner(capability: string): string | undefined {
  if (!capability) return undefined;
  const provided = Buffer.from(capability);
  for (const instance of instances.values()) {
    const expected = Buffer.from(instance.capability);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return instance.ownerId;
    }
  }
  return undefined;
}

/** Run the configured host's path-bounded orphan sweep against current live instances. */
export function reapPlaywrightOrphans(): void {
  managerHost.reapOrphanBrowsers([...instances.keys()].map(resolveUserDataDir));
}

// --- Browser MCP failure notification callback ---
// Fired when a managed process fails or its transport becomes unhealthy.
// Intentional cleanup paths do not notify consumers.
export interface PlaywrightFailure {
  reason: "exit" | "process-error" | "unhealthy";
  code?: number | null;
  error?: string;
}

type PlaywrightFailureHandler = (instanceKey: string, failure: PlaywrightFailure) => void;
const playwrightFailureHandlers = new Set<PlaywrightFailureHandler>();
export function onPlaywrightFailure(handler: PlaywrightFailureHandler): () => void {
  playwrightFailureHandlers.add(handler);
  return () => playwrightFailureHandlers.delete(handler);
}

function notifyPlaywrightFailure(instanceKey: string, failure: PlaywrightFailure): void {
  for (const handler of playwrightFailureHandlers) {
    try {
      handler(instanceKey, failure);
    } catch (err) {
      logger.warn({ err, instanceKey, failure }, "Playwright failure handler failed");
    }
  }
}

/**
 * Evict the oldest idle instance to free a port.
 * Returns the evicted port, or null when no instance was eligible.
 */
function evictIdleInstance(): number | null {
  const now = Date.now();
  const oldestKey = selectIdleEvictionKey(
    instances,
    pinnedInstances.keys(),
    spawning.keys(),
    now,
    MAX_IDLE_MS,
  );
  if (oldestKey) {
    const instance = instances.get(oldestKey);
    if (!instance) return null;
    const idleMin = ((now - instance.lastUsedAt) / 60000).toFixed(0);
    logger.info({ key: oldestKey, idleMin }, "Evicting idle playwright instance");
    killInstance(oldestKey);
    return instance.port;
  }
  return null;
}

/**
 * Find an available port without depending on platform process-inspection tools.
 * If all ports are taken, evicts the oldest idle instance.
 */
async function allocatePort(): Promise<number> {
  const port = await reserveAvailableLoopbackPort(
    managerHost.basePort,
    managerHost.maxPort,
    usedPorts,
    async (candidate) => {
      // A real loopback bind probe is portable and fail-closed. In particular,
      // a missing `lsof` must never make an occupied port appear available.
      const occupied = await isPortInUse(candidate);
      if (occupied) logger.warn({ port: candidate }, "Port occupied by external process, skipping");
      return occupied;
    },
  );
  if (port !== null) return port;

  // All ports used — try evicting an idle instance
  const evictedPort = evictIdleInstance();
  if (evictedPort !== null) {
    // SIGTERM only requests shutdown. Do not hand the port to a replacement
    // until the old listener is actually gone, and recheck every candidate in
    // case another allocator claimed a different port while we were waiting.
    await waitForPortRelease(evictedPort);
    return allocatePort();
  }

  throw new Error(
    `No available ports for Playwright MCP (${instances.size} active instances, range ${managerHost.basePort}-${managerHost.maxPort})`,
  );
}

function releasePort(port: number) {
  usedPorts.delete(port);
}

function ownerDirectory(ownerId: string): string {
  const digest = createHash("sha256").update(ownerId).digest("hex").slice(0, 16);
  return `${sanitizeTopicName(ownerId).slice(0, 24)}_${digest}`;
}

function defaultProfileDir(ownerId: string, profile: string): string {
  return resolve(BROWSER_PROFILES_DIR, "profiles", ownerDirectory(ownerId), profile);
}

/** Resolve the shared profile userDataDir for an instanceKey. */
function resolveUserDataDir(instanceKey: string): string {
  return managerHost.resolveInstanceDataDir(instanceKey);
}

/**
 * Kill and clean up a specific instance.
 * Also kills Chrome child processes and cleans up Singleton files.
 * @param keepPort - If true, don't release the port (for same-port respawn).
 */
function killInstance(instanceKey: string, opts?: { keepPort?: boolean }) {
  const inst = instances.get(instanceKey);
  if (!inst) return;

  // Kill Chrome children first (before killing the MCP server)
  if (inst.process.pid) {
    killProcessTreeChildren(inst.process.pid);
  }

  try {
    inst.process.kill("SIGTERM");
  } catch (e) {
    logger.warn({ err: e, instanceKey }, "Failed to kill playwright instance");
  }

  // Drop the spawn-time error/exit handlers. Cleanup is done synchronously
  // here, so the late-firing listeners only add duplicate instances.delete()
  // calls and keep the process reference alive until exit. Removing them
  // also lets callers (e.g. killAllPlaywright) attach their own exit waiter
  // without the spawn handler racing against it.
  inst.process.removeAllListeners("error");
  inst.process.removeAllListeners("exit");

  cleanSingletonFiles(resolveUserDataDir(instanceKey));

  if (!opts?.keepPort) releasePort(inst.port);
  instances.delete(instanceKey);
  deletePortFile(instanceKey);
  logger.info(
    { instanceKey, port: inst.port, keepPort: !!opts?.keepPort },
    "Killed Playwright MCP (with cleanup)",
  );
}

const PLAYWRIGHT_STARTUP_STDERR_LIMIT = 8 * 1024;

function captureBoundedStderr(proc: ChildProcess): () => string {
  let tail = Buffer.alloc(0);
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    tail = Buffer.concat([tail, next]);
    if (tail.byteLength > PLAYWRIGHT_STARTUP_STDERR_LIMIT) {
      tail = tail.subarray(tail.byteLength - PLAYWRIGHT_STARTUP_STDERR_LIMIT);
    }
  });
  return () => tail.toString("utf8").trim();
}

export function watchChildStartup(
  proc: ChildProcess,
  stderrTail: () => string,
): { failure: Promise<never>; stop: () => void } {
  let stopped = false;
  let rejectFailure: (error: Error) => void = () => undefined;
  const diagnostics = () => {
    const stderr = stderrTail();
    return stderr ? `\nstderr (last ${PLAYWRIGHT_STARTUP_STDERR_LIMIT} bytes):\n${stderr}` : "";
  };
  const onError = (error: Error) => {
    rejectFailure(
      new Error(`Playwright MCP failed to spawn: ${error.message}${diagnostics()}`, {
        cause: error,
      }),
    );
  };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    rejectFailure(
      new Error(
        `Playwright MCP exited during startup (code=${code ?? "null"}, signal=${signal ?? "null"})${diagnostics()}`,
      ),
    );
  };
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
    proc.once("error", onError);
    proc.once("exit", onExit);
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    proc.off("error", onError);
    proc.off("exit", onExit);
  };
  return { failure, stop };
}

/**
 * Spawn a browser MCP HTTP server for a shared named profile. The profile
 * identity is encoded in `instanceKey` and decoded inside `resolveUserDataDir`.
 */
/**
 * Spawn a Playwright MCP process for the given instanceKey.
 * @param instanceKey  Unique key identifying this instance.
 * @param ownerId      Canonical profile owner ID (stored in the instance record).
 * @param reservedPort When provided the process binds to this already-reserved
 *                     port (restart path). When omitted a fresh port is allocated.
 */
async function spawnPlaywright(
  instanceKey: string,
  ownerId: string,
  reservedPort?: number,
  browserBin = managerHost.browserBin,
  allowFallback = true,
): Promise<number> {
  const userDataDir = resolveUserDataDir(instanceKey);
  const port = reservedPort ?? (await allocatePort());
  mkdirSync(userDataDir, { recursive: true });

  const mcpArgs = [
    "--port",
    String(port),
    // Pin to IPv4. `--host 127.0.0.1` keeps every transport on the same
    // address family. Without it, a `localhost`→`::1`-only bind breaks the
    // Maestro MCP client (its SSEClientTransport forces `127.0.0.1` because
    // the Node `eventsource` package's IPv6 lookup historically failed), so
    // browser tools would silently disappear from maestro turns.
    "--host",
    "127.0.0.1",
    // Keep the browser visible. Do not rely on the launcher's implicit
    // default: an explicit flag prevents wrapper/upstream default changes
    // from silently switching topic browsers back to headless mode.
    "--headed",
    "--user-data-dir",
    userDataDir,
    // NOTE: mcp-patchright throws on unknown CLI args, so the old
    // @playwright/mcp flags are intentionally gone:
    //   --shared-browser-context → mcp-patchright always uses one persistent
    //     context per userDataDir (launchPersistentContext), so it's implicit.
    //   --browser chrome         → defaults to the "chrome" channel already
    //     (requires real Google Chrome at /opt/google/chrome/chrome).
    //   --init-script <stealth>  → unneeded; Patchright is stealth by default.
  ];
  // Pass the egress proxy to the child through the environment rather than
  // argv so the credentials never surface in `ps`/`/proc` command lines. The
  // launcher (scripts/mcp-patchright-http.mjs) reads these NEGOTIUM_BROWSER_PROXY_*
  // vars and hands them to Playwright's per-context proxy option.
  const proxy = managerHost.resolveProxy();
  const capability = randomBytes(32).toString("hex");
  const spawnNonce = randomBytes(32).toString("hex");
  const childEnv = {
    ...managerHost.createChildEnvironment({
      instanceKey,
      ownerId,
      capability,
      proxy,
      browserRsBin: managerHost.browserRsBin,
      environment: process.env,
    }),
    NEGOTIUM_BROWSER_CAPABILITY: capability,
    NEGOTIUM_BROWSER_SPAWN_NONCE: spawnNonce,
  };
  // Every supported wrapper authenticates owner-scoped transports with this
  // capability. Product-specific environment hooks may add Vault callbacks,
  // but cannot remove transport authentication.
  if (proxy) {
    logger.info({ instanceKey, proxyServer: proxy.server }, "Browser egress proxy enabled");
  }

  const command = browserBin.endsWith(".mjs") ? process.execPath : browserBin;
  const args = browserBin.endsWith(".mjs") ? [browserBin, ...mcpArgs] : mcpArgs;
  let spawnSpec: HeadedPlaywrightSpawnSpec;
  try {
    spawnSpec = resolveHeadedPlaywrightSpawn(command, args, { environment: childEnv });
  } catch (err) {
    releasePort(port);
    throw err;
  }
  let proc: ChildProcess;
  try {
    proc = spawn(spawnSpec.command, spawnSpec.args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
      env: childEnv,
    });
  } catch (err) {
    releasePort(port);
    throw err;
  }
  const stderrTail = captureBoundedStderr(proc);
  const startup = watchChildStartup(proc, stderrTail);

  // When the MCP dies on its own (crash / OOM), its Chrome subtree is reparented
  // to init and escapes the tracked-instance map. Reap it by user-data-dir here
  // so a crash can't leak an orphan Chrome that keeps holding memory (the exact
  // cascade that piles up dozens of zombies under pressure). killInstance()
  // removes these listeners before signalling, so this only runs on real deaths.
  const reapCrashedBrowser = () => {
    const userDataDir = resolveUserDataDir(instanceKey);
    managerHost.cleanupBrowserProcessesForDataDir(userDataDir);
    cleanSingletonFiles(userDataDir);
  };

  proc.once("error", (err) => {
    logger.error({ err, instanceKey, stderr: stderrTail() || undefined }, "Playwright MCP error");
    if (instances.get(instanceKey)?.process === proc) {
      releasePort(port);
      instances.delete(instanceKey);
      reapCrashedBrowser();
      notifyPlaywrightFailure(instanceKey, {
        reason: "process-error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  proc.once("exit", (code) => {
    logger.info({ instanceKey, code, stderr: stderrTail() || undefined }, "Playwright MCP exited");
    // `wasOurs` distinguishes a crash from our own killInstance(): the latter
    // calls removeAllListeners("exit") + instances.delete() BEFORE the kill
    // signal lands, so this listener either doesn't fire or sees wasOurs=false.
    // wasOurs=true here therefore implies the MCP died on its own — Claude
    // SDK queries waiting on its tool results need to be aborted.
    const wasOurs = instances.get(instanceKey)?.process === proc;
    if (wasOurs) {
      releasePort(port);
      instances.delete(instanceKey);
      reapCrashedBrowser();
      notifyPlaywrightFailure(instanceKey, { reason: "exit", code });
    }
  });

  const now = Date.now();
  instances.set(instanceKey, {
    process: proc,
    port,
    ownerId,
    startedAt: now,
    lastUsedAt: now,
    capability,
  });

  let startupError: Error | undefined;
  let ready = false;
  try {
    ready = await Promise.race([
      (async () =>
        (await waitForServer(port, spawnNonce, 10_000)) &&
        (await supportsOwnerCleanup(port, capability)) &&
        (await probePlaywrightMcpTransports(port, capability)))(),
      startup.failure,
    ]);
  } catch (error) {
    startupError = error instanceof Error ? error : new Error(String(error));
  } finally {
    startup.stop();
  }
  if (ready && !isLiveOwnedChildProcess(instances.get(instanceKey), proc)) {
    ready = false;
    startupError = new Error(
      `Playwright MCP exited after readiness but before publication on port ${port}` +
        (stderrTail() ? `\nstderr:\n${stderrTail()}` : ""),
    );
  }
  if (!ready) {
    const exitCode = proc.exitCode;
    killInstance(instanceKey);
    if (allowFallback && browserBin !== managerHost.fallbackBrowserBin) {
      logger.warn(
        {
          err: startupError,
          instanceKey,
          browserBin,
          fallback: managerHost.fallbackBrowserBin,
          stderr: stderrTail() || undefined,
        },
        "Preferred browser MCP unavailable or lacks owner isolation; using Patchright fallback",
      );
      return spawnPlaywright(
        instanceKey,
        ownerId,
        undefined,
        managerHost.fallbackBrowserBin,
        false,
      );
    }
    if (startupError) throw startupError;
    throw new Error(
      `Playwright MCP failed health check after spawn on port ${port}` +
        (exitCode === null ? "" : ` (exitCode=${exitCode})`) +
        (stderrTail() ? `\nstderr:\n${stderrTail()}` : ""),
    );
  }
  writePortFile(instanceKey, port);
  logger.info(
    { instanceKey, port, pid: proc.pid, ready, virtualDisplay: spawnSpec.virtualDisplay },
    "Playwright MCP started",
  );
  return port;
}

async function supportsOwnerCleanup(port: number, capability: string): Promise<boolean> {
  try {
    const query = new URLSearchParams({ owner: "__negotium_capability_probe__" });
    const response = await fetch(`http://127.0.0.1:${port}/owners?${query}`, {
      method: "DELETE",
      headers: {
        "X-Browser-Capability": capability,
      },
      signal: AbortSignal.timeout(2000),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure a healthy browser MCP server is running for this topic's profile.
 * Topics assigned to the same profile reuse one process and data directory.
 * - If running and healthy → reuse
 * - If running but unhealthy → kill and respawn
 * - If not running → spawn
 */
export async function ensurePlaywright(userId: string, topic?: string): Promise<number> {
  const binding = resolvePlaywrightTopicBinding(userId, topic);
  const { instanceKey, ownerId } = binding;

  // If a spawn/restart is already in progress for this key, wait for it
  const inProgress = spawning.get(instanceKey);
  if (inProgress) {
    const port = await inProgress;
    assertInstanceOwner(instanceKey, ownerId);
    if (port !== null) return port;
    // Restart failed — re-enter: by now another caller may have registered a
    // newer attempt to join, otherwise we start one ourselves.
    return ensurePlaywright(userId, topic);
  }

  // The ENTIRE health-check → kill → spawn sequence lives inside the spawning
  // promise. The old shape awaited isHealthy() between the guard check and
  // spawning.set(), so two concurrent callers could both pass the guard: one
  // would killInstance() the instance the other had just spawned, or both
  // would spawn and the second instances.set() orphaned the first process
  // (its port leaked from usedPorts until restart). With no await between
  // spawning.get() above and spawning.set() below, the guard is airtight on
  // a single-threaded event loop.
  const promise = (async (): Promise<number> => {
    const existing = instances.get(instanceKey);
    assertInstanceOwner(instanceKey, ownerId);

    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      if (await probePlaywrightMcpTransports(existing.port, existing.capability)) {
        existing.lastUsedAt = Date.now();
        return existing.port;
      }
      logger.warn({ instanceKey }, "Playwright MCP unresponsive, restarting");
      const oldPort = existing.port;
      killInstance(instanceKey);
      notifyPlaywrightFailure(instanceKey, { reason: "unhealthy" });
      await waitForPortRelease(oldPort);
      cleanSingletonFiles(resolveUserDataDir(instanceKey));
    } else if (existing) {
      releasePort(existing.port);
      instances.delete(instanceKey);
      cleanSingletonFiles(resolveUserDataDir(instanceKey));
      notifyPlaywrightFailure(instanceKey, {
        reason: "exit",
        code: existing.process.exitCode,
      });
    }

    return spawnPlaywright(instanceKey, ownerId);
  })().finally(() => spawning.delete(instanceKey));
  spawning.set(instanceKey, promise);
  return promise;
}

async function waitForPortRelease(port: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortInUse(port))) return;
    await delay(200);
  }
}

/** Start or reuse a named shared profile before assigning more topics to it. */
export async function ensureBrowserProfile(ownerId: string, rawProfile: string): Promise<number> {
  const binding = resolvePlaywrightProfileBinding(ownerId, rawProfile);
  const instanceKey = binding.instanceKey;
  const inProgress = spawning.get(instanceKey);
  if (inProgress) {
    const port = await inProgress;
    assertInstanceOwner(instanceKey, binding.ownerId);
    const capability = instances.get(instanceKey)?.capability;
    if (port !== null && capability && (await probePlaywrightMcpTransports(port, capability))) {
      return port;
    }
    if (port === null) return ensureBrowserProfile(ownerId, rawProfile);
    throw new Error(`Browser profile "${rawProfile}" failed to start.`);
  }

  const promise = (async (): Promise<number> => {
    const publishedPort = readPortFile(instanceKey);
    const existing = instances.get(instanceKey);
    assertInstanceOwner(instanceKey, binding.ownerId);
    if (publishedPort !== null && !existing) {
      // A port file without an in-memory instance belongs to a previous runtime.
      // Its per-process capability and ChildProcess handle cannot be recovered,
      // so adopting it would bypass owner cleanup and lifecycle tracking. Reap
      // only the browser serving this exact profile, then spawn a tracked one.
      logger.warn(
        { instanceKey, publishedPort },
        "Recycling untracked browser profile process from stale port file",
      );
      managerHost.cleanupBrowserProcessesForDataDir(resolveUserDataDir(instanceKey));
      await waitForPortRelease(publishedPort);
      deletePortFile(instanceKey);
    }

    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      if (await probePlaywrightMcpTransports(existing.port, existing.capability)) {
        existing.lastUsedAt = Date.now();
        return existing.port;
      }
      const oldPort = existing.port;
      killInstance(instanceKey);
      notifyPlaywrightFailure(instanceKey, { reason: "unhealthy" });
      await waitForPortRelease(oldPort);
      cleanSingletonFiles(resolveUserDataDir(instanceKey));
    } else if (existing) {
      releasePort(existing.port);
      instances.delete(instanceKey);
      cleanSingletonFiles(resolveUserDataDir(instanceKey));
      notifyPlaywrightFailure(instanceKey, {
        reason: "exit",
        code: existing.process.exitCode,
      });
    }
    const port = await spawnPlaywright(instanceKey, binding.ownerId);
    const capability = instances.get(instanceKey)?.capability;
    if (!capability || !(await probePlaywrightMcpTransports(port, capability))) {
      killInstance(instanceKey);
      throw new Error(`Browser profile "${rawProfile}" did not pass its health check.`);
    }
    return port;
  })().finally(() => spawning.delete(instanceKey));
  spawning.set(instanceKey, promise);
  return promise;
}

/** Close only one topic/job's tabs while preserving the shared profile. */
export async function closeBrowserOwnerTabs(
  ownerId: string,
  rawProfile: string,
  owner: string,
): Promise<number> {
  const binding = resolvePlaywrightProfileBinding(ownerId, rawProfile);
  const instanceKey = binding.instanceKey;
  const inProgress = spawning.get(instanceKey);
  if (inProgress) await inProgress;
  assertInstanceOwner(instanceKey, binding.ownerId);
  const instance = instances.get(instanceKey);
  if (!instance) return 0;
  const port = instance.port;

  const query = new URLSearchParams({ owner });
  const response = await fetch(`http://127.0.0.1:${port}/owners?${query}`, {
    method: "DELETE",
    headers: {
      "X-Browser-Capability": instance.capability,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`browser MCP owner cleanup failed (${response.status})`);
  const result = (await response.json()) as { closed?: number };
  return typeof result.closed === "number" ? result.closed : 0;
}

/**
 * Poll until the SSE server responds, or timeout.
 * Returns true if the server is healthy, false on timeout.
 */
async function waitForServer(
  port: number,
  expectedSpawnNonce: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const health: unknown = await response.json();
        if (matchesSpawnedBrowserHealth(health, expectedSpawnNonce)) {
          return true;
        }
      } else {
        await response.body?.cancel();
      }
    } catch {
      // The owned child may still be loading or binding its listener.
    }
    await delay(300);
  }
  logger.warn({ port, timeoutMs }, "Playwright MCP not ready before timeout");
  return false;
}

/**
 * Kill all Playwright MCP instances for a specific user.
 */
export function killPlaywrightForUser(userId: string): void {
  logger.info({ userId }, "killPlaywrightForUser: no user-scoped browser profile to kill");
}

/**
 * Legacy API retained for callers that still request topic-scoped shutdown.
 * Shared profiles cannot be killed through a single topic.
 */
export function killPlaywrightForTopic(userId: string, topic: string): void {
  logger.info(
    { userId, topic },
    "killPlaywrightForTopic skipped: topic uses a shared browser profile",
  );
}

/**
 * Resolve the on-disk Playwright user-data-dir for a topic/profile id.
 * Useful for external callers that need to inspect / copy / delete the dir without
 * touching the running process.
 */
export function resolveTopicProfileDir(userId: string, topic: string): string {
  return resolveUserDataDir(makeInstanceKey(userId, topic));
}

export interface CloneProfileResult {
  copied: boolean;
  srcDir: string;
  dstDir: string;
  /** Set when `copied=false` to explain why (e.g. src-missing, same-dir, copy-failed:…) */
  reason?: string;
}

/**
 * Assign a child to its parent's shared profile when owners match. Browser
 * credentials never cross an owner boundary.
 *
 * Safety: if the parent instance is currently running, we kill it first to flush
 * SQLite WAL state to disk, then copy. The parent is NOT respawned here — the
 * next user message on the parent topic will trigger ensurePlaywright() to bring
 * it back. This avoids a race where copy and live writes interleave.
 *
 * Copy strategy:
 *   - macOS APFS: `cp -cR` triggers clonefile() (metadata-only, ms-level).
 *   - Other platforms, or if clonefile fails: regular recursive copy.
 */
export async function cloneProfileForChild(opts: {
  userId: string;
  srcTopic: string;
  dstTopic: string;
}): Promise<CloneProfileResult> {
  const srcOwner = getBrowserProfileOwner(opts.srcTopic, opts.userId);
  const dstOwner = getBrowserProfileOwner(opts.dstTopic, opts.userId);
  if (srcOwner !== dstOwner) {
    const srcBinding = resolvePlaywrightProfileBinding(
      srcOwner,
      getTopicBrowserProfile(opts.srcTopic),
    );
    const dstBinding = resolvePlaywrightProfileBinding(
      dstOwner,
      getTopicBrowserProfile(opts.dstTopic),
    );
    return {
      copied: false,
      srcDir: resolveUserDataDir(srcBinding.instanceKey),
      dstDir: resolveUserDataDir(dstBinding.instanceKey),
      reason: "cross-owner-fresh-profile",
    };
  }
  if (srcOwner === dstOwner && hasBrowserProfileTopic(opts.dstTopic)) {
    const profile = getTopicBrowserProfile(opts.srcTopic);
    assignTopicBrowserProfile({ topicId: opts.dstTopic, actorUserId: dstOwner, profile });
    const binding = resolvePlaywrightProfileBinding(srcOwner, profile);
    const sharedDir = resolveUserDataDir(binding.instanceKey);
    return {
      copied: false,
      srcDir: sharedDir,
      dstDir: sharedDir,
      reason: "shared-profile-assignment",
    };
  }

  const srcKey = makeInstanceKey(opts.userId, opts.srcTopic);
  const dstKey = makeInstanceKey(opts.userId, opts.dstTopic);
  const srcDir = resolveUserDataDir(srcKey);
  const dstDir = resolveUserDataDir(dstKey);

  if (srcDir === dstDir) {
    return { copied: false, srcDir, dstDir, reason: "same-dir" };
  }

  return withPlaywrightInstanceMaintenance([srcKey, dstKey], async () => {
    // Quiesce parent if running so Chrome flushes SQLite (Cookies, Login Data)
    // before we read the bytes. The maintenance barrier prevents a concurrent
    // ensurePlaywright() from reopening either profile until copying finishes.
    //
    // killInstance() sends SIGTERM and removes the instance map entry synchronously,
    // but Chrome's subprocess exit + on-disk flush is async. Empirically 1.0–1.5s
    // is enough for the cookie store to settle; we wait 1.5s to be safe.
    const parentWasLive = instances.has(srcKey);
    if (parentWasLive) {
      logger.info({ srcKey }, "Quiescing parent Playwright before profile clone");
      killInstance(srcKey);
      await delay(1500);
    }

    // Defensive: dst should be brand-new but kill any stray instance just in case
    if (instances.has(dstKey)) {
      killInstance(dstKey);
      await delay(500);
    }

    if (!existsSync(srcDir)) {
      return { copied: false, srcDir, dstDir, reason: "src-missing" };
    }

    try {
      if (existsSync(dstDir)) {
        rmSync(dstDir, { recursive: true, force: true });
      }
      mkdirSync(dirname(dstDir), { recursive: true });
      if (process.platform === "darwin") {
        try {
          // `-c` requests clonefile() on APFS for a fast copy-on-write clone.
          execFileSync("cp", ["-cR", srcDir, dstDir], { stdio: "pipe" });
        } catch {
          cpSync(srcDir, dstDir, { recursive: true });
        }
      } else {
        cpSync(srcDir, dstDir, { recursive: true });
      }
    } catch (e) {
      const reason = `copy-failed: ${e instanceof Error ? e.message : String(e)}`;
      logger.warn({ srcDir, dstDir, err: e }, "Playwright profile clone failed");
      return { copied: false, srcDir, dstDir, reason };
    }

    // Strip per-process locks copied from the parent so the child Chrome can
    // launch on its fresh dir without a fake "another instance is running" error.
    cleanSingletonFiles(dstDir);
    for (const f of ["DevToolsActivePort", "LOCK"]) {
      try {
        unlinkSync(resolve(dstDir, f));
      } catch {
        // Not all profiles have these — ignore.
      }
    }

    logger.info({ srcKey, dstKey, srcDir, dstDir }, "Cloned Playwright profile for child topic");
    return { copied: true, srcDir, dstDir };
  });
}

/**
 * Compatibility API for hard-delete callers. Shared profile directories are
 * preserved; lifecycle cleanup closes only the deleted topic's owner tabs.
 */
export function deleteTopicProfileDir(
  userId: string,
  topic: string,
): { deleted: boolean; dir: string } {
  const key = makeInstanceKey(userId, topic);
  const dir = resolveUserDataDir(key);
  logger.info({ dir, userId, topic }, "Preserved shared browser profile on topic deletion");
  return { deleted: false, dir };
}

/**
 * Kill all running Playwright MCP instances and wait for them to exit.
 * Call on bot shutdown. Waits up to 3s per instance before giving up.
 */
export async function killAllPlaywright(): Promise<void> {
  const procs = [...instances.entries()].map(([key, inst]) => ({ key, proc: inst.process }));
  for (const { key } of procs) killInstance(key);

  await Promise.all(
    procs.map(async ({ key, proc }) => {
      if (await waitForChildProcessExit(proc, 3000)) return;
      logger.warn({ instanceKey: key, pid: proc.pid }, "Playwright MCP ignored SIGTERM");
      try {
        proc.kill("SIGKILL");
      } catch (err) {
        logger.warn({ err, instanceKey: key, pid: proc.pid }, "Failed to SIGKILL Playwright MCP");
      }
      if (!(await waitForChildProcessExit(proc, 1000))) {
        logger.warn({ instanceKey: key, pid: proc.pid }, "Playwright MCP did not report exit");
      }
    }),
  );
}

// Proactively evict all idle instances every 30 minutes
// Every 30 minutes: evict idle instances, then reap any orphaned browser the
// tracked-instance map has lost sight of. The orphan reap is only a backstop —
// the crash-exit handler already reaps in real time (killBrowserProcsForUserDataDir),
// so this catches just the rare miss (an exit event that never fired). A single
// low-frequency sweep keeps it cheap: one `pgrep` that returns nothing when no
// browser is running, a few `ps` calls only while automation is active.
setInterval(
  () => {
    while (evictIdleInstance() !== null) {}
    try {
      reapPlaywrightOrphans();
    } catch (e) {
      logger.debug({ err: e }, "reapOrphanBrowsers sweep failed");
    }
  },
  30 * 60 * 1000,
).unref();
