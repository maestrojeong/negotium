import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  cloneProfileForChild,
  configurePlaywrightManagerHost,
  makeInstanceKey,
  resetPlaywrightManagerHost,
  resolveTopicProfileDir,
} from "#platform/playwright/manager";
import { deleteManagedBrowserProfile } from "#platform/playwright/profile-management";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import {
  assignTopicBrowserProfile,
  createBrowserProfile,
  deleteBrowserProfile,
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

  test("rejects deleting default and assigned profiles, then removes unused metadata", () => {
    const ownerId = `owner-${randomUUID()}`;
    const topicId = createOwnedTopic(ownerId, `assigned-${randomUUID()}`);
    const profile = `unused_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      createBrowserProfile(ownerId, profile);
      expect(() => deleteBrowserProfile(ownerId, "default")).toThrow(
        "default profile cannot be deleted",
      );
      assignTopicBrowserProfile({ topicId, actorUserId: ownerId, profile });
      expect(() => deleteBrowserProfile(ownerId, profile)).toThrow(topicId);
      expect(listBrowserProfiles(ownerId).find((item) => item.name === profile)?.deletable).toBe(
        false,
      );

      assignTopicBrowserProfile({ topicId, actorUserId: ownerId, profile: "default" });
      expect(deleteBrowserProfile(ownerId, profile)).toBe(true);
      expect(listBrowserProfiles(ownerId).some((item) => item.name === profile)).toBe(false);
    } finally {
      deleteTopic(topicId);
      deleteBrowserProfile(ownerId, profile);
    }
  });

  test("deletes unused metadata and data through the configured profile boundary", async () => {
    const ownerId = `owner-${randomUUID()}`;
    const profile = `remove_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const root = mkdtempSync(join(tmpdir(), "negotium-profile-delete-"));
    const dataDir = join(root, profile);
    const cleaned: string[] = [];
    try {
      configurePlaywrightManagerHost({
        resolveNamedBinding(bindingOwnerId, rawProfile) {
          return {
            instanceKey: `delete:${bindingOwnerId}:${rawProfile}`,
            ownerId: bindingOwnerId,
            profile: rawProfile,
          };
        },
        resolveInstanceDataDir(instanceKey) {
          return join(root, instanceKey.split(":").at(-1)!);
        },
        cleanupBrowserProcessesForDataDir(path) {
          cleaned.push(path);
        },
        removeProfileDataDir(path) {
          if (dirname(resolve(path)) !== resolve(root))
            throw new Error("outside test profile root");
          rmSync(path, { recursive: true, force: true });
          return true;
        },
        reapOrphanBrowsers() {},
      });
      createBrowserProfile(ownerId, profile);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "Cookies"), "test");

      const result = await deleteManagedBrowserProfile(ownerId, ` ${profile.toUpperCase()} `);

      expect(result).toEqual({
        profile,
        metadataRemoved: true,
        dataRemoved: true,
        processStopped: false,
      });
      expect(cleaned).toEqual([dataDir]);
      expect(listBrowserProfiles(ownerId).some((item) => item.name === profile)).toBe(false);
    } finally {
      resetPlaywrightManagerHost();
      rmSync(root, { recursive: true, force: true });
      deleteBrowserProfile(ownerId, profile);
    }
  });

  test("rechecks profile usage after shutdown before removing data", async () => {
    const ownerId = `owner-${randomUUID()}`;
    const profile = `raced_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const topicId = createOwnedTopic(ownerId, `raced-${randomUUID()}`);
    const root = mkdtempSync(join(tmpdir(), "negotium-profile-race-"));
    const dataDir = join(root, profile);
    let cleanupCalled = false;
    let removeCalled = false;
    try {
      configurePlaywrightManagerHost({
        resolveNamedBinding(bindingOwnerId, rawProfile) {
          return {
            instanceKey: `race:${bindingOwnerId}:${rawProfile}`,
            ownerId: bindingOwnerId,
            profile: rawProfile,
          };
        },
        resolveInstanceDataDir(instanceKey) {
          return join(root, instanceKey.split(":").at(-1)!);
        },
        cleanupBrowserProcessesForDataDir() {
          cleanupCalled = true;
        },
        removeProfileDataDir(path) {
          removeCalled = true;
          rmSync(path, { recursive: true, force: true });
          return true;
        },
        reapOrphanBrowsers() {},
      });
      createBrowserProfile(ownerId, profile);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "Cookies"), "preserve-me");

      const deletion = deleteManagedBrowserProfile(ownerId, profile);
      // The initial usage check has passed and process shutdown has yielded.
      // Assign the profile before the maintenance callback resumes.
      assignTopicBrowserProfile({ topicId, actorUserId: ownerId, profile });
      await expect(deletion).rejects.toThrow(topicId);

      // Exact-process cleanup may run, but the second usage check must happen
      // before the profile directory or metadata is removed.
      expect(cleanupCalled).toBe(true);
      expect(removeCalled).toBe(false);
      expect(readFileSync(join(dataDir, "Cookies"), "utf8")).toBe("preserve-me");
      expect(listBrowserProfiles(ownerId).find((item) => item.name === profile)).toMatchObject({
        deletable: false,
        topics: [expect.objectContaining({ id: topicId })],
      });
    } finally {
      resetPlaywrightManagerHost();
      assignTopicBrowserProfile({ topicId, actorUserId: ownerId, profile: "default" });
      deleteTopic(topicId);
      deleteBrowserProfile(ownerId, profile);
      rmSync(root, { recursive: true, force: true });
    }
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

  test("the same profile name shares the single local process and directory", () => {
    const firstOwner = `owner-${randomUUID()}`;
    const secondOwner = `owner-${randomUUID()}`;
    const first = createOwnedTopic(firstOwner, `first-${randomUUID()}`);
    const second = createOwnedTopic(secondOwner, `second-${randomUUID()}`);
    try {
      assignTopicBrowserProfile({ topicId: first, actorUserId: firstOwner, profile: "work" });
      assignTopicBrowserProfile({ topicId: second, actorUserId: secondOwner, profile: "work" });
      expect(makeInstanceKey(firstOwner, first)).toBe(makeInstanceKey(secondOwner, second));
      expect(resolveTopicProfileDir(firstOwner, first)).toBe(
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

  test("keeps owner authorization while listing the shared profile namespace", () => {
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
      ).toContainEqual(expect.objectContaining({ id: topicId }));
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

  test("clone outcomes resolve custom host profile directories", async () => {
    const ownerId = `owner-${randomUUID()}`;
    const otherOwnerId = `owner-${randomUUID()}`;
    const source = createOwnedTopic(ownerId, `source-${randomUUID()}`);
    const sharedDestination = createOwnedTopic(ownerId, `shared-${randomUUID()}`);
    const isolatedDestination = createOwnedTopic(otherOwnerId, `isolated-${randomUUID()}`);
    try {
      configurePlaywrightManagerHost({
        resolveNamedBinding(bindingOwnerId, rawProfile) {
          return {
            instanceKey: `custom:${bindingOwnerId}:${rawProfile}`,
            ownerId: bindingOwnerId,
            profile: rawProfile,
          };
        },
        resolveInstanceDataDir(instanceKey) {
          return `/tmp/custom-browser-profiles/${instanceKey}`;
        },
        cleanupBrowserProcessesForDataDir() {},
        removeProfileDataDir() {
          return false;
        },
        reapOrphanBrowsers() {},
      });
      assignTopicBrowserProfile({ topicId: source, actorUserId: ownerId, profile: "research" });
      assignTopicBrowserProfile({
        topicId: sharedDestination,
        actorUserId: ownerId,
        profile: "existing",
      });

      const shared = await cloneProfileForChild({
        userId: ownerId,
        srcTopic: source,
        dstTopic: sharedDestination,
      });
      expect(shared).toEqual({
        copied: false,
        srcDir: `/tmp/custom-browser-profiles/custom:${ownerId}:research`,
        dstDir: `/tmp/custom-browser-profiles/custom:${ownerId}:research`,
        reason: "shared-profile-assignment",
      });

      const isolated = await cloneProfileForChild({
        userId: otherOwnerId,
        srcTopic: source,
        dstTopic: isolatedDestination,
      });
      expect(isolated).toEqual({
        copied: false,
        srcDir: `/tmp/custom-browser-profiles/custom:${ownerId}:research`,
        dstDir: `/tmp/custom-browser-profiles/custom:${otherOwnerId}:default`,
        reason: "cross-owner-fresh-profile",
      });
    } finally {
      resetPlaywrightManagerHost();
      deleteTopic(source);
      deleteTopic(sharedDestination);
      deleteTopic(isolatedDestination);
    }
  });
});
