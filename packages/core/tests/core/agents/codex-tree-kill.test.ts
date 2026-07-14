import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  acquireCodexSpawnLock,
  findNewCodexChildren,
  killCodexTrees,
  registerOwnedCodexPids,
  snapshotCodexChildren,
  unregisterOwnedCodexPids,
  withCodexSpawnSerial,
} from "#agents/codex-tree-kill";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until predicate is true or `timeoutMs` elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 3000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

describe("codex-tree-kill", () => {
  test("snapshotCodexChildren returns a Map (does not throw)", () => {
    const snap = snapshotCodexChildren();
    expect(snap).toBeInstanceOf(Map);
    // We don't have real codex children in the test process, so usually 0,
    // but if the test harness happens to be running codex this is still fine.
    expect(typeof snap.size).toBe("number");
  });

  test("findNewCodexChildren with empty baseline returns array", () => {
    const novel = findNewCodexChildren(new Map());
    expect(Array.isArray(novel)).toBe(true);
  });

  test("killCodexTrees([]) is a no-op and does not throw", () => {
    expect(() => killCodexTrees([])).not.toThrow();
  });

  test("killCodexTrees terminates a real child process tree", async () => {
    // Spawn a parent that spawns a child, so we have a tree to walk.
    // Parent: node sleeps 30s. Child: node sleeps 30s spawned by parent.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        // Spawn a grandchild, then keep parent alive.
        `const cp = require('child_process');
         const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
         console.log(child.pid);
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );

    const parentPid = parent.pid;
    expect(parentPid).toBeDefined();
    if (!parentPid) return;

    // Read grandchild PID from parent's stdout.
    let grandchildPid: number | undefined;
    parent.stdout?.on("data", (buf: Buffer) => {
      grandchildPid = Number(buf.toString().trim());
    });

    // Give parent time to spawn its grandchild.
    await waitFor(() => grandchildPid !== undefined, 2000);
    expect(grandchildPid).toBeDefined();
    if (grandchildPid === undefined) return;
    const gcPid = grandchildPid;

    expect(isAlive(parentPid)).toBe(true);
    expect(isAlive(gcPid)).toBe(true);

    // Kill the tree rooted at parent.
    killCodexTrees([parentPid]);

    // SIGTERM should propagate within ~1s.
    const parentDead = await waitFor(() => !isAlive(parentPid), 3000);
    const grandchildDead = await waitFor(() => !isAlive(gcPid), 3000);

    expect(parentDead).toBe(true);
    expect(grandchildDead).toBe(true);
  }, 10_000);

  test("withCodexSpawnSerial serializes concurrent critical sections", async () => {
    // Track interleaving: if serialized, the events should appear strictly
    // pairwise: A-start, A-end, B-start, B-end (no interleaving).
    const events: string[] = [];

    const work = (label: string, delayMs: number) =>
      withCodexSpawnSerial(async () => {
        events.push(`${label}-start`);
        await sleep(delayMs);
        events.push(`${label}-end`);
        return label;
      });

    // Kick off two "spawn" jobs concurrently.
    const [a, b] = await Promise.all([work("A", 60), work("B", 30)]);
    expect(a).toBe("A");
    expect(b).toBe("B");

    // Strict serialization: every start must be immediately followed by the
    // matching end (no interleaving). The order between A and B doesn't matter
    // as long as they don't overlap.
    expect(events.length).toBe(4);
    expect(events[1]).toBe(`${events[0]?.split("-")[0]}-end`);
    expect(events[3]).toBe(`${events[2]?.split("-")[0]}-end`);
  });

  test("withCodexSpawnSerial releases lock when fn throws", async () => {
    // First caller throws; second caller must still run.
    let secondRan = false;
    await Promise.allSettled([
      withCodexSpawnSerial(async () => {
        await sleep(20);
        throw new Error("first fails");
      }),
      withCodexSpawnSerial(async () => {
        await sleep(5);
        secondRan = true;
      }),
    ]);
    expect(secondRan).toBe(true);
  });

  test("acquireCodexSpawnLock returns idempotent release", async () => {
    // Calling release twice must not double-resolve and break the chain.
    const release1 = await acquireCodexSpawnLock();
    release1();
    release1(); // second call should be a no-op
    // Next acquire must still resolve quickly.
    const t0 = Date.now();
    const release2 = await acquireCodexSpawnLock();
    release2();
    expect(Date.now() - t0).toBeLessThan(100);
  });

  test("acquireCodexSpawnLock serializes across awaits (spans iterator step)", async () => {
    // Simulate codex-provider pattern: acquire → snapshot baseline → await something →
    // diff → release. The B caller must not run snapshot until A releases.
    const events: string[] = [];

    const work = async (label: string) => {
      const release = await acquireCodexSpawnLock();
      try {
        events.push(`${label}-baseline`);
        await sleep(20); // simulates `await runStreamed` + `await iter.next()`
        events.push(`${label}-diff`);
      } finally {
        release();
      }
    };

    await Promise.all([work("A"), work("B")]);

    // Each caller's pair must be contiguous — no interleaving.
    expect(events.length).toBe(4);
    expect(events[1]).toBe(`${events[0]?.split("-")[0]}-diff`);
    expect(events[3]).toBe(`${events[2]?.split("-")[0]}-diff`);
  });

  test("findNewCodexChildren respects globalOwnedCodexPids", () => {
    // Take a snapshot now (whatever it is) as our baseline.
    const baseline = snapshotCodexChildren();

    // No actual codex spawn in this test, so `findNewCodexChildren(baseline)`
    // should be empty. Register some bogus PIDs as owned — even if they show
    // up in a future snapshot, they should be filtered out.
    const bogus = [999_999_001, 999_999_002];
    registerOwnedCodexPids(bogus);
    try {
      const novel = findNewCodexChildren(baseline);
      // Filter out PIDs we registered as owned — they must not appear.
      expect(novel.includes(bogus[0]!)).toBe(false);
      expect(novel.includes(bogus[1]!)).toBe(false);
    } finally {
      unregisterOwnedCodexPids(bogus);
    }
  });

  test("snapshot map carries lstart fingerprints for live PIDs", () => {
    const snap = snapshotCodexChildren();
    // We don't have codex children in tests, so this is usually empty —
    // exercise the path on any incidental entry. Shape check only.
    for (const [pid, lstart] of snap) {
      expect(typeof pid).toBe("number");
      expect(typeof lstart).toBe("string");
    }
    expect(snap).toBeInstanceOf(Map);
  });

  test("killCodexTrees is safe to call on already-dead PIDs", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (!pid) return;

    // Wait for exit.
    await new Promise<void>((r) => child.once("exit", () => r()));
    expect(isAlive(pid)).toBe(false);

    // Should not throw on a dead PID.
    expect(() => killCodexTrees([pid])).not.toThrow();
  });

  test("killCodexTrees SIGKILLs surviving descendants even when root dies fast", async () => {
    // Parent dies on SIGTERM; child ignores SIGTERM and only dies on SIGKILL.
    // The old fallback returned early when root was dead, leaving the child
    // alive. The new fallback (FIX 2) walks `targets` and SIGKILLs survivors.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const cp = require('child_process');
         const child = cp.spawn(process.execPath, ['-e',
           "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
         ]);
         console.log(child.pid);
         // Parent exits on SIGTERM (default).
         setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const parentPid = parent.pid;
    expect(parentPid).toBeDefined();
    if (!parentPid) return;

    let childPid: number | undefined;
    parent.stdout?.on("data", (buf: Buffer) => {
      childPid = Number(buf.toString().trim());
    });

    await waitFor(() => childPid !== undefined, 2000);
    expect(childPid).toBeDefined();
    if (childPid === undefined) return;
    const cPid = childPid;

    expect(isAlive(parentPid)).toBe(true);
    expect(isAlive(cPid)).toBe(true);

    killCodexTrees([parentPid]);

    // Parent dies fast on SIGTERM.
    const parentDead = await waitFor(() => !isAlive(parentPid), 2000);
    expect(parentDead).toBe(true);

    // Child ignores SIGTERM, must wait for SIGKILL after the 5s delay.
    const childDead = await waitFor(() => !isAlive(cPid), 8000);
    expect(childDead).toBe(true);
  }, 15_000);
});
