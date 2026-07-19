import { describe, expect, test } from "bun:test";
import {
  createRoomQueryRegistry,
  type RoomQueryControlLike,
  type RuntimeTurnLeaseLike,
} from "#query/room-query-registry";

type Reason = "none" | "internal" | "external";
interface Control extends RoomQueryControlLike<Reason> {}
interface Lease extends RuntimeTurnLeaseLike {}

function fixture() {
  const leases = new Map<string, Lease>();
  const aborts: Array<{ roomId: string; reason: "internal" | "external" }> = [];
  const registry = createRoomQueryRegistry<Control, Lease, Reason>({
    instanceId: "local",
    internalAbortReason: "internal",
    externalAbortReason: "external",
    listLeases: () => [...leases.values()],
    getLease: (roomId) => leases.get(roomId) ?? null,
    claimLease: ({ topicId, queryId }) => {
      if (leases.has(topicId)) return false;
      leases.set(topicId, { topicId, queryId, ownerId: "local" });
      return true;
    },
    heartbeatLease: () => ({ owned: true, abortRequested: false }),
    releaseLease: (roomId, queryId) => {
      if (leases.get(roomId)?.queryId === queryId) leases.delete(roomId);
    },
    requestAbort: (roomId, reason) => {
      aborts.push({ roomId, reason });
      return leases.has(roomId);
    },
    heartbeatMs: 60_000,
  });
  return { registry, leases, aborts };
}

describe("room query registry factory", () => {
  test("isolates caller-owned state and delegates lease persistence", () => {
    const { registry, leases, aborts } = fixture();
    const control: Control = {
      topicId: "topic",
      queryId: "query",
      origin: "user",
      abortController: new AbortController(),
      abortReason: "none",
    };
    expect(registry.set(control)).toBe(true);
    expect(registry.status("topic", "query")).toBe("running");
    expect(registry.listRunningTopicIds()).toEqual(new Set(["topic"]));
    expect(registry.abort("topic", "internal")).toBe(true);
    expect(control.abortController.signal.aborted).toBe(true);
    expect(control.abortReason).toBe("internal");
    expect(aborts).toEqual([{ roomId: "topic", reason: "internal" }]);
    registry.clear("topic", "query");
    expect(leases.size).toBe(0);
  });

  test("distinguishes local, remote, and deferred scheduling decisions", () => {
    const { registry, leases } = fixture();
    expect(registry.decide("idle", "user")).toEqual({ action: "proceed" });
    leases.set("remote", { topicId: "remote", queryId: "q", ownerId: "other" });
    expect(registry.decide("remote", "user").action).toBe("remote-abort-wait");
    expect(registry.decide("remote", "session").action).toBe("remote-defer");

    const local: Control = {
      topicId: "local",
      queryId: "q2",
      origin: "user",
      abortController: new AbortController(),
      abortReason: "none",
    };
    expect(registry.set(local)).toBe(true);
    expect(registry.decide("local", "session")).toEqual({ action: "defer" });
    expect(registry.decide("local", "user")).toEqual({ action: "abort-replace", running: local });
    registry.clear("local", "q2");
  });
});
