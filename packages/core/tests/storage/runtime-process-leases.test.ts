import { afterEach, describe, expect, test } from "bun:test";
import { db } from "#storage/forum-db";
import {
  acquireRuntimeProcessLease,
  getRuntimeProcessLease,
  PROCESS_LEASE_STALE_MS,
  removeDeadRuntimeProcessLeases,
  waitForRequiredRuntimeProcessLease,
  waitForRuntimeProcessLease,
} from "#storage/runtime-process-leases";

const handles: Array<{ stop(): void }> = [];
// Killed even when a test fails before its own kill: a leaked owner process
// otherwise outlives the whole `bun test` run.
const children: Array<{ kill(signal?: number | NodeJS.Signals): void }> = [];

function spawnOwner() {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 60_000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  return child;
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const handle of handles.splice(0)) handle.stop();
});

describe("runtime process leases", () => {
  test("allows one live process per role", () => {
    const role = `adapter:test:${crypto.randomUUID()}`;
    const first = acquireRuntimeProcessLease(role, { ownerId: "owner-a", heartbeatMs: 60_000 });
    if (first) handles.push(first);

    expect(first).not.toBeNull();
    expect(
      acquireRuntimeProcessLease(role, { ownerId: "owner-b", heartbeatMs: 60_000 }),
    ).toBeNull();
    expect(getRuntimeProcessLease(role)?.ownerId).toBe("owner-a");
  });

  test("reclaims a role after the previous heartbeat becomes stale", () => {
    const role = `adapter:test:${crypto.randomUUID()}`;
    const old = Date.now() - PROCESS_LEASE_STALE_MS - 1;
    const first = acquireRuntimeProcessLease(role, {
      ownerId: "owner-old",
      now: old,
      heartbeatMs: 60_000,
    });
    if (first) handles.push(first);
    const replacement = acquireRuntimeProcessLease(role, {
      ownerId: "owner-new",
      heartbeatMs: 60_000,
    });
    if (replacement) handles.push(replacement);

    expect(replacement).not.toBeNull();
    expect(getRuntimeProcessLease(role)?.ownerId).toBe("owner-new");
    first?.stop();
    expect(getRuntimeProcessLease(role)?.ownerId).toBe("owner-new");
  });

  test("releases its role when stopped", () => {
    const role = `adapter:test:${crypto.randomUUID()}`;
    const lease = acquireRuntimeProcessLease(role, { heartbeatMs: 60_000 });
    expect(lease).not.toBeNull();
    lease?.stop();
    expect(getRuntimeProcessLease(role)).toBeNull();
  });

  test("immediately reclaims a fresh lease whose owner process has exited", async () => {
    const role = `adapter:test:${crypto.randomUUID()}`;
    const child = spawnOwner();
    const first = acquireRuntimeProcessLease(role, {
      ownerId: "owner-crashed",
      pid: child.pid,
      heartbeatMs: 60_000,
    });
    if (first) handles.push(first);
    expect(first).not.toBeNull();

    child.kill("SIGKILL");
    await child.exited;
    const replacement = acquireRuntimeProcessLease(role, {
      ownerId: "owner-restarted",
      heartbeatMs: 60_000,
    });
    if (replacement) handles.push(replacement);

    expect(replacement).not.toBeNull();
    expect(getRuntimeProcessLease(role)?.ownerId).toBe("owner-restarted");
  });

  test("sweeps dead prefixed leases without removing live owners", async () => {
    const prefix = `ask-user-gate:test:${crypto.randomUUID()}:`;
    const child = spawnOwner();
    const dead = acquireRuntimeProcessLease(`${prefix}dead`, {
      ownerId: `dead-${crypto.randomUUID()}`,
      pid: child.pid,
      heartbeatMs: 60_000,
    });
    const live = acquireRuntimeProcessLease(`${prefix}live`, {
      ownerId: `live-${crypto.randomUUID()}`,
      heartbeatMs: 60_000,
    });
    if (dead) handles.push(dead);
    if (live) handles.push(live);
    child.kill("SIGKILL");
    await child.exited;

    expect(removeDeadRuntimeProcessLeases(prefix)).toBe(1);
    expect(getRuntimeProcessLease(`${prefix}dead`)).toBeNull();
    expect(getRuntimeProcessLease(`${prefix}live`)?.ownerId).toBe(live?.ownerId);
  });

  test("waits for a fresh lease to become stale before acquiring it", async () => {
    const role = `adapter:test:${crypto.randomUUID()}`;
    const first = acquireRuntimeProcessLease(role, {
      ownerId: "owner-stopping",
      staleMs: 30,
      heartbeatMs: 60_000,
    });
    if (first) handles.push(first);

    const replacement = await waitForRuntimeProcessLease(role, {
      ownerId: "owner-restarted",
      staleMs: 30,
      heartbeatMs: 60_000,
      waitMs: 100,
      retryMs: 5,
    });
    if (replacement) handles.push(replacement);

    expect(replacement).not.toBeNull();
    expect(getRuntimeProcessLease(role)?.ownerId).toBe("owner-restarted");
  });

  test("a failing heartbeat write never throws from its timer; it is lost after staleMs", async () => {
    // Regression (CI run 36156534788): the heartbeat ran unguarded in
    // setInterval, so a SQLite error became an uncaught exception from a timer
    // (a daemon crash; a hung `bun test` on Bun 1.2.15).
    const role = `adapter:test:${crypto.randomUUID()}`;
    let lost = 0;
    const lease = acquireRuntimeProcessLease(role, {
      ownerId: "owner-io-error",
      staleMs: 80,
      heartbeatMs: 10,
      onLost: () => {
        lost += 1;
      },
    });
    if (lease) handles.push(lease);
    expect(lease).not.toBeNull();
    const trigger = `inject_heartbeat_failure_${crypto.randomUUID().replaceAll("-", "")}`;
    db.exec(
      `CREATE TEMP TRIGGER ${trigger} BEFORE UPDATE ON runtime_process_leases
       WHEN NEW.role = '${role}' BEGIN SELECT RAISE(ABORT, 'injected heartbeat failure'); END`,
    );
    try {
      await Bun.sleep(40);
      expect(lost).toBe(0); // transient: still within staleMs
      const deadline = Date.now() + 2_000;
      while (lost === 0 && Date.now() < deadline) await Bun.sleep(10);
      expect(lost).toBe(1);
    } finally {
      db.exec(`DROP TRIGGER IF EXISTS temp.${trigger}`);
    }
  });

  test("notifies the old workload after a stale lease is replaced", async () => {
    const role = `adapter:test:${crypto.randomUUID()}`;
    let lost = 0;
    const first = acquireRuntimeProcessLease(role, {
      ownerId: "owner-old",
      now: Date.now() - PROCESS_LEASE_STALE_MS - 1,
      heartbeatMs: 5,
      onLost: () => {
        lost += 1;
      },
    });
    if (first) handles.push(first);
    const replacement = acquireRuntimeProcessLease(role, {
      ownerId: "owner-new",
      heartbeatMs: 60_000,
    });
    if (replacement) handles.push(replacement);

    await Bun.sleep(20);
    expect(lost).toBe(1);
    expect(getRuntimeProcessLease(role)?.ownerId).toBe("owner-new");
  });

  test("reports the current process when a required role is unavailable", async () => {
    const role = `adapter:test:${crypto.randomUUID()}`;
    const first = acquireRuntimeProcessLease(role, {
      ownerId: "owner-a",
      heartbeatMs: 60_000,
    });
    if (first) handles.push(first);

    await expect(
      waitForRequiredRuntimeProcessLease(role, {
        ownerId: "owner-b",
        waitMs: 0,
        workloadName: "Test adapter",
      }),
    ).rejects.toThrow(`Test adapter is already running (pid ${process.pid})`);
  });
});
