import { afterEach, describe, expect, test } from "bun:test";
import {
  acquireRuntimeProcessLease,
  getRuntimeProcessLease,
  PROCESS_LEASE_STALE_MS,
} from "#storage/runtime-process-leases";

const handles: Array<{ stop(): void }> = [];

afterEach(() => {
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
});
