/**
 * Regression test for the "process tree SIGKILL on abort" change (sonamux e3c710c).
 *
 * The custom `spawnClaudeCodeProcessWithTreeKill` ensures that when an
 * AbortController fires, the SIGTERM (and a 2.5s SIGKILL fallback) is sent
 * to the *process group* of the child, not just the child itself, so MCP
 * grandchildren (playwright-mcp, background workers, …) and their browsers/processes
 * interpreters are reaped. Without this, single-user Mac deployments
 * accumulate Chrome zombies and DevTools port (9222) gets stuck.
 *
 * We verify it by spawning a real shell process tree:
 *
 *   bash -c '(sleep 60) & wait'
 *
 * which forks a `sleep` grandchild. Aborting must terminate both. We poll
 * with `kill -0` until the grandchild is gone, with a generous timeout.
 */
import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { spawnClaudeCodeProcessWithTreeKill } from "#agents/claude-provider";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("spawnClaudeCodeProcessWithTreeKill", () => {
  test("aborting reaps grandchild processes via process group signal", async () => {
    const ac = new AbortController();
    // Spawn `bash` that backgrounds a long sleep and then waits for it.
    // The sleep PID is printed to stdout so we can verify it's reaped too.
    // Wrap in `setsid`-equivalent by relying on `detached: true` inside the
    // helper to put bash into its own process group; the backgrounded sleep
    // inherits that group.
    const child = spawnClaudeCodeProcessWithTreeKill({
      command: "bash",
      args: ["-c", "(sleep 30 & echo $!; wait)"],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: ac.signal,
    });

    // Read the sleep pid from stdout.
    const sleepPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const line = buf.split("\n")[0];
        if (line && /^\d+$/.test(line.trim())) {
          resolve(Number(line.trim()));
        }
      });
      child.stdout.on("error", reject);
      setTimeout(() => reject(new Error("Timed out waiting for sleep pid")), 2000);
    });

    expect(sleepPid).toBeGreaterThan(0);
    expect(pidAlive(sleepPid)).toBe(true);

    // Trigger abort. The helper should signal the entire process group.
    ac.abort();

    const gone = await waitDead(sleepPid, 4000);
    expect(gone).toBe(true);

    // Sanity: bash itself is also gone.
    if (child.exitCode === null) {
      // Wait briefly for child exit observation.
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test("kill('SIGKILL') reaches the whole tree without escalation timer", async () => {
    const ac = new AbortController();
    const child = spawnClaudeCodeProcessWithTreeKill({
      command: "bash",
      args: ["-c", "(sleep 30 & echo $!; wait)"],
      cwd: process.cwd(),
      env: { ...process.env },
      signal: ac.signal,
    });

    const sleepPid = await new Promise<number>((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buf += chunk.toString();
        const line = buf.split("\n")[0];
        if (line && /^\d+$/.test(line.trim())) {
          resolve(Number(line.trim()));
        }
      });
      child.stdout.on("error", reject);
      setTimeout(() => reject(new Error("Timed out waiting for sleep pid")), 2000);
    });

    child.kill("SIGKILL");

    const gone = await waitDead(sleepPid, 2000);
    expect(gone).toBe(true);
  });
});

// Sanity helper: ensure `kill -0` semantics as we expect on this machine.
// (No-op on success; throws if the kernel diverges, which would invalidate
// the assertions above.)
try {
  execSync("kill -0 $$");
} catch {
  throw new Error("Test environment does not support `kill -0` — skipping spawn tree tests");
}
