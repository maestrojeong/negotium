/**
 * Codex process tree kill helper.
 *
 * The @openai/codex-sdk spawns `codex` as a direct child of our bot process but
 * does not expose the resulting PID and does not detach the child into its own
 * process group. So when we call `abortController.abort()`, the SDK sends a
 * single SIGTERM that may or may not reach grandchild tool processes (shells,
 * MCP servers spawned by codex itself). To guarantee abort actually stops
 * activity we identify the codex children we spawned and SIGTERM their whole
 * descendant tree, with a SIGKILL fallback for stragglers.
 *
 * Strategy (post-2026-05-14 fix):
 *   1. Acquire a global spawn lock that's held across the entire window
 *      from baseline snapshot through the first SDK event (when codex is
 *      actually spawned — `runStreamed()` returns a lazy async generator,
 *      so the real `child_process.spawn()` happens on the first iterator
 *      `.next()`, not when `runStreamed()` is awaited).
 *   2. Snapshot direct codex children of `process.pid` BEFORE forcing the
 *      first iterator step.
 *   3. After the first event lands, diff against a fresh snapshot to
 *      identify our PIDs and register them in `globalOwnedCodexPids` so
 *      concurrent codex callers don't claim them as their own.
 *   4. On abort, walk each PID's descendant tree via `pgrep -P` and signal
 *      every node. Unregister on exit.
 *
 * Platform: relies on `pgrep` and `ps` — macOS/Linux only. Windows is not
 * supported (Otium already requires POSIX for the rest of the stack).
 */

import { execFileSync } from "node:child_process";
import { logger } from "#platform/logger";

// 5s gives MCP stdio servers (codex spawns these as grandchildren) a realistic
// shutdown window. 2s was empirically too aggressive: stdio MCP servers in the
// middle of writing a response would get SIGKILL'd before they finished.
const SIGKILL_DELAY_MS = 5_000;
const CODEX_PROC_NAME_MATCH = /codex/i;
// Cap tree-walk depth. Defends against pathological or malicious cycles that
// slip past the visited-set guard (e.g. via PID reuse), and against deeply
// nested codex+MCP+shell trees blowing the stack.
const TREE_DEPTH_CAP = 16;

