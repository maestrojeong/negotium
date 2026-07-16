import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  cloneProfileForChild,
  makeInstanceKey,
  resolveTopicProfileDir,
} from "#platform/playwright/manager";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import {
  assignTopicBrowserProfile,
  getBrowserProfileOwner,
  getTopicBrowserProfile,
  isTopicBrowserProfileOwner,
  listBrowserProfiles,
  normalizeBrowserProfileName,
} from "#storage/browser-profiles";

function createOwnedTopic(
  ownerId: string,
  title: string,
  memberIds: string[] = [],
  additionalOwnerIds: string[] = [],
): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title,
    kind: "channel",
    defaultModel: "",
    defaultEffort: "medium",
    aiMode: "off",
    participants: [
      { userId: ownerId, role: "owner" },
      ...additionalOwnerIds.map((userId) => ({ userId, role: "owner" as const })),
      ...memberIds.map((userId) => ({ userId, role: "member" as const })),
    ],
    createdAt: now,
    lastMessageAt: now,
  });
  return id;
}

describe("browser profiles", () => {
  test("normalizes safe names and rejects path-like names", () => {
    expect(normalizeBrowserProfileName(" Work_1 ")).toBe("work_1");
    expect(() => normalizeBrowserProfileName("../work")).toThrow();
    expect(() => normalizeBrowserProfileName("UPPER SPACE")).toThrow();
  });

  test("topics with the same owner and profile share one instance and directory", () => {
    const ownerId = `owner-${randomUUID()}`;
    const first = createOwnedTopic(ownerId, `first-${randomUUID()}`);
    const second = createOwnedTopic(ownerId, `second-${randomUUID()}`);
    try {
      assignTopicBrowserProfile({ topicId: first, actorUserId: ownerId, profile: "research" });
      assignTopicBrowserProfile({ topicId: second, actorUserId: ownerId, profile: "research" });

      expect(getBrowserProfileOwner(first, "fallback")).toBe(ownerId);
      expect(getTopicBrowserProfile(first)).toBe("research");
      expect(makeInstanceKey(ownerId, first)).toBe(makeInstanceKey(ownerId, second));
      expect(resolveTopicProfileDir(ownerId, first)).toBe(resolveTopicProfileDir(ownerId, second));
      expect(
        listBrowserProfiles(ownerId).find((profile) => profile.name === "research")?.topics,
      ).toHaveLength(2);
    } finally {
      deleteTopic(first);
      deleteTopic(second);
    }
  });

  test("the same profile name remains isolated between owners", () => {
    const firstOwner = `owner-${randomUUID()}`;
    const secondOwner = `owner-${randomUUID()}`;
    const first = createOwnedTopic(firstOwner, `first-${randomUUID()}`);
    const second = createOwnedTopic(secondOwner, `second-${randomUUID()}`);
    try {
      assignTopicBrowserProfile({ topicId: first, actorUserId: firstOwner, profile: "work" });
      assignTopicBrowserProfile({ topicId: second, actorUserId: secondOwner, profile: "work" });
      expect(makeInstanceKey(firstOwner, first)).not.toBe(makeInstanceKey(secondOwner, second));
      expect(resolveTopicProfileDir(firstOwner, first)).not.toBe(
        resolveTopicProfileDir(secondOwner, second),
      );
    } finally {
      deleteTopic(first);
      deleteTopic(second);
    }
  });

  test("members cannot inspect or change the owner's profile assignment", () => {
    const ownerId = `owner-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    const topicId = createOwnedTopic(ownerId, `shared-${randomUUID()}`, [memberId]);
    try {
      expect(isTopicBrowserProfileOwner(topicId, ownerId)).toBe(true);
      expect(isTopicBrowserProfileOwner(topicId, memberId)).toBe(false);
      expect(() =>
        assignTopicBrowserProfile({ topicId, actorUserId: memberId, profile: "stolen" }),
      ).toThrow("Only the topic owner");
      expect(getTopicBrowserProfile(topicId)).toBe("default");
    } finally {
      deleteTopic(topicId);
    }
  });

  test("only the canonical first owner can access a multi-owner topic profile", () => {
    const canonicalOwner = `owner-${randomUUID()}`;
    const additionalOwner = `owner-${randomUUID()}`;
    const title = `multi-owner-${randomUUID()}`;
    const topicId = createOwnedTopic(canonicalOwner, title, [], [additionalOwner]);
    try {
      expect(isTopicBrowserProfileOwner(topicId, canonicalOwner)).toBe(true);
      expect(isTopicBrowserProfileOwner(topicId, additionalOwner)).toBe(false);
      expect(() =>
        assignTopicBrowserProfile({
          topicId,
          actorUserId: additionalOwner,
          profile: "forbidden",
        }),
      ).toThrow("Only the topic owner");

      const now = new Date().toISOString();
      upsertTopic({
        id: topicId,
        title,
        kind: "channel",
        defaultModel: "",
        defaultEffort: "medium",
        aiMode: "off",
        participants: [{ userId: additionalOwner, role: "owner" }],
        createdAt: now,
        lastMessageAt: now,
      });

      expect(getBrowserProfileOwner(topicId, "fallback")).toBe(canonicalOwner);
      expect(isTopicBrowserProfileOwner(topicId, additionalOwner)).toBe(false);
      expect(
        listBrowserProfiles(additionalOwner).flatMap((profile) => profile.topics),
      ).not.toContainEqual(expect.objectContaining({ id: topicId }));
      expect(
        listBrowserProfiles(canonicalOwner).flatMap((profile) => profile.topics),
      ).toContainEqual(expect.objectContaining({ id: topicId }));
    } finally {
      deleteTopic(topicId);
    }
  });

  test("derived topics owned by another user start with a fresh profile", async () => {
    const sourceOwner = `owner-${randomUUID()}`;
    const destinationOwner = `owner-${randomUUID()}`;
    const source = createOwnedTopic(sourceOwner, `source-${randomUUID()}`);
    const destination = createOwnedTopic(destinationOwner, `destination-${randomUUID()}`);
    try {
      assignTopicBrowserProfile({
        topicId: source,
        actorUserId: sourceOwner,
        profile: "private",
      });
      const result = await cloneProfileForChild({
        userId: destinationOwner,
        srcTopic: source,
        dstTopic: destination,
      });
      expect(result.copied).toBe(false);
      expect(result.reason).toBe("cross-owner-fresh-profile");
      expect(getTopicBrowserProfile(destination)).toBe("default");
    } finally {
      deleteTopic(source);
      deleteTopic(destination);
    }
  });
});
