import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runtimeBus } from "#bus";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { GENERAL_TOPIC_ID } from "#platform/constants";
import { resolveTopicProfileDir } from "#platform/playwright/manager";
import { clearRoomQuery, setRoomQuery } from "#query/active-rooms";
import { scheduledSessionInboxPath, sessionInboxPath } from "#query/session-inbox-path";
import { AbortReason } from "#query/types";
import { registerAskCallback, resolveAskCallback } from "#runtime/ask-callbacks";
import { resetFileHooks, setFileHooks } from "#runtime/file-hooks";
import { getActiveVisualForPrompt, storeTopicVisual } from "#runtime/visual-store";
import { deleteTopic, getTopic, upsertTopic } from "#storage/api-topics";
import { appendConversationEventStrict, getConversationPath } from "#storage/conversations";
import { createPendingAsk, listPendingAsksForCaller } from "#storage/session-asks";
import { getTopicArchiveState, setTopicArchiveState } from "#storage/topic-archive-state";
import type { TopicDto } from "#types/api";

let archiveShouldFail = false;
let archiveError: Error = new Error("archive failed");

const calls = {
  archive: [] as Array<{ topicId: string; title: string }>,
  archiver: [] as unknown[],
};
const createdTopicIds: string[] = [];

mock.module("#storage/topic-archive", () => ({
  archiveTopicMessages: (topicId: string, title: string) => {
    calls.archive.push({ topicId, title });
    if (archiveShouldFail) throw archiveError;
    return { path: `/tmp/${topicId}.jsonl`, messageCount: 3, lastRowid: 9 };
  },
}));

mock.module("#agents/archiver", () => ({
  runArchiverTurn: (args: unknown) => {
    calls.archiver.push(args);
  },
}));

const { deleteTopicCascade, TopicArchiveRequiredError } = await import("#topics/lifecycle");

