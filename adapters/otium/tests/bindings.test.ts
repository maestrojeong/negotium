import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getTopic, upsertTopic } from "@negotium/core";
import {
  bindOtiumTopic,
  listOtiumTopicBindings,
  setOtiumTopicPrivate,
  shareOtiumTopic,
  unbindOtiumTopic,
} from "@/bindings";
import { getPeerSession } from "@/store";
import { provisionMirrorTopic } from "@/turn-bridge";

function localTopic(userId: string) {
  const id = `shared-${randomUUID()}`;
  upsertTopic({
    id,
    title: `local-${id.slice(-6)}`,
    kind: "agent",
    agent: "maestro",
    aiMode: "always",
    defaultModel: "",
    defaultEffort: "medium",
    participants: [{ userId, role: "owner" }],
    isSubagent: false,
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
  });
  return getTopic(id)!;
}

describe("private/shared Otium topic access", () => {
  test("explicit sharing promotes a private local topic and binds it without converting it to a mirror", () => {
    const userId = `user-${randomUUID()}`;
    const topic = localTopic(userId);
    const hostNodeId = `hub-${randomUUID()}`;
    const hostTopicId = `room-${randomUUID()}`;

    expect(topic.accessMode).toBe("private");
    expect(shareOtiumTopic({ hostNodeId, hostTopicId, localTopicId: topic.id, userId })).toEqual({
      ok: true,
      localTopicId: topic.id,
      replaced: false,
    });
    expect(getPeerSession(hostNodeId, hostTopicId)).toMatchObject({
      local_topic_id: topic.id,
      binding_mode: "shared",
    });
    expect(listOtiumTopicBindings()).toContainEqual(
      expect.objectContaining({
        hostNodeId,
        hostTopicId,
        localTopicId: topic.id,
        transport: "shared-binding",
        topicAccessMode: "shared",
        localTopicExists: true,
      }),
    );

    const provisioned = provisionMirrorTopic(hostNodeId, {
      userId,
      hostTopicId,
      topicTitle: "remote title must not replace local title",
      execution: {
        agent: "codex",
        model: "remote-model",
        effort: "high",
        mcp: [],
        canSpawnSubagents: false,
      },
    });
    expect(provisioned).toEqual({
      ok: true,
      localTopicId: topic.id,
      bindingMode: "shared",
    });
    expect(getTopic(topic.id)).toMatchObject({
      title: topic.title,
      agent: "maestro",
      accessMode: "shared",
    });
  });

  test("direct Otium binding cannot expose a private topic", () => {
    const owner = `owner-${randomUUID()}`;
    const topic = localTopic(owner);
    const hostNodeId = `hub-${randomUUID()}`;
    const hostTopicId = `room-${randomUUID()}`;
    expect(
      bindOtiumTopic({
        hostNodeId,
        hostTopicId,
        localTopicId: topic.id,
        userId: "someone-else",
      }),
    ).toMatchObject({ ok: false, status: 403 });

    expect(
      bindOtiumTopic({ hostNodeId, hostTopicId, localTopicId: topic.id, userId: owner }).ok,
    ).toBe(false);
    expect(getPeerSession(hostNodeId, hostTopicId)).toBeNull();
    expect(getTopic(topic.id)?.accessMode).toBe("private");
  });

  test("making a shared topic private removes all Otium bindings but preserves the topic", () => {
    const owner = `owner-${randomUUID()}`;
    const topic = localTopic(owner);
    const firstHost = `hub-${randomUUID()}`;
    const secondHost = `hub-${randomUUID()}`;
    const firstRoom = `room-${randomUUID()}`;
    const secondRoom = `room-${randomUUID()}`;
    expect(
      shareOtiumTopic({
        hostNodeId: firstHost,
        hostTopicId: firstRoom,
        localTopicId: topic.id,
        userId: owner,
      }).ok,
    ).toBe(true);
    expect(
      bindOtiumTopic({
        hostNodeId: secondHost,
        hostTopicId: secondRoom,
        localTopicId: topic.id,
        userId: owner,
      }).ok,
    ).toBe(true);

    expect(setOtiumTopicPrivate({ localTopicId: topic.id, userId: owner })).toEqual({
      ok: true,
      localTopicId: topic.id,
      removedBindings: 2,
    });
    expect(getPeerSession(firstHost, firstRoom)).toBeNull();
    expect(getPeerSession(secondHost, secondRoom)).toBeNull();
    expect(getTopic(topic.id)).toMatchObject({ accessMode: "private" });
  });

  test("unbind removes one binding without deleting or privatizing the shared topic", () => {
    const owner = `owner-${randomUUID()}`;
    const topic = localTopic(owner);
    const hostNodeId = `hub-${randomUUID()}`;
    const hostTopicId = `room-${randomUUID()}`;
    expect(
      shareOtiumTopic({ hostNodeId, hostTopicId, localTopicId: topic.id, userId: owner }).ok,
    ).toBe(true);
    expect(unbindOtiumTopic(hostNodeId, hostTopicId)).toBe(true);
    expect(getPeerSession(hostNodeId, hostTopicId)).toBeNull();
    expect(getTopic(topic.id)).toMatchObject({ accessMode: "shared" });
  });

  test("never exposes a hidden internal execution mirror as a user topic", () => {
    const owner = `owner-${randomUUID()}`;
    const topic = localTopic(owner);
    upsertTopic({ ...topic, visibility: "hidden" });

    expect(
      shareOtiumTopic({
        hostNodeId: `hub-${randomUUID()}`,
        hostTopicId: `room-${randomUUID()}`,
        localTopicId: topic.id,
        userId: owner,
      }),
    ).toMatchObject({ ok: false, status: 409 });
  });
});

