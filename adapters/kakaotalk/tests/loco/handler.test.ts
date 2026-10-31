import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { listApiMessages, type TopicDto } from "@negotium/core";
import type { LocoMessageEvent } from "@/loco/bridge";
import { createLocoMessageHandler } from "@/loco/handler";
import { openLocoReplyStore } from "@/loco/reply-store";
import { ensureKakaoTalkTopic } from "@/topic";

const realCore = { ...(await import("@negotium/core")) };
const startedTurns: Array<{ topicId: string; prompt: string }> = [];

function fakeEvent(overrides: Partial<LocoMessageEvent> = {}): LocoMessageEvent {
  return {
    chatId: 999,
    roomType: "OM",
    roomName: "테스트 오픈톡방",
    logId: 1,
    authorId: 111,
    authorName: "오너",
    memberType: 1,
    text: "안녕",
    sendAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("createLocoMessageHandler", () => {
  let topic: TopicDto;
  let handle: (event: LocoMessageEvent) => void;

  beforeEach(() => {
    const userId = `kakaotalk-loco-handler-test-${randomUUID()}`;
    topic = ensureKakaoTalkTopic(userId);
    const replyStore = openLocoReplyStore(
      `${process.env.NEGOTIUM_DATA_DIR}/loco-handler-test-${randomUUID()}.db`,
    );
    startedTurns.length = 0;
    handle = createLocoMessageHandler({
      topic: () => topic,
      userId,
      triggerWord: "lumi",
      config: {
        enabled: true,
        credentials: { email: "a", password: "b", deviceUuid: "x" },
        allowedUserIds: ["111"],
        allowedChatIds: [],
      },
      replyStore,
    });
  });

  afterEach(() => {
    mock.module("@negotium/core", () => realCore);
  });

  test("a non-allowlisted sender is rejected and never touches the transcript", () => {
    const before = listApiMessages(topic.id, { limit: 50 }).page.length;
    handle(fakeEvent({ authorId: 222, text: "lumi 안녕" }));
    expect(listApiMessages(topic.id, { limit: 50 }).page.length).toBe(before);
  });

  test("an allowlisted sender's message is persisted with room context, even without a trigger", () => {
    const before = listApiMessages(topic.id, { limit: 50 }).page.length;
    handle(fakeEvent({ text: "그냥 잡담" }));
    const after = listApiMessages(topic.id, { limit: 50 }).page;
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.text).toContain("테스트 오픈톡방");
    expect(after.at(-1)?.text).toContain("그냥 잡담");
  });

  test("on a real trigger: starts a turn with the backlog prompt", () => {
    mock.module("@negotium/core", () => ({
      ...realCore,
      startAiTurn: (params: { topic: TopicDto; prompt: string }) => {
        startedTurns.push({ topicId: params.topic.id, prompt: params.prompt });
        return { settled: false };
      },
    }));
    const replyStore = openLocoReplyStore(
      `${process.env.NEGOTIUM_DATA_DIR}/loco-handler-test-${randomUUID()}.db`,
    );
    const mockedHandle = createLocoMessageHandler({
      topic: () => topic,
      userId: "local",
      triggerWord: "lumi",
      config: {
        enabled: true,
        credentials: { email: "a", password: "b", deviceUuid: "x" },
        allowedUserIds: ["111"],
        allowedChatIds: [],
      },
      replyStore,
    });

    mockedHandle(fakeEvent({ text: "lumi 오늘 날씨 어때?" }));

    expect(startedTurns.length).toBe(1);
    expect(startedTurns[0]?.topicId).toBe(topic.id);
    expect(startedTurns[0]?.prompt).toContain("lumi 오늘 날씨 어때?");

    const pending = replyStore.takeLatest(topic.id);
    expect(pending?.chatId).toBe(999);
    replyStore.close();
  });
});