/** Return direct child PIDs of `parentPid`. Returns [] on error or no children. */
function getDirectChildren(parentPid: number): number[] {
  try {
    const out = execFileSync("pgrep", ["-P", String(parentPid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    // pgrep exits 1 when no matches; treat as empty.
    return [];
  }
}

/** Return the executable name (comm) of a process, or "" if unavailable. */
function getProcName(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Return the start time of `pid` as the raw `ps -o lstart=` string (e.g.
 * "Tue May 12 10:49:35 2026"), or "" if unavailable. Used as a fingerprint
 * to defend against PID reuse — even if the OS reassigns a baseline PID to
 * a fresh codex spawn, the lstart string will differ.
 *
 * macOS and Linux both support `ps -o lstart=` with the same date format.
 */
function getProcLstart(pid: number): string {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** (pid, lstart) fingerprint pair — same PID + same lstart = same process. */
export type CodexProcStamp = { pid: number; lstart: string };

/**
 * Recursively collect `rootPid` and all its descendants, up to `TREE_DEPTH_CAP`
 * levels deep. Cycle-safe via the `out` Set; depth-cap-safe via the `depth`
 * parameter (defends against pathological trees the Set guard might miss,
 * e.g. PID reuse mid-walk).
 */
function collectTree(rootPid: number, out: Set<number> = new Set(), depth = 0): Set<number> {
  if (out.has(rootPid)) return out;
  out.add(rootPid);
  if (depth >= TREE_DEPTH_CAP) {
    logger.warn(
      { rootPid, depth, cap: TREE_DEPTH_CAP },
      "codex-tree-kill: tree depth cap reached, descendants beyond this point not collected",
    );
    return out;
  }
  for (const child of getDirectChildren(rootPid)) {
    collectTree(child, out, depth + 1);
  }
  return out;
}

/**
 * Snapshot current codex-named direct children of `process.pid` along with
 * each PID's lstart (start time) fingerprint. Returning the lstart map lets
 * `findNewCodexChildren` distinguish "PID X was in baseline and is the same
 * process" from "PID X was in baseline but the OS reassigned that PID to a
 * fresh codex" — only the latter is novel.
 */
export function snapshotCodexChildren(): Map<number, string> {
  const out = new Map<number, string>();
  for (const pid of getDirectChildren(process.pid)) {
    const name = getProcName(pid);
    if (!name || !CODEX_PROC_NAME_MATCH.test(name)) continue;
    const lstart = getProcLstart(pid);
    // If lstart can't be read (race: process died between getDirectChildren
    // and getProcLstart), still record the PID with an empty fingerprint —
    // any later snapshot with a real lstart will compare as "different" and
    // count it as novel, which is the safer side to err on.
    out.set(pid, lstart);
  }
  return out;
}

/**
 * PIDs already owned by an active codex caller (normal provider or fork).
 * `findNewCodexChildren` excludes these so concurrent callers can't claim
 * each other's PIDs when their baselines happen to miss them (e.g. the other
 * caller's spawn raced in between baseline and first-event diff).
 *
 * Callers must `registerOwnedCodexPids` after diff, and `unregisterOwnedCodexPids`
 * in their cleanup `finally` block to avoid leaking entries on long-running bots.
 */
const globalOwnedCodexPids = new Set<number>();

export function registerOwnedCodexPids(pids: Iterable<number>): void {
  for (const p of pids) globalOwnedCodexPids.add(p);
}

export function unregisterOwnedCodexPids(pids: Iterable<number>): void {
  for (const p of pids) globalOwnedCodexPids.delete(p);
}

/**
 * Codex children that are novel relative to `baseline`. A PID is novel if:
 *   - it wasn't in baseline, OR
 *   - it was in baseline but with a different lstart (PID reuse — old codex
 *     died and the OS reassigned the PID to our new spawn)
 * AND it isn't already owned by a concurrent codex caller.
 */
export function findNewCodexChildren(baseline: Map<number, string>): number[] {
  const current = snapshotCodexChildren();
  const novel: number[] = [];
  for (const [pid, lstart] of current) {
    const baselineLstart = baseline.get(pid);
    // Same PID + same lstart fingerprint → continuation of the same process,
    // not novel. Same PID + different lstart → PID reuse, treat as novel.
    if (baselineLstart !== undefined && baselineLstart === lstart) continue;
    if (globalOwnedCodexPids.has(pid)) continue;
    novel.push(pid);
  }
  return novel;
}

/**
 * Serialize the spawn critical section across concurrent codex callers
 * (`codexProvider` and `queryCodexForkSession`). The lock MUST be held from
 * baseline snapshot through the first generator event, because the SDK's
 * `runStreamed()` is lazy — the actual `child_process.spawn()` happens when
 * the iterator advances, not when `runStreamed()` resolves. Without a lock
 * spanning that window, two callers see overlapping codex children and
 * mis-attribute them on abort, leading to cross-kills.
 *
 * Only the spawn phase is serialized (typically a few hundred ms — codex's
 * first event lands quickly). The actual LLM streaming after the first event
 * runs concurrently as before.
 */
let codexSpawnChain: Promise<void> = Promise.resolve();

/**
 * Acquire the codex-spawn lock. Returns a release callback. Caller MUST invoke
 * the release callback in a `finally` block (or via the convenience wrapper
 * `withCodexSpawnSerial`) — otherwise the chain stalls indefinitely.
 */
export async function acquireCodexSpawnLock(): Promise<() => void> {
  const prev = codexSpawnChain;
  let release!: () => void;
  let released = false;
  codexSpawnChain = new Promise<void>((r) => {
    release = () => {
      if (released) return;
      released = true;
      r();
    };
  });
  await prev;
  return release;
}

/**
 * Convenience wrapper for short, single-await critical sections. Prefer
 * `acquireCodexSpawnLock` when the lock must span multiple awaits including
 * iterator advancement (the codex spawn case).
 */
export async function withCodexSpawnSerial<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireCodexSpawnLock();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** True iff `pid` is still alive. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff `pid` is alive and still appears to be the same process captured by
 * `lstart`. An empty lstart means we could not fingerprint the original process,
 * so we refuse to SIGKILL it later rather than risk killing a reused PID.
 */
function isSameProcess(pid: number, lstart: string): boolean {
  return lstart !== "" && isAlive(pid) && getProcLstart(pid) === lstart;
}

/**
 * SIGTERM every PID in the descendant tree of each root in `rootPids`, then
 * schedule a SIGKILL fallback after `SIGKILL_DELAY_MS` for any survivors.
 * Safe to call multiple times; no-op if all PIDs are already dead.
 */
export function killCodexTrees(rootPids: number[]): void {
  if (rootPids.length === 0) return;

  // Walk trees once up-front so we have the full target set before SIGTERM
  // shuffles parent/child relationships. Store lstart fingerprints as well so
  // the SIGKILL fallback cannot kill an unrelated process after PID reuse.
  const targets = new Map<number, string>();
  for (const root of rootPids) {
    for (const pid of collectTree(root)) {
      if (!targets.has(pid)) targets.set(pid, getProcLstart(pid));
    }
  }

  logger.warn({ rootPids, totalPids: targets.size }, "codex-tree-kill: SIGTERM process tree");

  for (const pid of targets.keys()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already dead or permission denied
    }
  }

  const killTimer = setTimeout(() => {
    // Survivors must be computed from `targets` (the full SIGTERM set), NOT
    // just `rootPids`. A common case: codex root accepts SIGTERM quickly but
    // an stdio MCP grandchild is mid-write and survives the grace window. The
    // previous root-only check returned early in that case and left the
    // grandchild as a zombie.
    const aliveTargets: number[] = [];
    let droppedAsPossibleReuse = 0;
    for (const [pid, lstart] of targets) {
      if (isSameProcess(pid, lstart)) {
        aliveTargets.push(pid);
      } else if (isAlive(pid)) {
        droppedAsPossibleReuse++;
      }
    }
    if (aliveTargets.length === 0) return;

    // PID-reuse defence: re-walk the trees (children may have spawned siblings
    // mid-SIGTERM), but ONLY signal PIDs that were in the SIGTERM-time `targets`
    // set. Between SIGTERM and SIGKILL_DELAY_MS, an OS may have reused some of
    // those PIDs for unrelated processes — without this intersect we'd
    // SIGKILL them by accident.
    const reachable = new Set<number>(aliveTargets);
    for (const root of rootPids) {
      const rootLstart = targets.get(root);
      if (rootLstart && isSameProcess(root, rootLstart)) {
        for (const pid of collectTree(root)) reachable.add(pid);
      }
    }
    const stragglers: number[] = [];
    for (const pid of reachable) {
      const lstart = targets.get(pid);
      if (lstart && isSameProcess(pid, lstart)) stragglers.push(pid);
      else if (isAlive(pid)) droppedAsPossibleReuse++;
    }
    logger.warn(
      {
        aliveRoots: rootPids.filter((pid) => {
          const lstart = targets.get(pid);
          return lstart ? isSameProcess(pid, lstart) : false;
        }),
        totalStragglers: stragglers.length,
        droppedAsPossibleReuse,
      },
      "codex-tree-kill: SIGKILL fallback after SIGTERM timeout",
    );
    for (const pid of stragglers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }, SIGKILL_DELAY_MS);
  killTimer.unref?.();
}
