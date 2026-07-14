import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runtimeBus } from "#bus";
import { GENERAL_TOPIC_ID } from "#platform/constants";
import { deleteTopic, getTopic, upsertTopic } from "#storage/api-topics";
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
    expect(calls.archiver).toHaveLength(1);
    expect(getTopic(topic.id)).toBeNull();
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