describe("Otium access changes cascade to subagent rooms", () => {
  function subagentOf(parent: { id: string }, userId: string, accessMode: "private" | "shared") {
    const id = `sub-${randomUUID()}`;
    upsertTopic({
      id,
      title: `worker-${id.slice(-6)}`,
      kind: "agent",
      agent: "maestro",
      aiMode: "always",
      defaultModel: "",
      defaultEffort: "medium",
      participants: [{ userId, role: "owner" }],
      parentTopicId: parent.id,
      isSubagent: true,
      accessMode,
      createdAt: new Date().toISOString(),
      lastMessageAt: new Date().toISOString(),
    });
    return getTopic(id)!;
  }

  test("making a topic private also unpublishes the subagent rooms under it", () => {
    // Writing only the parent row left the worker rooms at access_mode
    // 'shared' with nothing scheduling their reconcile, so their transcripts —
    // which carry the parent's conversation context — stayed live on the Hub
    // while the terminal showed the parent as Private.
    const userId = `user-${randomUUID()}`;
    const parent = localTopic(userId);
    const hostNodeId = `hub-${randomUUID()}`;
    const hostTopicId = `room-${randomUUID()}`;
    shareOtiumTopic({ hostNodeId, hostTopicId, localTopicId: parent.id, userId });
    const child = subagentOf(parent, userId, "shared");
    const grandchild = subagentOf(child, userId, "shared");

    expect(setOtiumTopicPrivate({ localTopicId: parent.id, userId }).ok).toBe(true);

    expect(getTopic(parent.id)?.accessMode).toBe("private");
    expect(getTopic(child.id)?.accessMode).toBe("private");
    expect(getTopic(grandchild.id)?.accessMode).toBe("private");
  });

  test("sharing a topic takes its existing subagent rooms with it", () => {
    const userId = `user-${randomUUID()}`;
    const parent = localTopic(userId);
    const child = subagentOf(parent, userId, "private");

    expect(
      shareOtiumTopic({
        hostNodeId: `hub-${randomUUID()}`,
        hostTopicId: `room-${randomUUID()}`,
        localTopicId: parent.id,
        userId,
      }).ok,
    ).toBe(true);

    expect(getTopic(parent.id)?.accessMode).toBe("shared");
    expect(getTopic(child.id)?.accessMode).toBe("shared");
  });

  test("a subagent room cannot be published directly through the Otium share path", () => {
    // Otherwise a Hub-driven share naming a worker-room id walks straight past
    // the guard that keeps subagent privacy tied to the parent.
    const userId = `user-${randomUUID()}`;
    const parent = localTopic(userId);
    const child = subagentOf(parent, userId, "private");

    const result = shareOtiumTopic({
      hostNodeId: `hub-${randomUUID()}`,
      hostTopicId: `room-${randomUUID()}`,
      localTopicId: child.id,
      userId,
    });

    expect(result).toEqual({
      ok: false,
      error: "Subagent rooms inherit privacy from their parent topic",
      status: 409,
    });
    expect(getTopic(child.id)?.accessMode).toBe("private");
  });
});
