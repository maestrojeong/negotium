import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

/** Select an idle instance while excluding active borrowers and lifecycle work. */
export function selectIdleEvictionKey(
  candidates: Iterable<[string, { lastUsedAt: number }]>,
  pinnedKeys: Iterable<string>,
  busyKeys: Iterable<string>,
  now: number,
  maxIdleMs: number,
): string | null {
  const pinned = new Set(pinnedKeys);
  const busy = new Set(busyKeys);
  let oldest: { key: string; lastUsedAt: number } | null = null;
  for (const [key, instance] of candidates) {
    if (pinned.has(key) || busy.has(key)) continue;
    if (now - instance.lastUsedAt < maxIdleMs) continue;
    if (!oldest || instance.lastUsedAt < oldest.lastUsedAt) {
      oldest = { key, lastUsedAt: instance.lastUsedAt };
    }
  }
  return oldest?.key ?? null;
}

/** Select a currently unreserved and unoccupied port without mutating state. */
export function selectReusablePort(
  minPort: number,
  maxPort: number,
  reservedPorts: ReadonlySet<number>,
  isOccupied: (port: number) => boolean,
): number | null {
  for (let port = minPort; port <= maxPort; port++) {
    if (reservedPorts.has(port) || isOccupied(port)) continue;
    return port;
  }
  return null;
}

/** Parse space- and equals-style `--user-data-dir` process arguments. */
export function extractUserDataDirArg(cmdline: string): string | null {
  const match = cmdline.match(/--user-data-dir(?:\s+|=)(\S+)/);
  return match ? match[1] : null;
}

/** Require positive command-line proof before killing a profile-scoped process. */
export function browserProcessMatchesExpectedProfile(
  cmdline: string,
  expectedUserDataDir: string,
): boolean {
  const actualUserDataDir = extractUserDataDirArg(cmdline);
  return actualUserDataDir !== null && resolve(actualUserDataDir) === resolve(expectedUserDataDir);
}

/** Wait for an actual process exit; ChildProcess.killed only means a signal was sent. */
export function waitForChildProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);

  return new Promise<boolean>((resolveWait) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.off("exit", onExit);
      resolveWait(exited);
    };
    const onExit = () => finish(true);

    proc.once("exit", onExit);
    timer = setTimeout(() => finish(proc.exitCode !== null || proc.signalCode !== null), timeoutMs);
    if (typeof timer === "object") timer.unref?.();

    // Close the gap between the initial state check and listener registration.
    if (proc.exitCode !== null || proc.signalCode !== null) finish(true);
  });
}

/** Reject immediately when the OS cannot launch a child process. */
export function waitForChildProcessSpawnError(proc: Pick<ChildProcess, "once">): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    proc.once("error", reject);
  });
}
