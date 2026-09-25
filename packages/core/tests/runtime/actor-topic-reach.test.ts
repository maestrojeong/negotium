import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { actorOwnedTopicIds, actorReachableTopicIds } from "#runtime/actor-topic-reach";
import { deleteTopic, grantSubagentTellTarget, upsertTopic } from "#storage/api-topics";
import type { TopicDto } from "#types/api";

const created: string[] = [];
function room(patch: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `reach-${randomUUID()}`,
    title: `reach ${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    aiMode: "always",
    participants: [{ userId: "local", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    surface: "otium",
    ...patch,
  };
  created.push(topic.id);
  upsertTopic(topic);
  return topic;
}
afterEach(() => {
  for (const id of created.splice(0)) deleteTopic(id);
});

describe("actor reach on the otium surface", () => {
  test("off the otium surface the node's own membership decides (no narrowing)", () => {
    expect(
      actorReachableTopicIds({
        surface: "terminal",
        currentTopicId: "here",
        actorTopicScope: undefined,
      }),
    ).toBeNull();
    expect(actorOwnedTopicIds({ surface: "telegram", actorTopicScope: undefined })).toBeNull();
  });

  test("a missing assertion is fail-closed: current room only, nothing owned", () => {
    const current = room();
    const reachable = actorReachableTopicIds({
      surface: "otium",
      currentTopicId: current.id,
      actorTopicScope: undefined,
    });
    expect([...(reachable ?? [])]).toEqual([current.id]);
    expect([
      ...(actorOwnedTopicIds({
        surface: "otium",
        currentTopicId: current.id,
        actorTopicScope: undefined,
      }) ?? []),
    ]).toEqual([]);
  });

  test("the assertion plus the current room is exactly what is reachable", () => {
    const current = room();
    const scope = {
      visibleNodeTopicIds: ["a", "b"],
      ownedNodeTopicIds: ["b"],
      issuedAt: Date.now(),
    };
    expect(
      [
        ...(actorReachableTopicIds({
          surface: "otium",
          currentTopicId: current.id,
          actorTopicScope: scope,
        }) ?? []),
      ].sort(),
    ).toEqual(["a", "b", current.id].sort());
    expect([
      ...(actorOwnedTopicIds({
        surface: "otium",
        currentTopicId: current.id,
        actorTopicScope: scope,
      }) ?? []),
    ]).toEqual(["b"]);
  });

  test("an assertion is authoritative: no subagent lineage is added on top of it", () => {
    const parent = room();
    const worker = room({ parentTopicId: parent.id, isSubagent: true });
    const granted = room();
    const outside = room();
    grantSubagentTellTarget(worker.id, granted.id, parent.id);

    // A member of the shared parent who does not own it: the hub's assertion
    // lists the parent as visible, not owned, and does not mention the
    // worker. The parent's delegation must not lend this person authority
    // over the worker (the review's scenario 1).
    const memberScope = {
      visibleNodeTopicIds: [parent.id, outside.id],
      ownedNodeTopicIds: [],
      issuedAt: Date.now(),
    };
    const memberReach = actorReachableTopicIds({
      surface: "otium",
      currentTopicId: parent.id,
      actorTopicScope: memberScope,
    });
    expect([...(memberReach ?? [])].sort()).toEqual([parent.id, outside.id].sort());
    expect(memberReach?.has(worker.id)).toBe(false);
    expect([
      ...(actorOwnedTopicIds({
        surface: "otium",
        currentTopicId: parent.id,
        actorTopicScope: memberScope,
      }) ?? []),
    ]).toEqual([]);

    // A person speaking from the worker room: an ancestor granted the worker
    // a room this person cannot see, and the grant must not widen the
    // person's reach (the review's scenario 2). The parent is reachable only
    // because the assertion says so.
    const fromWorkerScope = {
      visibleNodeTopicIds: [worker.id, parent.id],
      ownedNodeTopicIds: [],
      issuedAt: Date.now(),
    };
    const fromWorker = actorReachableTopicIds({
      surface: "otium",
      currentTopicId: worker.id,
      actorTopicScope: fromWorkerScope,
    });
    expect([...(fromWorker ?? [])].sort()).toEqual([worker.id, parent.id].sort());
    expect(fromWorker?.has(granted.id)).toBe(false);

    // The owner of the parent: the hub mirrors the worker with the parent's
    // roster, so the assertion names it as owned and that alone allows it.
    const ownerScope = {
      visibleNodeTopicIds: [parent.id, worker.id],
      ownedNodeTopicIds: [parent.id, worker.id],
      issuedAt: Date.now(),
    };
    expect([
      ...(actorOwnedTopicIds({
        surface: "otium",
        currentTopicId: parent.id,
        actorTopicScope: ownerScope,
      }) ?? []),
    ]).toEqual([parent.id, worker.id]);
  });

  test("subagent lineage stays reachable without an assertion: parent, grants, own workers", () => {
    const parent = room();
    const worker = room({ parentTopicId: parent.id, isSubagent: true });
    const otherWorker = room({ parentTopicId: parent.id, isSubagent: true });
    const granted = room();
    const plainChild = room({ parentTopicId: parent.id, isFork: false });
    grantSubagentTellTarget(worker.id, granted.id, parent.id);

    // The worker's turns (started by the parent's spawn, never by a person,
    // so they carry no assertion) can still report to the parent and reach what it was granted — and
    // nothing else, not even a sibling worker or an unrelated room.
    const fromWorker = actorReachableTopicIds({
      surface: "otium",
      currentTopicId: worker.id,
      actorTopicScope: undefined,
    });
    expect([...(fromWorker ?? [])].sort()).toEqual([worker.id, parent.id, granted.id].sort());
    expect(fromWorker?.has(otherWorker.id)).toBe(false);

    // The parent's turns reach — and may abort — the workers it spawned; a
    // plain spawn/fork child is a separate room and needs the hub's word.
    const fromParent = actorReachableTopicIds({
      surface: "otium",
      currentTopicId: parent.id,
      actorTopicScope: undefined,
    });
    expect([...(fromParent ?? [])].sort()).toEqual([parent.id, worker.id, otherWorker.id].sort());
    expect(fromParent?.has(plainChild.id)).toBe(false);
    const ownedFromParent = actorOwnedTopicIds({
      surface: "otium",
      currentTopicId: parent.id,
      actorTopicScope: undefined,
    });
    expect([...(ownedFromParent ?? [])].sort()).toEqual([worker.id, otherWorker.id].sort());
  });
});

describe("a stale assertion grants no cross-room reach", () => {
  const t0 = 1_800_000_000_000;
  const window = 10 * 60 * 1000;
  const staleClock = { now: t0 + window + 1, maxAgeMs: window };
  const freshClock = { now: t0 + window, maxAgeMs: window };

  test("fresh is authoritative; stale keeps only the current room and asserted lineage", () => {
    const parent = room();
    const worker = room({ parentTopicId: parent.id, isSubagent: true });
    const unasserted = room({ parentTopicId: parent.id, isSubagent: true });
    const outside = room();
    const scope = {
      visibleNodeTopicIds: [parent.id, worker.id, outside.id],
      ownedNodeTopicIds: [parent.id, worker.id, outside.id],
      issuedAt: t0,
    };
    const input = { surface: "otium", currentTopicId: parent.id, actorTopicScope: scope };
    expect([...(actorReachableTopicIds(input, freshClock) ?? [])].sort()).toEqual(
      [parent.id, worker.id, outside.id].sort(),
    );
    expect([...(actorOwnedTopicIds(input, freshClock) ?? [])].sort()).toEqual(
      [parent.id, worker.id, outside.id].sort(),
    );
    // Stale: never more than the fresh assertion nor bare lineage — the
    // unasserted worker stays out, the outside room is gone.
    expect([...(actorReachableTopicIds(input, staleClock) ?? [])].sort()).toEqual(
      [parent.id, worker.id].sort(),
    );
    expect([...(actorOwnedTopicIds(input, staleClock) ?? [])]).toEqual([worker.id]);
    expect(actorReachableTopicIds(input, staleClock)?.has(unasserted.id)).toBe(false);
  });

  test("missing or future-dated issuedAt is stale; off otium nothing changes", () => {
    const current = room();
    const other = room();
    const base = { visibleNodeTopicIds: [other.id], ownedNodeTopicIds: [other.id] };
    for (const scope of [base, { ...base, issuedAt: t0 + 2 * window }]) {
      const input = { surface: "otium", currentTopicId: current.id, actorTopicScope: scope };
      expect([...(actorReachableTopicIds(input, { now: t0, maxAgeMs: window }) ?? [])]).toEqual([
        current.id,
      ]);
      expect([...(actorOwnedTopicIds(input, { now: t0, maxAgeMs: window }) ?? [])]).toEqual([]);
    }
    expect(
      actorReachableTopicIds(
        { surface: "terminal", currentTopicId: current.id, actorTopicScope: base },
        staleClock,
      ),
    ).toBeNull();
  });
});