function makeTopic(id: string, title: string, patch: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id,
    title,
    kind: "agent",
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMode: "always",
    aiMention: false,
    participants: [{ userId: "owner-user", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    ...patch,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

// bun's mock.module is process-global and persists after this file finishes.
// The last test here leaves archiveShouldFail=true, which would make the still-
// mocked archiveTopicMessages throw for OTHER test files that exercise the real
// delete path (e.g. tests/api/command-route.test.ts → /del). Reset it after the
// suite so the leaked mock is a no-throw passthrough.
afterAll(() => {
  archiveShouldFail = false;
  mock.restore();
});

afterEach(() => {
  resetFileHooks();
  for (const id of createdTopicIds.splice(0)) deleteTopic(id);
});

beforeEach(() => {
  archiveShouldFail = false;
  archiveError = new Error("archive failed");
  calls.archive = [];
  calls.archiver = [];
});

describe("deleteTopicCascade archive policy", () => {
  test("refuses to delete a personal manager room before any destructive step", async () => {
    await deleteTopicCascade(
      {
        id: `manager-${GENERAL_TOPIC_ID}`,
        title: "General",
        kind: "manager",
      } as Parameters<typeof deleteTopicCascade>[0],
      "owner-user",
      { force: true },
    );

    expect(calls.archive).toEqual([]);
    expect(calls.archiver).toEqual([]);
  });

  test("deletes after archive succeeds", async () => {
    const topic = makeTopic("topic-delete-test", "Delete Test Topic");

    await deleteTopicCascade(topic, "owner-user");

    expect(calls.archive).toEqual([{ topicId: topic.id, title: topic.title }]);
    expect(calls.archiver).toEqual([
      {
        userId: "owner-user",
        topicTitle: topic.title,
        archivePath: `/tmp/${topic.id}.jsonl`,
        messageCount: 3,
      },
    ]);
    expect(getTopic(topic.id)).toBeNull();
  });

  test("waits for an aborted turn to release the room before archiving and deleting", async () => {
    const topic = makeTopic("topic-delete-running", "Delete Running Topic");
    const abortController = new AbortController();
    setRoomQuery({
      topicId: topic.id,
      queryId: "query-running",
      origin: "user",
      prompt: "still running",
      abortController,
      abortReason: AbortReason.External,
    });
    abortController.signal.addEventListener("abort", () => {
      setTimeout(() => clearRoomQuery(topic.id, "query-running"), 5);
    });

    await deleteTopicCascade(topic, "owner-user");

    expect(abortController.signal.aborted).toBe(true);
    expect(calls.archive).toEqual([{ topicId: topic.id, title: topic.title }]);
    expect(getTopic(topic.id)).toBeNull();
  });

  test("cascades topic-owned runtime, participant, visual, upload, and filesystem state", async () => {
    const secondUser = "member-user";
    const topic = makeTopic("topic-delete-resources", "Delete Resource Topic", {
      participants: [
        { userId: "owner-user", role: "owner" },
        { userId: secondUser, role: "member" },
      ],
    });
    const workspace = resolveTopicWorkspaceDir(topic.id);
    const profile = resolveTopicProfileDir("owner-user", topic.id);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(profile, { recursive: true });
    writeFileSync(`${workspace}/artifact.txt`, "topic artifact");
    writeFileSync(`${profile}/Cookies`, "profile state");

    for (const participant of topic.participants) {
      appendConversationEventStrict(participant.userId, topic.title, "maestro", {
        type: "user_message",
        content: `history for ${participant.userId}`,
      });
      for (const path of [
        sessionInboxPath(participant.userId, topic.id),
        `${sessionInboxPath(participant.userId, topic.id)}.processing`,
        scheduledSessionInboxPath(participant.userId, topic.id),
        `${scheduledSessionInboxPath(participant.userId, topic.id)}.processing`,
      ]) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, "{}\n");
      }
      expect(
        createPendingAsk({
          userId: participant.userId,
          from: topic.title,
          to: "another-topic",
          requestId: `ask-${participant.userId}`,
        }).ok,
      ).toBe(true);
    }

    setTopicArchiveState(topic.id, 7, "/tmp/snapshot.jsonl");
    storeTopicVisual(topic.id, "<p>visual</p>", "visual", "owner-user");
    registerAskCallback({
      requestId: "callback-request",
      callerTopicId: topic.id,
      callerUserId: "owner-user",
      targetQueryId: "target-query",
      createdAt: Date.now(),
    });
    const deletedUploadTopics: string[] = [];
    setFileHooks({
      resolveAttachmentByFileId: () => null,
      resolveUploadedFilePathByFileId: () => null,
      storeLocalFileAsUpload: () => null,
      deleteFilesForTopic: (topicId) => {
        deletedUploadTopics.push(topicId);
      },
    });

    await deleteTopicCascade(topic, "owner-user");

    expect(existsSync(workspace)).toBe(false);
    expect(existsSync(profile)).toBe(false);
    expect(deletedUploadTopics).toEqual([topic.id]);
    expect(getTopicArchiveState(topic.id)).toBeNull();
    expect(getActiveVisualForPrompt(topic.id, "owner-user")).toBeNull();
    expect(resolveAskCallback("target-query")).toBeNull();
    for (const participant of topic.participants) {
      expect(existsSync(getConversationPath(participant.userId, topic.title))).toBe(false);
      expect(existsSync(sessionInboxPath(participant.userId, topic.id))).toBe(false);
      expect(existsSync(`${sessionInboxPath(participant.userId, topic.id)}.processing`)).toBe(
        false,
      );
      expect(existsSync(scheduledSessionInboxPath(participant.userId, topic.id))).toBe(false);
      expect(
        existsSync(`${scheduledSessionInboxPath(participant.userId, topic.id)}.processing`),
      ).toBe(false);
      expect(listPendingAsksForCaller({ userId: participant.userId, from: topic.title })).toEqual(
        [],
      );
    }
  });

  test("archives a derived topic into its memory origin", async () => {
    makeTopic("root-topic", "Root Topic");
    const child = makeTopic("child-topic", "Child Topic", {
      parentTopicId: "root-topic",
      isFork: true,
    });

    await deleteTopicCascade(child, "owner-user");

    expect(calls.archive).toEqual([{ topicId: child.id, title: child.title }]);
    expect(calls.archiver).toEqual([
      {
        userId: "owner-user",
        topicId: "root-topic",
        topicTitle: "Root Topic",
        archivePath: "/tmp/child-topic.jsonl",
        messageCount: 3,
      },
    ]);
    expect(getTopic(child.id)).toBeNull();
    expect(getTopic("root-topic")).not.toBeNull();
  });

  test("reparents surviving descendants instead of leaving a dangling parent id", async () => {
    const root = makeTopic("reparent-root", "Reparent Root");
    const middle = makeTopic("reparent-middle", "Reparent Middle", {
      parentTopicId: root.id,
      isFork: true,
    });
    const leaf = makeTopic("reparent-leaf", "Reparent Leaf", {
      parentTopicId: middle.id,
      isSubagent: true,
    });

    await deleteTopicCascade(middle, "owner-user");

    expect(getTopic(leaf.id)?.parentTopicId).toBe(root.id);
  });

  test("blocks delete when archive fails and force is false", async () => {
    const topic = makeTopic("topic-delete-test", "Delete Test Topic");
    archiveShouldFail = true;

    await expect(deleteTopicCascade(topic, "owner-user")).rejects.toThrow(
      TopicArchiveRequiredError,
    );

    expect(calls.archive).toEqual([{ topicId: topic.id, title: topic.title }]);
    expect(calls.archiver).toEqual([]);
    expect(getTopic(topic.id)).not.toBeNull();
  });

  test("broadcasts topic-deleted on the bus so adapters can mirror the deletion", async () => {
    const topic = makeTopic("topic-delete-bus-test", "Bus Delete Topic");
    const deletedIds: string[] = [];
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type === "topic-deleted") deletedIds.push(event.topicId);
    });

    try {
      // skipArchive+force keeps the archiver out of the picture — this test is
      // only about the bus event after the final DB delete.
      await deleteTopicCascade(topic, "owner-user", { skipArchive: true, force: true });
    } finally {
      unsubscribe();
    }

    expect(getTopic(topic.id)).toBeNull();
    expect(deletedIds).toEqual([topic.id]);
  });

  test("force deletes when archive fails and force is true", async () => {
    const topic = makeTopic("topic-delete-test", "Delete Test Topic");
    archiveShouldFail = true;

    await deleteTopicCascade(topic, "owner-user", { force: true });

    expect(calls.archive).toEqual([{ topicId: topic.id, title: topic.title }]);
    expect(calls.archiver).toEqual([]);
    expect(getTopic(topic.id)).toBeNull();
  });
});
