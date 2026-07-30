import { execFileSync } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, sep } from "node:path";
import { BROWSER_PROFILES_DIR } from "#platform/config";
import { logger } from "#platform/logger";
import { extractUserDataDirArg } from "#platform/playwright/manager-utils";
import { getRuntimeProcessLease } from "#storage/runtime-process-leases";

export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const server = createServer();
    let settled = false;
    const finish = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      resolveProbe(occupied);
    };

    server.unref();
    server.once("error", () => finish(true));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close((error) => finish(error !== undefined));
    });
  });
}

export async function reserveAvailableLoopbackPort(
  minPort: number,
  maxPort: number,
  reservedPorts: Set<number>,
  probeOccupied: (port: number) => Promise<boolean> = isPortInUse,
): Promise<number | null> {
  for (let port = minPort; port <= maxPort; port++) {
    if (reservedPorts.has(port)) continue;
    reservedPorts.add(port);
    if (await probeOccupied(port)) {
      reservedPorts.delete(port);
      continue;
    }
    return port;
  }
  return null;
}

/**
 * Kill all leftover browser-MCP processes from previous bot runs. The gateway
 * may own a Browser.rs child, so match both layers plus the legacy server.
 */
export function cleanupZombiePlaywright(): void {
  try {
    const pids = execFileSync(
      "pgrep",
      ["-f", "mcp-patchright-http\\.mjs|browser-rs|playwright-mcp"],
      {
        stdio: "pipe",
      },
    )
      .toString()
      .trim();
    if (pids) {
      logger.info({ pids: pids.replace(/\n/g, ", ") }, "Cleaning up zombie browser-MCP processes");
      for (const pid of pids.split("\n")) {
        const pidNum = parseInt(pid.trim(), 10);
        if (!Number.isNaN(pidNum)) {
          try {
            const cmdline = execFileSync("ps", ["-p", String(pidNum), "-o", "command="], {
              stdio: "pipe",
            })
              .toString()
              .trim();
            const userDataDir = extractUserDataDirArg(cmdline);
            const resolvedProfilesDir = resolve(BROWSER_PROFILES_DIR);
            const resolvedUserDataDir = userDataDir ? resolve(userDataDir) : undefined;
            const isManagedProfile =
              resolvedUserDataDir === resolvedProfilesDir ||
              resolvedUserDataDir?.startsWith(`${resolvedProfilesDir}${sep}`);
            if (!isManagedProfile) {
              logger.warn(
                { pid: pidNum, userDataDir },
                "Skipping browser-MCP cleanup outside Otium browser profile dir",
              );
              continue;
            }
            // Reap Chrome children before the node parent.
            killProcessTreeChildren(pidNum);
            process.kill(pidNum, "SIGKILL");
          } catch (e) {
            logger.warn({ err: e, pid: pidNum }, "Failed to kill leftover browser-MCP process");
          }
        }
      }
    }
  } catch {
    // No processes found — good
  }
}

/**
 * Kill any browser process (the node MCP or the Chrome it launched) still
 * holding a specific user-data-dir. Used on the crash-exit path: once the MCP
 * parent dies on its own, its Chrome subtree reparents to init, so `pgrep -P`
 * can no longer find it — but the Chrome browser process still carries
 * `--user-data-dir <path>` in argv, so we match on the path instead. Bounded to
 * Otium's profile dir so unrelated Chrome is never touched.
 */
export function killBrowserProcsForUserDataDir(userDataDir: string): void {
  const target = resolve(userDataDir);
  const profileRoot = resolve(BROWSER_PROFILES_DIR);
  if (target !== profileRoot && !target.startsWith(`${profileRoot}${sep}`)) return;
  let pids: string;
  try {
    pids = execFileSync("pgrep", ["-f", "--", userDataDir], { stdio: "pipe" }).toString().trim();
  } catch {
    return; // no matches
  }
  if (!pids) return;
  for (const pid of pids.split("\n")) {
    const pidNum = parseInt(pid.trim(), 10);
    if (Number.isNaN(pidNum) || pidNum === process.pid) continue;
    try {
      const cmdline = execFileSync("ps", ["-p", String(pidNum), "-o", "command="], {
        stdio: "pipe",
      })
        .toString()
        .trim();
      const argDir = extractUserDataDirArg(cmdline);
      // Only the process that actually owns this exact profile dir; renderer
      // grandchildren carry no --user-data-dir and are reaped via the tree walk.
      if (!argDir || resolve(argDir) !== target) continue;
      killProcessTreeChildren(pidNum);
      process.kill(pidNum, "SIGKILL");
      logger.info({ pid: pidNum, userDataDir }, "Reaped orphaned browser process by user-data-dir");
    } catch (e) {
      logger.debug({ err: e, pid: pidNum, userDataDir }, "Failed to reap browser proc by dir");
    }
  }
}

/**
 * Pure orphan selection: given browser processes tagged with their
 * `--user-data-dir`, the set of dirs owned by live tracked instances, and the
 * profile root, return the pids to reap — those under our profile dir whose
 * owning instance is no longer tracked (a dead MCP's leftover Chrome, or a
 * stale MCP from a previous run). Exported for unit tests.
 */
