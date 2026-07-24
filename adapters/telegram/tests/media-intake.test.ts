import { describe, expect, test } from "bun:test";
import type { TopicDto } from "@negotium/core";
import { createTelegramMediaIntake } from "@/media-intake";

function topic(): TopicDto {
  return {
    id: "topic-1",
    title: "topic",
    kind: "agent",
    agent: "codex",
    defaultModel: null,
    defaultEffort: null,
    participants: [{ userId: "owner", role: "owner" }],
    createdAt: new Date(0).toISOString(),
    lastMessageAt: new Date(0).toISOString(),
  };
}

function createIntake(overrides?: {
  isStopped?: () => boolean;
  getFileLink?: (fileId: string) => Promise<string>;
  runTurn?: (topic: TopicDto, prompt: string) => void;
}) {
  return createTelegramMediaIntake({
    client: { getFileLink: overrides?.getFileLink ?? (async () => "https://example.test/file") },
    mediaGroup: { debounceMs: 5, maxWaitMs: 20 },
    isStopped: overrides?.isStopped ?? (() => false),
    mappingKey: (chatId, threadId) => `${chatId}:${threadId ?? "general"}`,
    resolveTopic: topic,
    runTurn: overrides?.runTurn ?? (() => {}),
    reply: () => {},
    transcribe: async () => null,
    transcriptionAvailable: () => false,
  });
}

describe("telegram media intake", () => {
  test("continues draining a chat queue after one task rejects", async () => {
    const intake = createIntake();
    const calls: string[] = [];

    intake.enqueue(1, undefined, async () => {
      calls.push("failed");
      throw new Error("injected");
    });
    intake.enqueue(1, undefined, () => {
      calls.push("next");
    });

    await Bun.sleep(10);
    expect(calls).toEqual(["failed", "next"]);
    intake.stop();
  });

  test("stop releases a pending album without downloading or starting a turn", async () => {
    let stopped = false;
    let downloads = 0;
    const turns: string[] = [];
    const intake = createIntake({
      isStopped: () => stopped,
      getFileLink: async () => {
        downloads += 1;
        return "https://example.test/file";
      },
      runTurn: (_topic, prompt) => turns.push(prompt),
    });

    intake.bufferGroup(
      {
        chat: { id: 1 },
        media_group_id: "album-1",
        caption: "pending",
        photo: [{ file_id: "photo-1" }],
      },
      1,
      undefined,
    );
    stopped = true;
    intake.stop();

    await Bun.sleep(30);
    expect(downloads).toBe(0);
    expect(turns).toEqual([]);
  });
});
