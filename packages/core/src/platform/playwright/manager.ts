import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
  isHealthy,
  isPortInUse,
  killBrowserProcsForUserDataDir,
  killPlaywrightOnPort,
  killProcessTreeChildren,
  reapOrphanBrowsers,
} from "#platform/playwright/browser-processes";
import {
  type HeadedPlaywrightSpawnSpec,
  resolveHeadedPlaywrightSpawn,
} from "#platform/playwright/headed-launch";
import { sanitizeTopicName } from "#security/sanitize";
import {
  assignTopicBrowserProfile,
  getBrowserProfileOwner,
  getTopicBrowserProfile,
  hasBrowserProfileTopic,
  normalizeBrowserProfileName,
} from "#storage/browser-profiles";
import {
  selectIdleEvictionKey,
  selectReusablePort,
  waitForChildProcessExit,
  waitForChildProcessSpawnError,
} from "./manager-utils";

export {
  cleanupZombiePlaywright,
  isBrowserJanitorOwner,
  selectOrphanBrowserPids,
} from "#platform/playwright/browser-processes";
export {
  browserProcessMatchesExpectedProfile,
  extractUserDataDirArg,
  selectIdleEvictionKey,
  selectReusablePort,
  waitForChildProcessExit,
  waitForChildProcessSpawnError,
} from "./manager-utils";
export { PLAYWRIGHT_PORTS_DIR };

/** Multiple topics assigned to one profile reuse one browser process. */
export function makeInstanceKey(userId: string, topic: string | undefined): string {
  if (!topic) return makeBrowserProfileInstanceKey(userId, "default");
  const ownerId = getBrowserProfileOwner(topic, userId);
  const profile = migrateLegacyTopicProfile(ownerId, topic);
  return makeBrowserProfileInstanceKey(ownerId, profile);
}

export function makeBrowserProfileInstanceKey(ownerId: string, rawProfile: string): string {
  return `profile:${encodeURIComponent(ownerId)}:${normalizeBrowserProfileName(rawProfile)}`;
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
  const profileDir = resolveProfileDir(ownerId, profile);
  mkdirSync(dirname(profileDir), { recursive: true });
  if (!existsSync(profileDir)) renameSync(legacyDir, profileDir);
  assignTopicBrowserProfile({ topicId: topic, actorUserId: ownerId, profile });
  logger.info({ ownerId, topic, profile }, "Adopted legacy topic browser profile");
  return profile;
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
    mkdirSync(PLAYWRIGHT_PORTS_DIR, { recursive: true });
    writeFileSync(join(PLAYWRIGHT_PORTS_DIR, portFileName(instanceKey)), String(port));
  } catch (e) {
    logger.warn({ err: e, instanceKey, port }, "Failed to save playwright port file");
  }
}

function deletePortFile(instanceKey: string) {
  try {
    unlinkSync(join(PLAYWRIGHT_PORTS_DIR, portFileName(instanceKey)));
  } catch (e) {
    logger.warn({ err: e, instanceKey }, "Failed to delete playwright port file");
  }
}

function readPortFile(instanceKey: string): number | null {
  try {
    const port = Number.parseInt(
      readFileSync(join(PLAYWRIGHT_PORTS_DIR, portFileName(instanceKey)), "utf8").trim(),
      10,
    );
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

const BASE_PORT = PLAYWRIGHT_BASE_PORT;
const MAX_PORT = PLAYWRIGHT_MAX_PORT;
const MAX_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours idle → eligible for eviction

interface PlaywrightInstance {
  process: ChildProcess;
  port: number;
  userId: string;
  startedAt: number;
  lastUsedAt: number;
  capability: string;
}

const instances = new Map<string, PlaywrightInstance>();

// Track used ports to avoid collisions
const usedPorts = new Set<number>();

// Prevent concurrent spawns for the same key
const spawning = new Map<string, Promise<number | null>>();

/** Serialize destructive profile maintenance with normal browser startup. */
export async function withPlaywrightInstanceMaintenance<T>(
  rawKeys: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(rawKeys)].sort();
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
      return await operation();
    } finally {
      for (const key of keys) {
        if (spawning.get(key) === barrier) spawning.delete(key);
      }
      releaseBarrier();
    }
  }
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

