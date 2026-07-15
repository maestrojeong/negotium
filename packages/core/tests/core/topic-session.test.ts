import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { nextUsageAlert } from "#runtime/usage-alert";
import { deleteTopic, getTopic, getTopicSessionId, setTopicSessionId } from "#storage/api-topics";
import { claimRuntimeTurnLease, releaseRuntimeTurnLease } from "#storage/runtime-leases";
import {
  enqueueRuntimeUserTurnRequest,
  getRuntimeUserTurnRequest,
} from "#storage/runtime-turn-requests";
import { registerTopic } from "#topics/create";
import { restartTopicSession } from "#topics/session";

const createdTopicIds = new Set<string>();

function createTopic(owner = `owner-${randomUUID()}`) {
  const topic = registerTopic({
    title: `reset-${randomUUID()}`,
    userId: owner,
    agent: "codex",
  });
  createdTopicIds.add(topic.id);
  return { owner, topic };
}

afterEach(() => {
  for (const topicId of createdTopicIds) deleteTopic(topicId);
  createdTopicIds.clear();
});

describe("restartTopicSession", () => {
  test("clears runtime context while preserving the topic and visible history owner", async () => {
    const { owner, topic } = createTopic();
    setTopicSessionId(topic.id, "01940000-0000-7000-8000-000000000000", {
      reason: "test",
      agent: "codex",
    });
    expect(
      nextUsageAlert(owner, topic.id, topic.title, {
        inputTokens: 1_100_000,
        outputTokens: 0,
      }),
    ).not.toBeNull();

    const result = await restartTopicSession(topic.id, owner, "test-reset");

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("next message starts fresh");
    expect(getTopic(topic.id)).not.toBeNull();
    expect(getTopicSessionId(topic.id)).toBeNull();
    expect(
      nextUsageAlert(owner, topic.id, topic.title, {
        inputTokens: 1_100_000,
        outputTokens: 0,
      }),
    ).not.toBeNull();
  });

  test("rejects non-owners without clearing the current session", async () => {
    const { topic } = createTopic();
    setTopicSessionId(topic.id, "current-session", { reason: "test", agent: "codex" });

    const result = await restartTopicSession(topic.id, "not-the-owner");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("owner");
    expect(getTopicSessionId(topic.id)).toBe("current-session");
  });

  test("cancels durable work queued before reset", async () => {
    const { owner, topic } = createTopic();
    enqueueRuntimeUserTurnRequest({
      topicId: topic.id,
      userId: owner,
      prompt: "must not run against the reset session",
      allowAutoContinue: true,
    });
    expect(getRuntimeUserTurnRequest(topic.id)).not.toBeNull();

    const result = await restartTopicSession(topic.id, owner);

    expect(result.isError).toBeUndefined();
    expect(getRuntimeUserTurnRequest(topic.id)).toBeNull();
  });

  test("waits for a turn owned by another standalone process before purging context", async () => {
    const { owner, topic } = createTopic();
    const remoteOwner = `remote-${randomUUID()}`;
    const queryId = `query-${randomUUID()}`;
    setTopicSessionId(topic.id, "remote-session", { reason: "test", agent: "codex" });
    expect(
      claimRuntimeTurnLease({
        topicId: topic.id,
        queryId,
        origin: "user",
        ownerId: remoteOwner,
      }),
    ).toBe(true);
    const releaseTimer = setTimeout(() => {
      releaseRuntimeTurnLease(topic.id, queryId, remoteOwner);
    }, 25);

    try {
      const result = await restartTopicSession(topic.id, owner);

      expect(result.isError).toBeUndefined();
      expect(getTopicSessionId(topic.id)).toBeNull();
    } finally {
      clearTimeout(releaseTimer);
      releaseRuntimeTurnLease(topic.id, queryId, remoteOwner);
    }
  });

  test("does not reset a manager room", async () => {
    const { owner, topic } = createTopic();
    topic.kind = "manager";
    const { upsertTopic } = await import("#storage/api-topics");
    upsertTopic(topic);

    const result = await restartTopicSession(topic.id, owner);

    expect(result.isError).toBe(true);
    expect(result.text).toContain("General");
  });
});
