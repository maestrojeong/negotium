import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { listApiMessages, type TopicDto } from "@negotium/core";
import { openCallbackStore } from "@/callback-store";
import { ensureKakaoTalkTopic } from "@/topic";
import { createKakaoWebhookHandler, KAKAOTALK_WEBHOOK_PATH } from "@/webhook";

const realCore = { ...(await import("@negotium/core")) };
const startedTurns: Array<{ topicId: string; prompt: string }> = [];

describe("createKakaoWebhookHandler", () => {
  let topic: TopicDto;
  let callbackDbPath: string;
  let handle: (req: Request) => Promise<Response | null>;

  beforeEach(() => {
    const userId = `kakaotalk-webhook-test-${randomUUID()}`;
    topic = ensureKakaoTalkTopic(userId);
    callbackDbPath = `${process.env.NEGOTIUM_DATA_DIR}/webhook-test-${randomUUID()}.db`;
    const callbackStore = openCallbackStore(callbackDbPath);
    startedTurns.length = 0;
    handle = createKakaoWebhookHandler({
      topic: () => topic,
      userId,
      triggerWord: "lumi",
      callbackStore,
    });
  });

  afterEach(() => {
    mock.module("@negotium/core", () => realCore);
  });

  test("ignores requests for other paths/methods", async () => {
    const req = new Request("http://negotium.test/other", { method: "POST" });
    expect(await handle(req)).toBeNull();
  });

  test("persists the message and replies with a silent ack when the trigger word is absent", async () => {
    const before = listApiMessages(topic.id, { limit: 50 }).page.length;
    const res = await handle(
      new Request(`http://negotium.test${KAKAOTALK_WEBHOOK_PATH}`, {
        method: "POST",
        body: JSON.stringify({
          userRequest: { utterance: "안녕하세요", user: { id: "u1", type: "accountId" } },
        }),
      }),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { template?: { outputs: unknown[] } };
    expect(body.template?.outputs).toEqual([]);

    const after = listApiMessages(topic.id, { limit: 50 }).page;
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.text).toBe("안녕하세요");
    expect(after.at(-1)?.authorId).toBe("kakao:u1");
  });

  test("falls back to a plain-text reply when triggered but Open Builder's callback option is off", async () => {
    const res = await handle(
      new Request(`http://negotium.test${KAKAOTALK_WEBHOOK_PATH}`, {
        method: "POST",
        body: JSON.stringify({
          userRequest: { utterance: "lumi 안녕", user: { id: "u1", type: "accountId" } },
        }),
      }),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as {
      template?: { outputs: Array<{ simpleText: { text: string } }> };
    };
    expect(body.template?.outputs[0]?.simpleText.text).toContain("콜백");
  });

  test("silently acks a malformed/empty request body", async () => {
    const res = await handle(
      new Request(`http://negotium.test${KAKAOTALK_WEBHOOK_PATH}`, {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res?.status).toBe(400);
  });

  test("on a real trigger with a callback URL: starts a turn with the backlog prompt and acks useCallback", async () => {
    mock.module("@negotium/core", () => ({
      ...realCore,
      startAiTurn: (params: { topic: TopicDto; prompt: string }) => {
        startedTurns.push({ topicId: params.topic.id, prompt: params.prompt });
        return { settled: false };
      },
    }));
    // Re-create the handler against the freshly mocked module graph.
    const callbackStore = openCallbackStore(callbackDbPath);
    const mockedHandle = createKakaoWebhookHandler({
      topic: () => topic,
      userId: "local",
      triggerWord: "lumi",
      callbackStore,
    });

    const res = await mockedHandle(
      new Request(`http://negotium.test${KAKAOTALK_WEBHOOK_PATH}`, {
        method: "POST",
        body: JSON.stringify({
          userRequest: {
            utterance: "lumi 오늘 날씨 어때?",
            user: { id: "u1", type: "accountId" },
            callbackUrl: "https://bot-api.kakao.com/callback/abc123",
          },
        }),
      }),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { useCallback?: boolean; data?: { text?: string } };
    expect(body.useCallback).toBe(true);
    expect(body.data?.text).toBeTruthy();

    expect(startedTurns.length).toBe(1);
    expect(startedTurns[0]?.topicId).toBe(topic.id);
    expect(startedTurns[0]?.prompt).toContain("lumi 오늘 날씨 어때?");
  });
});

describe("createKakaoWebhookHandler — allowlist", () => {
  // Kakao's skill payload exposes no chat/room id, only the sender — this is
  // the only enforceable boundary for "only me, in any room including an
  // open-chat the bot is invited into" (see src/env-auth.ts).
  let topic: TopicDto;
  let handle: (req: Request) => Promise<Response | null>;

  beforeEach(() => {
    const userId = `kakaotalk-allowlist-test-${randomUUID()}`;
    topic = ensureKakaoTalkTopic(userId);
    const callbackStore = openCallbackStore(
      `${process.env.NEGOTIUM_DATA_DIR}/webhook-allowlist-test-${randomUUID()}.db`,
    );
    handle = createKakaoWebhookHandler({
      topic: () => topic,
      userId,
      triggerWord: "lumi",
      callbackStore,
      allowedUsers: ["owner-id"],
    });
  });

  test("a non-allowlisted sender is silently rejected and never touches the transcript", async () => {
    const before = listApiMessages(topic.id, { limit: 50 }).page.length;
    const res = await handle(
      new Request(`http://negotium.test${KAKAOTALK_WEBHOOK_PATH}`, {
        method: "POST",
        body: JSON.stringify({
          userRequest: {
            utterance: "lumi 너 뭐 할 수 있어?",
            user: { id: "some-other-open-chat-participant", type: "accountId" },
          },
        }),
      }),
    );
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { template?: { outputs: unknown[] } };
    expect(body.template?.outputs).toEqual([]);

    // Not persisted at all — a stranger's chatter in a room the bot is
    // invited into must never show up in the backlog the owner's trigger reads.
    expect(listApiMessages(topic.id, { limit: 50 }).page.length).toBe(before);
  });

  test("the allowlisted sender's message is persisted normally", async () => {
    const before = listApiMessages(topic.id, { limit: 50 }).page.length;
    const res = await handle(
      new Request(`http://negotium.test${KAKAOTALK_WEBHOOK_PATH}`, {
        method: "POST",
        body: JSON.stringify({
          userRequest: { utterance: "안녕", user: { id: "owner-id", type: "accountId" } },
        }),
      }),
    );
    expect(res?.status).toBe(200);
    expect(listApiMessages(topic.id, { limit: 50 }).page.length).toBe(before + 1);
  });
});
