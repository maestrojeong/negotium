import { afterEach, describe, expect, test } from "bun:test";
import { switchTopicAccessMode } from "#application/switch-topic-access-mode";
import { deleteTopic, getTopic, upsertTopic } from "#storage/api-topics";
import type { TopicDto } from "#types/api";

const createdTopicIds: string[] = [];

function makeTopic(id: string, patch: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id,
    title: `Topic ${id}`,
    kind: "agent",
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMode: "always",
    aiMention: false,
    participants: [{ userId: "owner-user", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    accessMode: "private",
    ...patch,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

function accessModeOf(topicId: string): string | undefined {
  return getTopic(topicId)?.accessMode;
}

afterEach(() => {
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

describe("switchTopicAccessMode", () => {
  test("cascades to the whole subagent subtree, not just direct children", () => {
    const root = makeTopic("cascade-root");
    const child = makeTopic("cascade-child", { parentTopicId: root.id, isSubagent: true });
    const grandchild = makeTopic("cascade-grandchild", {
      parentTopicId: child.id,
      isSubagent: true,
    });

    const result = switchTopicAccessMode({
      topicId: root.id,
      userId: "owner-user",
      accessMode: "shared",
    });

    expect(result.ok).toBe(true);
    expect(accessModeOf(root.id)).toBe("shared");
    expect(accessModeOf(child.id)).toBe("shared");
    expect(accessModeOf(grandchild.id)).toBe("shared");
  });

  test("leaves forks and other derived rooms alone", () => {
    const root = makeTopic("owner-root");
    const subagent = makeTopic("owned-subagent", { parentTopicId: root.id, isSubagent: true });
    // A fork is an independent room that merely records where it came from;
    // publishing its source must not publish it.
    const fork = makeTopic("independent-fork", { parentTopicId: root.id, isFork: true });

    switchTopicAccessMode({ topicId: root.id, userId: "owner-user", accessMode: "shared" });

    expect(accessModeOf(subagent.id)).toBe("shared");
    expect(accessModeOf(fork.id)).toBe("private");
  });

  test("refuses to switch a subagent room directly", () => {
    const root = makeTopic("guard-root");
    const subagent = makeTopic("guard-subagent", { parentTopicId: root.id, isSubagent: true });

    const result = switchTopicAccessMode({
      topicId: subagent.id,
      userId: "owner-user",
      accessMode: "shared",
    });

    expect(result).toEqual({
      ok: false,
      error: "Subagent rooms inherit privacy from their parent topic",
    });
    expect(accessModeOf(subagent.id)).toBe("private");
  });

  test("non-owners are rejected before the subagent guard reveals the room's shape", () => {
    const root = makeTopic("perm-root");
    const subagent = makeTopic("perm-subagent", { parentTopicId: root.id, isSubagent: true });

    const result = switchTopicAccessMode({
      topicId: subagent.id,
      userId: "other-user",
      accessMode: "shared",
    });

    expect(result).toEqual({ ok: false, error: "Only topic owners can change privacy" });
  });

  /**
   * The terminal's publish prompt counts subagent rooms from the picker list,
   * which is `getVisibleTopics()` filtered to rooms the user participates in —
   * while the cascade here walks the unfiltered store. The two numbers agree
   * only because `createDerivedTopic` gives every subagent the parent's
   * participants and visibility. Nothing else pins that together, and this is
   * the one dialog where under-reporting the blast radius actually misleads
   * the user, so assert the property the prompt depends on.
   */
  test("every room the cascade touches is one the acting owner can also see", () => {
    const root = makeTopic("reach-root");
    makeTopic("reach-child", { parentTopicId: root.id, isSubagent: true });
    makeTopic("reach-grandchild", {
      parentTopicId: "reach-child",
      isSubagent: true,
      // Mirrors how derive.ts demotes the inherited owner on nested rooms.
      participants: [
        { userId: "owner-user", role: "member" },
        { userId: "spawner-user", role: "owner" },
      ],
    });

    const result = switchTopicAccessMode({
      topicId: root.id,
      userId: "owner-user",
      accessMode: "shared",
    });

    expect(result.ok).toBe(true);
    const touched = result.ok ? result.topicIds : [];
    expect(touched).toHaveLength(3);
    for (const id of touched) {
      const participants = getTopic(id)?.participants ?? [];
      expect(participants.some((p) => p.userId === "owner-user")).toBe(true);
    }
  });

  test("reports how many subagent rooms moved with the parent", () => {
    const root = makeTopic("count-root");
    makeTopic("count-child-a", { parentTopicId: root.id, isSubagent: true });
    makeTopic("count-child-b", { parentTopicId: root.id, isSubagent: true });

    const result = switchTopicAccessMode({
      topicId: root.id,
      userId: "owner-user",
      accessMode: "shared",
    });

    expect(result.ok && result.text).toContain("2 subagent rooms updated");
  });

  test("pulls a stale subagent back in step even when the parent is already correct", () => {
    const root = makeTopic("repair-root", { accessMode: "shared" });
    const stale = makeTopic("repair-subagent", {
      parentTopicId: root.id,
      isSubagent: true,
      accessMode: "private",
    });

    const result = switchTopicAccessMode({
      topicId: root.id,
      userId: "owner-user",
      accessMode: "shared",
    });

    expect(result.ok).toBe(true);
    expect(accessModeOf(stale.id)).toBe("shared");
  });

  test("switching back to private takes the subtree with it", () => {
    const root = makeTopic("revoke-root", { accessMode: "shared" });
    const child = makeTopic("revoke-child", {
      parentTopicId: root.id,
      isSubagent: true,
      accessMode: "shared",
    });

    switchTopicAccessMode({ topicId: root.id, userId: "owner-user", accessMode: "private" });

    expect(accessModeOf(root.id)).toBe("private");
    expect(accessModeOf(child.id)).toBe("private");
  });

  /**
   * A cycle can never be *reachable* from the root being switched: a topic has
   * exactly one `parentTopicId`, so every node in a cycle already points inside
   * it and nothing outside can point in. The root itself cannot close a cycle
   * either, because the child map only contains `isSubagent` rooms and the
   * guard above rejects a subagent root. The `seen` set is therefore defensive
   * rather than load-bearing, and a test claiming to exercise it would be
   * lying. What is worth pinning is the consequence: a detached cycle left
   * behind by a bad reparent must not be dragged into an unrelated switch.
   */
  test("a detached subagent cycle is left alone by an unrelated switch", () => {
    const root = makeTopic("cycle-root");
    const child = makeTopic("cycle-child", { parentTopicId: root.id, isSubagent: true });
    const a = makeTopic("cycle-a", { isSubagent: true });
    const b = makeTopic("cycle-b", { parentTopicId: a.id, isSubagent: true });
    upsertTopic({ ...a, parentTopicId: b.id, isSubagent: true });

    const result = switchTopicAccessMode({
      topicId: root.id,
      userId: "owner-user",
      accessMode: "shared",
    });

    expect(result.ok && result.topicIds.sort()).toEqual([child.id, root.id].sort());
    expect(accessModeOf(a.id)).toBe("private");
    expect(accessModeOf(b.id)).toBe("private");
  });
});