// --- Abnormal exit notification callback ---
// Fired when a Playwright MCP child process exits with a non-zero / non-null
// code that did NOT originate from our own killInstance() (those paths are
// intentional cleanups, not crashes). Consumers use this to abort any
// in-flight `handleAgentQuery` whose Claude SDK is waiting on a tool result
// the dead MCP can never deliver — preventing 20+ minute typing-only stalls.
type PlaywrightExitHandler = (instanceKey: string, code: number | null) => void;
let _onPlaywrightExit: PlaywrightExitHandler | null = null;
export function onPlaywrightExit(handler: PlaywrightExitHandler) {
  _onPlaywrightExit = handler;
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
 * Find an available port, killing zombie processes if needed.
 * If all ports are taken, evicts the oldest idle instance.
 *
 * `expectedUserDataDir` is forwarded to `killPlaywrightOnPort` so that only a
 * playwright-mcp serving this caller's own userDataDir is treated as a zombie.
 * Without that filter, another process with its own empty instances map could
 * mistake a live topic Playwright for an orphan and SIGKILL it.
 */
async function allocatePort(expectedUserDataDir?: string): Promise<number> {
  for (let port = BASE_PORT; port <= MAX_PORT; port++) {
    if (usedPorts.has(port)) continue;
    usedPorts.add(port); // Reserve immediately before any await to prevent concurrent allocation

    // Check if something else is already on this port (zombie from previous run)
    if (isPortInUse(port)) {
      logger.warn({ port }, "Port occupied by external process, attempting cleanup");
      await killPlaywrightOnPort(port, expectedUserDataDir);
      if (isPortInUse(port)) {
        usedPorts.delete(port); // Still occupied — release reservation and try next
        continue;
      }
    }

    return port;
  }

  // All ports used — try evicting an idle instance
  const evictedPort = evictIdleInstance();
  if (evictedPort !== null) {
    // SIGTERM only requests shutdown. Do not hand the port to a replacement
    // until the old listener is actually gone, and recheck every candidate in
    // case another allocator claimed a different port while we were waiting.
    await waitForPortRelease(evictedPort);
    const reusablePort = selectReusablePort(BASE_PORT, MAX_PORT, usedPorts, isPortInUse);
    if (reusablePort !== null) {
      usedPorts.add(reusablePort);
      return reusablePort;
    }
  }

  throw new Error(
    `No available ports for Playwright MCP (${instances.size} active instances, range ${BASE_PORT}-${MAX_PORT})`,
  );
}

function releasePort(port: number) {
  usedPorts.delete(port);
}

function ownerDirectory(ownerId: string): string {
  const digest = createHash("sha256").update(ownerId).digest("hex").slice(0, 16);
  return `${sanitizeTopicName(ownerId).slice(0, 24)}_${digest}`;
}

function resolveProfileDir(ownerId: string, profile: string): string {
  return resolve(BROWSER_PROFILES_DIR, "profiles", ownerDirectory(ownerId), profile);
}

/** Resolve the shared profile userDataDir for an instanceKey. */
function resolveUserDataDir(instanceKey: string): string {
  const { ownerId, profile } = parseInstanceKey(instanceKey);
  return resolveProfileDir(ownerId, profile);
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

/**
 * Spawn a browser MCP HTTP server for a shared named profile. The profile
 * identity is encoded in `instanceKey` and decoded inside `resolveUserDataDir`.
 */
/**
 * Spawn a Playwright MCP process for the given instanceKey.
 * @param instanceKey  Unique key identifying this instance.
 * @param userId       Owner user ID (stored in the instance record).
 * @param reservedPort When provided the process binds to this already-reserved
 *                     port (restart path). When omitted a fresh port is allocated.
 */
async function spawnPlaywright(
  instanceKey: string,
  userId: string,
  reservedPort?: number,
  browserBin = PLAYWRIGHT_MCP_BIN,
  allowFallback = true,
): Promise<number> {
  const userDataDir = resolveUserDataDir(instanceKey);
  // Forward userDataDir to allocatePort so the in-port zombie scan can
  // distinguish "my own orphan to kill" from "another process's live
  // instance to skip past" — see allocatePort docstring.
  const port = reservedPort ?? (await allocatePort(userDataDir));
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
  const proxy = resolveBrowserProxy();
  const capability = randomBytes(32).toString("hex");
  const childEnv = {
    ...process.env,
    NEGOTIUM_BROWSER_CAPABILITY: capability,
    NEGOTIUM_BROWSER_VAULT_USER_ID: userId,
    ...(BROWSER_RS_BIN && !proxy ? { NEGOTIUM_BROWSER_RS_BIN: BROWSER_RS_BIN } : {}),
    ...(proxy
      ? {
          NEGOTIUM_BROWSER_PROXY_SERVER: proxy.server,
          ...(proxy.username ? { NEGOTIUM_BROWSER_PROXY_USERNAME: proxy.username } : {}),
          ...(proxy.password ? { NEGOTIUM_BROWSER_PROXY_PASSWORD: proxy.password } : {}),
          ...(proxy.bypass ? { NEGOTIUM_BROWSER_PROXY_BYPASS: proxy.bypass } : {}),
        }
      : {}),
  };
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
      stdio: "ignore",
      detached: false,
      env: childEnv,
    });
  } catch (err) {
    releasePort(port);
    throw err;
  }
  const spawnError = waitForChildProcessSpawnError(proc);

  // When the MCP dies on its own (crash / OOM), its Chrome subtree is reparented
  // to init and escapes the tracked-instance map. Reap it by user-data-dir here
  // so a crash can't leak an orphan Chrome that keeps holding memory (the exact
  // cascade that piles up dozens of zombies under pressure). killInstance()
  // removes these listeners before signalling, so this only runs on real deaths.
  const reapCrashedBrowser = () => {
    const userDataDir = resolveUserDataDir(instanceKey);
    killBrowserProcsForUserDataDir(userDataDir);
    cleanSingletonFiles(userDataDir);
  };

  proc.once("error", (err) => {
    logger.error({ err, instanceKey }, "Playwright MCP error");
    if (instances.get(instanceKey)?.process === proc) {
      releasePort(port);
      instances.delete(instanceKey);
      reapCrashedBrowser();
    }
  });

  proc.once("exit", (code) => {
    logger.info({ instanceKey, code }, "Playwright MCP exited");
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
      _onPlaywrightExit?.(instanceKey, code);
    }
  });

  const now = Date.now();
  instances.set(instanceKey, {
    process: proc,
    port,
    userId,
    startedAt: now,
    lastUsedAt: now,
    capability,
  });

  const ready = await Promise.race([
    (async () =>
      (await waitForServer(port, 10_000)) && (await supportsOwnerCleanup(port, capability)))(),
    spawnError,
  ]);
  if (!ready) {
    const exitCode = proc.exitCode;
    killInstance(instanceKey);
    if (allowFallback && browserBin !== PATCHRIGHT_MCP_BIN) {
      logger.warn(
        { instanceKey, browserBin, fallback: PATCHRIGHT_MCP_BIN },
        "Preferred browser MCP unavailable or lacks owner isolation; using Patchright fallback",
      );
      return spawnPlaywright(instanceKey, userId, undefined, PATCHRIGHT_MCP_BIN, false);
    }
    throw new Error(
      `Playwright MCP failed health check after spawn on port ${port}` +
        (exitCode === null ? "" : ` (exitCode=${exitCode})`),
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
  const instanceKey = makeInstanceKey(userId, topic);

  // If a spawn/restart is already in progress for this key, wait for it
  const inProgress = spawning.get(instanceKey);
  if (inProgress) {
    const port = await inProgress;
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

    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      if (await isHealthy(existing.port)) {
        existing.lastUsedAt = Date.now();
        return existing.port;
      }
      logger.warn({ instanceKey }, "Playwright MCP unresponsive, restarting");
      const oldPort = existing.port;
      killInstance(instanceKey);
      await waitForPortRelease(oldPort);
      cleanSingletonFiles(resolveUserDataDir(instanceKey));
    } else if (existing) {
      releasePort(existing.port);
      instances.delete(instanceKey);
      cleanSingletonFiles(resolveUserDataDir(instanceKey));
    }

    return spawnPlaywright(instanceKey, userId);
  })().finally(() => spawning.delete(instanceKey));
  spawning.set(instanceKey, promise);
  return promise;
}

