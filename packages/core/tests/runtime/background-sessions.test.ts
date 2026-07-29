import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  backgroundSessionProgress,
  beginTransientBackgroundSession,
  listBackgroundSessionsForUser,
} from "#runtime/background-sessions";
import { db } from "#storage/forum-db";
import { appendRuntimeEvent } from "#storage/runtime-events";

const runtimeTopicIds: string[] = [];

afterEach(() => {
  for (const topicId of runtimeTopicIds.splice(0)) {
    db.query("DELETE FROM runtime_events WHERE topic_id = ?").run(topicId);
  }
});

describe("transient background sessions", () => {
  test("retains completed compact work briefly and removes it after expiry", async () => {
    const handle = beginTransientBackgroundSession("compact-owner", {
      id: "compact:topic:test",
      kind: "compact",
      title: "Compact Research",
      topicId: "topic",
      status: "Preparing",
      steps: ["Snapshot captured"],
      retentionMs: 5,
    });

    handle.update("Summarizing", "Provider session started");
    handle.setOutput("Complete compact summary");

    expect(listBackgroundSessionsForUser("other-user")).toEqual([]);
    expect(listBackgroundSessionsForUser("compact-owner")).toEqual([
      expect.objectContaining({
        id: "compact:topic:test",
        kind: "compact",
        status: "Summarizing",
        active: true,
        output: "Complete compact summary",
        steps: ["Snapshot captured", "Provider session started"],
      }),
    ]);

    handle.finish("Completed", "Compaction completed");
    handle.update("Stale update", "Must be ignored");
    expect(listBackgroundSessionsForUser("compact-owner")).toEqual([
      expect.objectContaining({
        id: "compact:topic:test",
        status: "Completed",
        active: false,
        steps: ["Snapshot captured", "Provider session started", "Compaction completed"],
      }),
    ]);
    await Bun.sleep(10);
    expect(listBackgroundSessionsForUser("compact-owner")).toEqual([]);
  });
});

describe("durable background session progress", () => {
  test("shows tool result sizes and completion token usage", () => {
    const topicId = `topic-${randomUUID()}`;
    const queryId = randomUUID();
    runtimeTopicIds.push(topicId);
    appendRuntimeEvent("test", {
      type: "ai-status",
      topicId,
      payload: { kind: "ai_active", queryId },
    });
    appendRuntimeEvent("test", {
      type: "ai-status",
      topicId,
      payload: {
        kind: "tool_call",
        queryId,
        name: "Read",
        input: { file_path: "/workspace/topic/src/index.ts" },
        label: "Read",
        toolUseId: "tool-1",
      },
    });
    appendRuntimeEvent("test", {
      type: "ai-status",
      topicId,
      payload: {
        kind: "tool_output",
        queryId,
        toolUseId: "tool-1",
        content: "x".repeat(2_048),
      },
    });
    appendRuntimeEvent("test", {
      type: "ai-status",
      topicId,
      payload: {
        kind: "ai_done",
        queryId,
        usage: { input: 12_345, output: 678 },
      },
    });

    expect(backgroundSessionProgress(topicId, queryId)).toEqual({
      status: "Completed",
      steps: [
        "Scheduled turn started",
        "Read …/src/index.ts",
        "Read result · 2.0 KB",
        "Scheduled turn completed · 12,345 in / 678 out",
      ],
    });
  });

  test("shows the actual scheduled-turn error", () => {
    const topicId = `topic-${randomUUID()}`;
    const queryId = randomUUID();
    runtimeTopicIds.push(topicId);
    appendRuntimeEvent("test", {
      type: "ai-status",
      topicId,
      payload: {
        kind: "ai_error",
        queryId,
        error: "Provider authentication expired",
      },
    });

    expect(backgroundSessionProgress(topicId, queryId)).toEqual({
      status: "Failed",
      steps: ["Scheduled turn failed: Provider authentication expired"],
    });
  });
});