export function selectOrphanBrowserPids(
  procs: Array<{ pid: number; userDataDir: string | null }>,
  liveUserDataDirs: Iterable<string>,
  profileRoot: string,
  selfPid: number,
): number[] {
  const root = resolve(profileRoot);
  const live = new Set([...liveUserDataDirs].map((d) => resolve(d)));
  const out: number[] = [];
  for (const { pid, userDataDir } of procs) {
    if (pid === selfPid || !userDataDir) continue;
    const dir = resolve(userDataDir);
    if (dir !== root && !dir.startsWith(`${root}${sep}`)) continue;
    if (live.has(dir)) continue; // belongs to a tracked instance
    out.push(pid);
  }
  return out;
}

/**
 * The browser process table is shared across every Negotium process, while the
 * in-memory `instances` map is not. Only the current node-daemon lease owner may
 * compare those two views and reap untracked browsers. Otherwise an old daemon
 * that survived shutdown can mistake the replacement daemon's browser for an
 * orphan and kill it.
 */
export function isBrowserJanitorOwner(leaseOwnerPid: number | null, selfPid: number): boolean {
  return leaseOwnerPid === selfPid;
}

/**
 * Periodic sweep that reaps orphaned browser processes the tracked-instance map
 * has lost sight of. The 30-min idle eviction only touches instances still in
 * the map; when an MCP dies on its own its Chrome escapes the map entirely, so
 * without this nothing reclaims it until the next process restart. Cascading
 * orphans under memory pressure are exactly this failure mode.
 */
export function reapOrphanBrowsers(liveUserDataDirs: Iterable<string>): void {
  // Use an infinite stale window here intentionally: even if the active daemon
  // briefly misses a heartbeat, the recorded owner remains the only process
  // allowed to run this destructive cross-process sweep.
  const daemonLease = getRuntimeProcessLease("node-daemon", Date.now(), Number.POSITIVE_INFINITY);
  if (!isBrowserJanitorOwner(daemonLease?.pid ?? null, process.pid)) return;

  const profileRoot = resolve(BROWSER_PROFILES_DIR);
  let pids: string;
  try {
    pids = execFileSync("pgrep", ["-f", "--", profileRoot], { stdio: "pipe" }).toString().trim();
  } catch {
    return; // no browser processes at all
  }
  if (!pids) return;

  const procs: Array<{ pid: number; userDataDir: string | null }> = [];
  for (const pid of pids.split("\n")) {
    const pidNum = parseInt(pid.trim(), 10);
    if (Number.isNaN(pidNum)) continue;
    try {
      const cmdline = execFileSync("ps", ["-p", String(pidNum), "-o", "command="], {
        stdio: "pipe",
      })
        .toString()
        .trim();
      procs.push({ pid: pidNum, userDataDir: extractUserDataDirArg(cmdline) });
    } catch {
      // Process vanished between pgrep and ps — nothing to reap.
    }
  }

  const orphanPids = selectOrphanBrowserPids(procs, liveUserDataDirs, profileRoot, process.pid);
  for (const pid of orphanPids) {
    try {
      killProcessTreeChildren(pid);
      process.kill(pid, "SIGKILL");
      logger.info({ pid }, "Reaped orphaned browser process (janitor)");
    } catch (e) {
      logger.debug({ err: e, pid }, "Janitor failed to reap orphaned browser process");
    }
  }
}

/**
 * Health check — can we reach the SSE endpoint?
 */
export async function isHealthy(port: number): Promise<boolean> {
  for (const path of ["/health", "/sse?owner=__negotium_health__"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(2000),
      });
      await res.body?.cancel();
      if (res.ok) return true;
    } catch {
      // Try the transport endpoint when this runtime has no /health route.
    }
  }
  return false;
}

/**
 * Clean up Chrome Singleton files (SingletonLock, SingletonSocket, SingletonCookie)
 * in a user data directory. These stale files prevent browser relaunch after crash.
 */
export function cleanSingletonFiles(userDataDir: string): void {
  try {
    const files = readdirSync(userDataDir);
    for (const f of files) {
      if (f.startsWith("Singleton")) {
        try {
          unlinkSync(resolve(userDataDir, f));
          logger.info({ file: f, userDataDir }, "Removed stale Singleton file");
        } catch (e) {
          logger.warn({ err: e, file: f }, "Failed to remove stale Chrome Singleton file");
        }
      }
    }
  } catch {
    // Directory may not exist
  }
}

/**
 * Kill the full process subtree spawned by a Playwright MCP instance.
 *
 * Chrome fans out into zygote/renderer/gpu grandchildren, so killing only
 * direct children leaves orphaned Chrome processes after retries/aborts. Walk
 * the tree before signaling so descendants are still discoverable.
 */
export function killProcessTreeChildren(pid: number): void {
  try {
    const children = execFileSync("pgrep", ["-P", String(pid)], { stdio: "pipe" })
      .toString()
      .trim();
    if (!children) return;
    const childPids = children
      .split("\n")
      .map((cpid) => parseInt(cpid, 10))
      .filter((pidNum) => !Number.isNaN(pidNum));

    for (const childPid of childPids) {
      killProcessTreeChildren(childPid);
    }

    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const childPid of childPids) {
        try {
          process.kill(childPid, signal);
        } catch (e) {
          logger.debug({ err: e, pid: childPid, signal }, "Failed to signal browser child process");
        }
      }
    }
    logger.info({ parentPid: pid, childPids }, "Killed browser-MCP child process tree");
  } catch {
    // No children found — fine
  }
}
