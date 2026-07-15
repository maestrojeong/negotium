import { afterEach, describe, expect, test } from "bun:test";
import {
  claimRuntimeTurnLease,
  getRuntimeTurnLease,
  releaseRuntimeTurnLease,
} from "#storage/runtime-leases";
import { beginRuntimeTopicMaintenance, getRuntimeTopicState } from "#storage/runtime-topic-state";
import {
  cancelRuntimeUserTurnRequests,
  cancelRuntimeUserTurnRequestsBeforeEpoch,
  claimNextRuntimeUserTurnRequest,
  completeRuntimeUserTurnRequest,
  enqueueRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";

const topicIds = new Set<string>();

function topicId(): string {
  const id = `topic-state-${crypto.randomUUID()}`;
  topicIds.add(id);
  return id;
}

afterEach(() => {
  for (const id of topicIds) {
    cancelRuntimeUserTurnRequests(id);
    const lease = getRuntimeTurnLease(id);
    if (lease) releaseRuntimeTurnLease(id, lease.queryId, lease.ownerId);
    const cleanup = beginRuntimeTopicMaintenance(id);
    cleanup?.finish({ deleteState: true });
  }
  topicIds.clear();
});

describe("runtime topic maintenance", () => {
  test("blocks turn leases and durable claims until maintenance finishes", () => {
    const topic = topicId();
    const maintenance = beginRuntimeTopicMaintenance(topic, { heartbeatMs: 60_000 });
    expect(maintenance).not.toBeNull();
    expect(getRuntimeTopicState(topic)).toMatchObject({ epoch: 1, maintenance: true });

    expect(claimRuntimeTurnLease({ topicId: topic, queryId: "blocked", origin: "user" })).toBe(
      false,
    );
    enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "owner",
      prompt: "after reset",
      allowAutoContinue: true,
      topicEpoch: maintenance!.epoch,
    });
    expect(claimNextRuntimeUserTurnRequest("worker-during-maintenance")).toBeNull();

    maintenance!.finish();
    const claimed = claimNextRuntimeUserTurnRequest("worker-after-maintenance");
    expect(claimed?.topicId).toBe(topic);
    if (claimed) completeRuntimeUserTurnRequest(topic, claimed.requestId);
  });

  test("advancing the epoch cancels only work accepted before reset", () => {
    const topic = topicId();
    const oldRequestId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "owner",
      prompt: "old context",
      allowAutoContinue: true,
    });
    const maintenance = beginRuntimeTopicMaintenance(topic, { heartbeatMs: 60_000 })!;

    expect(cancelRuntimeUserTurnRequestsBeforeEpoch(topic, maintenance.epoch)).toEqual([
      oldRequestId,
    ]);
    const newRequestId = enqueueRuntimeUserTurnRequest({
      topicId: topic,
      userId: "owner",
      prompt: "fresh context",
      allowAutoContinue: true,
      topicEpoch: maintenance.epoch,
    });
    expect(cancelRuntimeUserTurnRequestsBeforeEpoch(topic, maintenance.epoch)).toEqual([]);

    maintenance.finish();
    expect(claimNextRuntimeUserTurnRequest("fresh-worker")?.requestId).toBe(newRequestId);
  });
});
