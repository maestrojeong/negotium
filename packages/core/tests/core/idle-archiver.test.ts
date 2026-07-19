import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { RunArchiverTurnParams } from "#agents/archiver";
import {
  archiveActiveTopicForMemory,
  cancelIdleArchiveForTopic,
  idleArchiveDelayMs,
  scheduleIdleArchiveForTopic,
} from "#agents/idle-archiver";
import { appendApiMessage } from "#storage/api-messages";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { deleteTopicArchiveState, getTopicArchiveState } from "#storage/topic-archive-state";
import type { TopicDto } from "#types/api";

const ORIGINAL_DELAY = process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS;
const ORIGINAL_ENABLED = process.env.NEGOTIUM_IDLE_ARCHIVER_ENABLED;
const createdTopicIds: string[] = [];

function makeTopic(aiMention: boolean): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `idle-archiver-${randomUUID()}`,
    title: `Idle Archiver ${randomUUID()}`,
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    aiMention,
    participants: [{ userId: "idle-owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

afterEach(() => {
  if (ORIGINAL_DELAY === undefined) {
    delete process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS;
  } else {
    process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS = ORIGINAL_DELAY;
  }
  if (ORIGINAL_ENABLED === undefined) {
    delete process.env.NEGOTIUM_IDLE_ARCHIVER_ENABLED;
  } else {
    process.env.NEGOTIUM_IDLE_ARCHIVER_ENABLED = ORIGINAL_ENABLED;
  }
  for (const id of createdTopicIds.splice(0)) {
    cancelIdleArchiveForTopic(id);
    deleteTopicArchiveState(id);
    deleteTopic(id);
  }
});

describe("idle archiver defaults", () => {
  test("defaults to 6 hours before archiving an idle topic", () => {
    delete process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS;

    expect(idleArchiveDelayMs()).toBe(6 * 60 * 60 * 1000);
  });

  test("NEGOTIUM_IDLE_ARCHIVE_DELAY_MS overrides the default", () => {
    process.env.NEGOTIUM_IDLE_ARCHIVE_DELAY_MS = "12345";

    expect(idleArchiveDelayMs()).toBe(12345);
  });

  test("does not schedule memory archive for mention-only channels", () => {
    const topic = makeTopic(true);

    expect(scheduleIdleArchiveForTopic(topic.id, "idle-owner")).toBe("mention-only-channel");
  });

  test("schedules memory archive for always-respond agent rooms", () => {
    const topic = makeTopic(false);

    expect(scheduleIdleArchiveForTopic(topic.id, "idle-owner")).toBe("scheduled");
    expect(cancelIdleArchiveForTopic(topic.id)).toBe(true);
    expect(cancelIdleArchiveForTopic(topic.id)).toBe(false);
  });

  test("idle reason respects an explicit disabled host policy", () => {
    const topic = makeTopic(false);

    expect(
      archiveActiveTopicForMemory(topic.id, "idle-owner", {
        reason: "idle",
        minMessages: 1,
        enabled: false,
      }),
    ).toBe("disabled");
  });

  test("uses host busy callbacks without scheduling a local timer", () => {
    const topic = makeTopic(false);
    let busyChecks = 0;
    let busyNotifications = 0;

    expect(
      archiveActiveTopicForMemory(topic.id, "idle-owner", {
        reason: "idle",
        minMessages: 1,
        isBusy: () => {
          busyChecks++;
          return true;
        },
        onBusy: () => {
          busyNotifications++;
        },
      }),
    ).toBe("busy");
    expect(busyChecks).toBe(1);
    expect(busyNotifications).toBe(1);
    expect(cancelIdleArchiveForTopic(topic.id)).toBe(false);
  });

  test("reset snapshots only the unarchived tail and launches memory archiver once", () => {
    process.env.NEGOTIUM_IDLE_ARCHIVER_ENABLED = "false";
    const topic = makeTopic(false);
    for (const [index, text] of ["first", "reply", "next", "done"].entries()) {
      appendApiMessage({
        id: randomUUID(),
        topicId: topic.id,
        authorId: index % 2 === 0 ? "idle-owner" : "ai",
        text,
        createdAt: new Date(1_000 + index).toISOString(),
      });
    }
    const launches: RunArchiverTurnParams[] = [];
    const archiveCalls: Array<{ reason?: string; afterRowid?: number }> = [];
    const options = {
      reason: "reset" as const,
      minMessages: 1,
      allowMentionOnly: true,
      skipBusyCheck: true,
      archiveMessages: (
        _topicId: string,
        _topicTitle: string,
        archiveOptions?: { reason?: "delete" | "idle" | "reset"; afterRowid?: number },
      ) => {
        archiveCalls.push(archiveOptions ?? {});
        return {
          path: "/tmp/reset-memory-test.jsonl",
          messageCount: 4,
          exchangeCount: 2,
          lastRowid: 1_000_000,
        };
      },
      launchArchiver: (params: RunArchiverTurnParams) => {
        launches.push(params);
        params.onSettled?.(true);
        return true;
      },
    };

    expect(archiveActiveTopicForMemory(topic.id, "idle-owner", options)).toBe("archived");
    expect(launches).toHaveLength(1);
    expect(launches[0]?.mode).toBe("active-topic");
    expect(archiveCalls).toEqual([{ reason: "reset", afterRowid: 0 }]);
    expect(getTopicArchiveState(topic.id)?.lastArchivedRowid).toBeGreaterThan(0);

    expect(archiveActiveTopicForMemory(topic.id, "idle-owner", options)).toBe("below-threshold");
    expect(launches).toHaveLength(1);
  });

  test("reset preserves a short raw snapshot but skips the memory agent", () => {
    const topic = makeTopic(false);
    for (const [index, authorId] of ["idle-owner", "ai"].entries()) {
      appendApiMessage({
        id: randomUUID(),
        topicId: topic.id,
        authorId,
        text: `short-${index}`,
        createdAt: new Date(2_000 + index).toISOString(),
      });
    }
    let archiveCalls = 0;
    let launches = 0;

    expect(
      archiveActiveTopicForMemory(topic.id, "idle-owner", {
        reason: "reset",
        minMessages: 1,
        minExchanges: 6,
        allowMentionOnly: true,
        skipBusyCheck: true,
        archiveMessages: () => {
          archiveCalls++;
          return {
            path: "/tmp/reset-memory-short.jsonl",
            messageCount: 2,
            exchangeCount: 1,
            lastRowid: 41,
          };
        },
        launchArchiver: () => {
          launches++;
          return true;
        },
      }),
    ).toBe("below-threshold");
    expect(archiveCalls).toBe(1);
    expect(launches).toBe(0);
    expect(getTopicArchiveState(topic.id)?.lastArchivedRowid).toBe(41);
  });

  test("keeps a failed memory launch pending and retries without rewriting its archive", () => {
    const topic = makeTopic(false);
    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: "idle-owner",
      text: "one reset message still matters",
      createdAt: new Date().toISOString(),
    });
    let archiveCalls = 0;
    let launches = 0;
    const options = {
      reason: "reset" as const,
      minMessages: 1,
      allowMentionOnly: true,
      skipBusyCheck: true,
      archiveMessages: () => {
        archiveCalls++;
        return {
          path: "/tmp/reset-memory-retry.jsonl",
          messageCount: 1,
          exchangeCount: 0,
          lastRowid: 42,
        };
      },
      launchArchiver: (params: RunArchiverTurnParams) => {
        launches++;
        if (launches === 1) return false;
        params.onSettled?.(true);
        return true;
      },
    };

    expect(archiveActiveTopicForMemory(topic.id, "idle-owner", options)).toBe("deferred");
    expect(getTopicArchiveState(topic.id)).toBeNull();
    expect(archiveActiveTopicForMemory(topic.id, "idle-owner", options)).toBe("archived");
    expect(archiveCalls).toBe(1);
    expect(launches).toBe(2);
    expect(getTopicArchiveState(topic.id)?.lastArchivedRowid).toBe(42);
  });

  test("does not launch the same snapshot twice while another process owns its job", () => {
    const topic = makeTopic(false);
    appendApiMessage({
      id: randomUUID(),
      topicId: topic.id,
      authorId: "idle-owner",
      text: "claim once",
      createdAt: new Date().toISOString(),
    });
    let archiveCalls = 0;
    let launches = 0;
    const options = {
      reason: "reset" as const,
      minMessages: 1,
      allowMentionOnly: true,
      skipBusyCheck: true,
      archiveMessages: () => {
        archiveCalls++;
        return {
          path: "/tmp/reset-memory-running.jsonl",
          messageCount: 1,
          exchangeCount: 0,
          lastRowid: 43,
        };
      },
      launchArchiver: (_params: RunArchiverTurnParams) => {
        launches++;
        return true;
      },
    };

    expect(archiveActiveTopicForMemory(topic.id, "idle-owner", options)).toBe("archived");
    expect(archiveActiveTopicForMemory(topic.id, "idle-owner", options)).toBe("busy");
    expect(archiveCalls).toBe(1);
    expect(launches).toBe(1);
    expect(getTopicArchiveState(topic.id)).toBeNull();
  });
});
