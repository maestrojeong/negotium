import { afterEach, describe, expect, test } from "bun:test";
import {
  claimRuntimeTurnLease,
  getRuntimeTurnLease,
  heartbeatRuntimeTurnLease,
  listRuntimeTurnLeases,
  releaseRuntimeTurnLease,
  requestRuntimeTurnAbort,
  TURN_LEASE_STALE_MS,
} from "#storage/runtime-leases";

const topicIds = new Set<string>();

function topicId(): string {
  const id = `lease-${crypto.randomUUID()}`;
  topicIds.add(id);
  return id;
}

afterEach(() => {
  for (const id of topicIds) {
    const lease = getRuntimeTurnLease(id);
    if (lease) releaseRuntimeTurnLease(id, lease.queryId, lease.ownerId);
  }
  topicIds.clear();
});

describe("runtime turn leases", () => {
  test("allows only one process owner per topic", () => {
    const topic = topicId();
    expect(
      claimRuntimeTurnLease({ topicId: topic, queryId: "q-a", origin: "user", ownerId: "a" }),
    ).toBe(true);
    expect(
      claimRuntimeTurnLease({ topicId: topic, queryId: "q-b", origin: "user", ownerId: "b" }),
    ).toBe(false);
    expect(getRuntimeTurnLease(topic)?.queryId).toBe("q-a");
  });

  test("lets a new process reclaim an expired owner", () => {
    const topic = topicId();
    const old = Date.now() - TURN_LEASE_STALE_MS - 1;
    expect(
      claimRuntimeTurnLease(
        { topicId: topic, queryId: "q-old", origin: "user", ownerId: "old" },
        old,
      ),
    ).toBe(true);
    expect(
      claimRuntimeTurnLease({ topicId: topic, queryId: "q-new", origin: "user", ownerId: "new" }),
    ).toBe(true);
    expect(getRuntimeTurnLease(topic)?.queryId).toBe("q-new");
  });

  test("carries cross-process abort requests on the heartbeat", () => {
    const topic = topicId();
    claimRuntimeTurnLease({ topicId: topic, queryId: "q", origin: "user", ownerId: "owner" });
    expect(requestRuntimeTurnAbort(topic, "internal")).toBe(true);
    expect(heartbeatRuntimeTurnLease(topic, "q", "owner")).toMatchObject({
      owned: true,
      abortRequested: true,
      abortReason: "internal",
    });
  });

  test("stale cleanup cannot release a replacement", () => {
    const topic = topicId();
    claimRuntimeTurnLease({ topicId: topic, queryId: "old", origin: "user", ownerId: "owner" });
    claimRuntimeTurnLease({ topicId: topic, queryId: "new", origin: "user", ownerId: "owner" });
    expect(releaseRuntimeTurnLease(topic, "old", "owner")).toBe(false);
    expect(getRuntimeTurnLease(topic)?.queryId).toBe("new");
  });

  test("lists only active leases", () => {
    const active = topicId();
    const stale = topicId();
    const now = Date.now();
    claimRuntimeTurnLease({ topicId: active, queryId: "active", origin: "cron:job:run" }, now);
    claimRuntimeTurnLease(
      { topicId: stale, queryId: "stale", origin: "cron:old:run" },
      now - TURN_LEASE_STALE_MS - 1,
    );

    expect(listRuntimeTurnLeases(now).map((lease) => lease.topicId)).toContain(active);
    expect(listRuntimeTurnLeases(now).map((lease) => lease.topicId)).not.toContain(stale);
    releaseRuntimeTurnLease(stale, "stale");
  });
});
