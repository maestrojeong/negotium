export interface CodexTreeLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface CodexTreeHost {
  parentPid: number;
  getDirectChildren(parentPid: number): number[];
  getProcessName(pid: number): string;
  getProcessStart(pid: number): string;
  kill(pid: number, signal: 0 | "SIGTERM" | "SIGKILL"): void;
  logger: CodexTreeLogger;
}

export interface CodexTreeManagerOptions {
  sigkillDelayMs?: number;
  treeDepthCap?: number;
  processNamePattern?: RegExp;
}

export interface CodexTreeManager {
  snapshotChildren(): Map<number, string>;
  findNewChildren(baseline: Map<number, string>): number[];
  registerOwnedPids(pids: Iterable<number>): void;
  unregisterOwnedPids(pids: Iterable<number>): void;
  acquireSpawnLock(): Promise<() => void>;
  withSpawnSerial<T>(fn: () => Promise<T>): Promise<T>;
  killTrees(rootPids: number[]): void;
  killOwnedTreesForShutdown(graceMs?: number): Promise<void>;
}

type KillPlan = {
  rootPids: number[];
  targets: Map<number, string>;
};

/** Caller-owned Codex process tracker and tree reaper. */
export function createCodexTreeManager(
  host: CodexTreeHost,
  options: CodexTreeManagerOptions = {},
): CodexTreeManager {
  const sigkillDelayMs = options.sigkillDelayMs ?? 5_000;
  const treeDepthCap = options.treeDepthCap ?? 16;
  const processNamePattern = options.processNamePattern ?? /codex/i;
  const ownedPids = new Set<number>();
  let spawnChain: Promise<void> = Promise.resolve();

  function collectTree(rootPid: number, out = new Set<number>(), depth = 0): Set<number> {
    if (out.has(rootPid)) return out;
    out.add(rootPid);
    if (depth >= treeDepthCap) {
      host.logger.warn(
        { rootPid, depth, cap: treeDepthCap },
        "codex-tree-kill: tree depth cap reached, descendants beyond this point not collected",
      );
      return out;
    }
    for (const child of host.getDirectChildren(rootPid)) {
      collectTree(child, out, depth + 1);
    }
    return out;
  }

  function snapshotChildren(): Map<number, string> {
    const snapshot = new Map<number, string>();
    for (const pid of host.getDirectChildren(host.parentPid)) {
      const name = host.getProcessName(pid);
      if (!name || !processNamePattern.test(name)) continue;
      snapshot.set(pid, host.getProcessStart(pid));
    }
    return snapshot;
  }

  function registerOwnedPids(pids: Iterable<number>): void {
    for (const pid of pids) ownedPids.add(pid);
  }

  function unregisterOwnedPids(pids: Iterable<number>): void {
    for (const pid of pids) ownedPids.delete(pid);
  }

  function findNewChildren(baseline: Map<number, string>): number[] {
    const novel: number[] = [];
    for (const [pid, start] of snapshotChildren()) {
      const previousStart = baseline.get(pid);
      if (previousStart !== undefined && previousStart === start) continue;
      if (!ownedPids.has(pid)) novel.push(pid);
    }
    return novel;
  }

  async function acquireSpawnLock(): Promise<() => void> {
    const previous = spawnChain;
    let release!: () => void;
    let released = false;
    spawnChain = new Promise<void>((resolve) => {
      release = () => {
        if (released) return;
        released = true;
        resolve();
      };
    });
    await previous;
    return release;
  }

  async function withSpawnSerial<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireSpawnLock();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function isAlive(pid: number): boolean {
    try {
      host.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function isSameProcess(pid: number, start: string): boolean {
    return start !== "" && isAlive(pid) && host.getProcessStart(pid) === start;
  }

  function signalTrees(rootPids: number[]): KillPlan | null {
    if (rootPids.length === 0) return null;
    const targets = new Map<number, string>();
    for (const rootPid of rootPids) {
      for (const pid of collectTree(rootPid)) {
        if (!targets.has(pid)) targets.set(pid, host.getProcessStart(pid));
      }
    }
    host.logger.warn(
      { rootPids, totalPids: targets.size },
      "codex-tree-kill: SIGTERM process tree",
    );
    for (const pid of targets.keys()) {
      try {
        host.kill(pid, "SIGTERM");
      } catch {
        // The process already exited or is no longer signalable.
      }
    }
    return { rootPids, targets };
  }

  function hasSurvivors(targets: Map<number, string>): boolean {
    for (const [pid, start] of targets) {
      if (isSameProcess(pid, start)) return true;
    }
    return false;
  }

  function killStragglers(plan: KillPlan): void {
    const aliveTargets: number[] = [];
    let droppedAsPossibleReuse = 0;
    for (const [pid, start] of plan.targets) {
      if (isSameProcess(pid, start)) aliveTargets.push(pid);
      else if (isAlive(pid)) droppedAsPossibleReuse++;
    }
    if (aliveTargets.length === 0) return;

    const reachable = new Set(aliveTargets);
    for (const rootPid of plan.rootPids) {
      const start = plan.targets.get(rootPid);
      if (start && isSameProcess(rootPid, start)) {
        for (const pid of collectTree(rootPid)) reachable.add(pid);
      }
    }
    const stragglers: number[] = [];
    for (const pid of reachable) {
      const start = plan.targets.get(pid);
      if (start && isSameProcess(pid, start)) stragglers.push(pid);
      else if (isAlive(pid)) droppedAsPossibleReuse++;
    }
    host.logger.warn(
      {
        aliveRoots: plan.rootPids.filter((pid) => {
          const start = plan.targets.get(pid);
          return start ? isSameProcess(pid, start) : false;
        }),
        totalStragglers: stragglers.length,
        droppedAsPossibleReuse,
      },
      "codex-tree-kill: SIGKILL fallback after SIGTERM timeout",
    );
    for (const pid of stragglers) {
      try {
        host.kill(pid, "SIGKILL");
      } catch {
        // The process exited during the survivor check.
      }
    }
  }

  function killTrees(rootPids: number[]): void {
    const plan = signalTrees(rootPids);
    if (!plan) return;
    const timer = setTimeout(() => killStragglers(plan), sigkillDelayMs);
    timer.unref?.();
  }

  async function killOwnedTreesForShutdown(graceMs = 3_000): Promise<void> {
    const roots = new Set(ownedPids);
    for (const pid of snapshotChildren().keys()) roots.add(pid);
    const plan = signalTrees([...roots]);
    if (!plan) return;
    const deadline = Date.now() + Math.max(0, graceMs);
    while (Date.now() < deadline && hasSurvivors(plan.targets)) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))),
      );
    }
    killStragglers(plan);
  }

  return {
    snapshotChildren,
    findNewChildren,
    registerOwnedPids,
    unregisterOwnedPids,
    acquireSpawnLock,
    withSpawnSerial,
    killTrees,
    killOwnedTreesForShutdown,
  };
}
