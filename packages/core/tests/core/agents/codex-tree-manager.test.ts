import { describe, expect, test } from "bun:test";
import { type CodexTreeHost, createCodexTreeManager } from "#agents/codex-tree-manager";

function fixture() {
  const children = new Map<number, number[]>([
    [1, [10]],
    [10, [11]],
  ]);
  const names = new Map<number, string>([
    [10, "codex"],
    [11, "mcp-server"],
  ]);
  const starts = new Map<number, string>([
    [10, "a"],
    [11, "b"],
  ]);
  const alive = new Set([10, 11]);
  const signals: Array<[number, 0 | "SIGTERM" | "SIGKILL"]> = [];
  const host: CodexTreeHost = {
    parentPid: 1,
    getDirectChildren: (pid) => children.get(pid) ?? [],
    getProcessName: (pid) => names.get(pid) ?? "",
    getProcessStart: (pid) => starts.get(pid) ?? "",
    kill(pid, signal) {
      if (!alive.has(pid)) throw new Error("dead");
      signals.push([pid, signal]);
      if (signal === "SIGKILL") alive.delete(pid);
    },
    logger: { warn: () => {} },
  };
  return { host, signals };
}

describe("codex tree manager factory", () => {
  test("keeps ownership and spawn locks isolated per caller", async () => {
    const { host } = fixture();
    const first = createCodexTreeManager(host);
    const second = createCodexTreeManager(host);
    first.registerOwnedPids([10]);
    expect(first.findNewChildren(new Map())).toEqual([]);
    expect(second.findNewChildren(new Map())).toEqual([10]);

    const firstRelease = await first.acquireSpawnLock();
    let secondAcquired = false;
    const waiting = first.acquireSpawnLock().then((release) => {
      secondAcquired = true;
      release();
    });
    await Bun.sleep(1);
    expect(secondAcquired).toBe(false);
    firstRelease();
    await waiting;
    expect(secondAcquired).toBe(true);
  });

  test("signals the captured tree and escalates matching survivors", async () => {
    const { host, signals } = fixture();
    const manager = createCodexTreeManager(host, { sigkillDelayMs: 1 });
    manager.killTrees([10]);
    expect(signals.slice(0, 2)).toEqual([
      [10, "SIGTERM"],
      [11, "SIGTERM"],
    ]);
    await Bun.sleep(10);
    expect(signals).toContainEqual([10, "SIGKILL"]);
    expect(signals).toContainEqual([11, "SIGKILL"]);
  });
});