async function waitForPortRelease(port: number, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPortInUse(port)) return;
    await delay(200);
  }
}

/** Start or reuse a named shared profile before assigning more topics to it. */
export async function ensureBrowserProfile(ownerId: string, rawProfile: string): Promise<number> {
  const instanceKey = makeBrowserProfileInstanceKey(ownerId, rawProfile);
  const inProgress = spawning.get(instanceKey);
  if (inProgress) {
    const port = await inProgress;
    if (port !== null && (await isHealthy(port))) return port;
    if (port === null) return ensureBrowserProfile(ownerId, rawProfile);
    throw new Error(`Browser profile "${rawProfile}" failed to start.`);
  }

  const promise = (async (): Promise<number> => {
    const publishedPort = readPortFile(instanceKey);
    const existing = instances.get(instanceKey);
    if (publishedPort !== null && !existing) {
      // A port file without an in-memory instance belongs to a previous runtime.
      // Its per-process capability and ChildProcess handle cannot be recovered,
      // so adopting it would bypass owner cleanup and lifecycle tracking. Reap
      // only the browser serving this exact profile, then spawn a tracked one.
      logger.warn(
        { instanceKey, publishedPort },
        "Recycling untracked browser profile process from stale port file",
      );
      await killPlaywrightOnPort(publishedPort, resolveUserDataDir(instanceKey));
      await waitForPortRelease(publishedPort);
      deletePortFile(instanceKey);
    }

    if (existing && !existing.process.killed && existing.process.exitCode === null) {
      if (await isHealthy(existing.port)) {
        existing.lastUsedAt = Date.now();
        return existing.port;
      }
      const oldPort = existing.port;
      killInstance(instanceKey);
      await waitForPortRelease(oldPort);
      cleanSingletonFiles(resolveUserDataDir(instanceKey));
    }
    const port = await spawnPlaywright(instanceKey, ownerId);
    if (!(await isHealthy(port))) {
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
  const instanceKey = makeBrowserProfileInstanceKey(ownerId, rawProfile);
  const inProgress = spawning.get(instanceKey);
  if (inProgress) await inProgress;
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
async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isHealthy(port)) return true;
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
    const dstDir = resolveProfileDir(dstOwner, getTopicBrowserProfile(opts.dstTopic));
    return {
      copied: false,
      srcDir: resolveProfileDir(srcOwner, getTopicBrowserProfile(opts.srcTopic)),
      dstDir,
      reason: "cross-owner-fresh-profile",
    };
  }
  if (srcOwner === dstOwner && hasBrowserProfileTopic(opts.dstTopic)) {
    const profile = getTopicBrowserProfile(opts.srcTopic);
    assignTopicBrowserProfile({ topicId: opts.dstTopic, actorUserId: dstOwner, profile });
    const sharedDir = resolveProfileDir(srcOwner, profile);
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
      reapOrphanBrowsers([...instances.keys()].map(resolveUserDataDir));
    } catch (e) {
      logger.debug({ err: e }, "reapOrphanBrowsers sweep failed");
    }
  },
  30 * 60 * 1000,
).unref();
