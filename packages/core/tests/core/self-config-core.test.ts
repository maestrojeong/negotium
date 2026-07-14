import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, unlinkSync } from "node:fs";
import {
  getSelfConfigModel,
  scheduleSelfConfigContinue,
  setSelfConfigAgent,
  setSelfConfigEffort,
  setSelfConfigModel,
} from "#agents/self-config-core";
import { purgeTopicLogs } from "#agents/topic-cleanup";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { readJsonlLines } from "#platform/jsonl";
import { scheduledSessionInboxPath, sessionInboxPath } from "#query/session-inbox-path";
import { sweepScheduledSessionInbox } from "#runtime/inbox";
import {
  deleteApiTopicConfig,
  getApiTopicConfig,
  setApiTopicConfig,
} from "#storage/api-topic-config";
import {
  deleteTopic,
  getTopic,
  getTopicSessionId,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import { appendConversationEvent, readConversation } from "#storage/conversations";

const USER = "self-config-core-test-user";
const createdTopicIds: string[] = [];

function seedTopic(agent: "claude" | "codex" | "maestro" = "codex"): string {
  const id = `self-config-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `Self Config ${id}`,
    agent: agent,
    defaultModel:
      agent === "claude" ? "sonnet" : agent === "codex" ? "gpt-5.6-luna" : "deepseek-pro",
    defaultEffort: agent === "codex" ? "medium" : "high",
    participants: [{ userId: USER, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  createdTopicIds.push(id);
  return id;
}

afterEach(async () => {
  for (const id of createdTopicIds.splice(0)) {
    const topic = getTopic(id);
    if (topic) {
      await purgeTopicLogs({
        userId: USER,
        topicName: topic.title,
        cwd: resolveTopicWorkspaceDir(id),
      });
    }
    deleteApiTopicConfig(id);
    deleteTopic(id);
    for (const path of [scheduledSessionInboxPath(USER, id), sessionInboxPath(USER, id)]) {
      if (existsSync(path)) unlinkSync(path);
      if (existsSync(`${path}.processing`)) unlinkSync(`${path}.processing`);
    }
  }
});

describe("self-config core", () => {
  test("set_model writes to api_topic_config for the current agent", () => {
    const topicId = seedTopic("codex");

    const result = setSelfConfigModel({ topicId, userId: USER }, "gpt-5.6-luna");

    expect(result.isError).toBeUndefined();
    expect(getApiTopicConfig(topicId)?.model).toBe("gpt-5.6-luna");
  });

  test("get_model ignores topic default model when it belongs to another agent", () => {
    const topicId = seedTopic("codex");
    setApiTopicConfig(topicId, { model: "sonnet" });

    const result = getSelfConfigModel({ topicId, userId: USER });

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Model (agent=codex): sonnet");
  });

  test("set_model rejects unsupported legacy Claude aliases", () => {
    const topicId = seedTopic("claude");

    const result = setSelfConfigModel({ topicId, userId: USER }, "haiku");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a valid model");
    expect(getApiTopicConfig(topicId)?.model).toBeUndefined();
  });

  test("set_effort validates against the current agent", () => {
    const topicId = seedTopic("codex");

    const result = setSelfConfigEffort({ topicId, userId: USER }, "minimal" as never);

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a valid effort");
    expect(getApiTopicConfig(topicId)?.effort).toBeUndefined();
  });

  test("schedule_self persists and promotes a durable delayed continuation", () => {
    const topicId = seedTopic("codex");
    const now = Date.parse("2026-07-14T12:00:00.000Z");

    const result = scheduleSelfConfigContinue(
      { topicId, userId: USER },
      30,
      "Check the build and report its final status.",
      now,
    );

    expect(result.isError).toBeUndefined();
    const schedulePath = scheduledSessionInboxPath(USER, topicId);
    const scheduled = JSON.parse(readJsonlLines(schedulePath)[0]!) as Record<string, unknown>;
    expect(scheduled).toMatchObject({
      type: "tell",
      from: "self-schedule",
      message: "Check the build and report its final status.",
      deliverAt: "2026-07-14T12:00:30.000Z",
    });

    const futureFileInode = statSync(schedulePath).ino;
    sweepScheduledSessionInbox(now + 29_000);
    expect(existsSync(sessionInboxPath(USER, topicId))).toBe(false);
    expect(statSync(schedulePath).ino).toBe(futureFileInode);

    sweepScheduledSessionInbox(now + 30_000);
    const promoted = JSON.parse(readJsonlLines(sessionInboxPath(USER, topicId))[0]!) as Record<
      string,
      unknown
    >;
    expect(promoted).toMatchObject({
      type: "tell",
      from: "self-schedule",
      message: "Check the build and report its final status.",
    });
    expect(promoted.deliverAt).toBeUndefined();
  });

  test("schedule_self rejects delays beyond 24 hours", () => {
    const topicId = seedTopic("codex");
    const result = scheduleSelfConfigContinue({ topicId, userId: USER }, 86_401, "Too far away");

    expect(result.isError).toBe(true);
    expect(existsSync(scheduledSessionInboxPath(USER, topicId))).toBe(false);
  });

  test("set_agent clears stale model/effort overrides and provider session id", () => {
    const prevDeepseekKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      const topicId = seedTopic("codex");
      setApiTopicConfig(topicId, { model: "gpt-5.6-luna", effort: "high" });
      setTopicSessionId(topicId, "codex-session-id", { reason: "test" });

      const result = setSelfConfigAgent(
        { topicId, userId: USER, currentUserPrompt: "maestro로 바꿔" },
        "maestro",
      );

      expect(result.isError).toBeUndefined();
      const config = getApiTopicConfig(topicId);
      expect(getTopic(topicId)?.agent).toBe("maestro");
      expect(config?.model).toBeUndefined();
      expect(config?.effort).toBeUndefined();
      expect(getTopicSessionId(topicId)).toBeNull();
    } finally {
      if (prevDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevDeepseekKey;
    }
  });

  test("set_agent rejects autonomous switches without an explicit current user request", () => {
    const prevDeepseekKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      const topicId = seedTopic("codex");

      const result = setSelfConfigAgent(
        { topicId, userId: USER, currentUserPrompt: "claude 모델 설정 코드를 설명해줘" },
        "maestro",
      );

      expect(result.isError).toBe(true);
      expect(result.text).toContain("explicit current user request");
      expect(getTopic(topicId)?.agent).toBe("codex");
    } finally {
      if (prevDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevDeepseekKey;
    }
  });

  test("set_agent respects the user agent lock", () => {
    const prevDeepseekKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      const topicId = seedTopic("codex");
      setApiTopicConfig(topicId, { agentLocked: true });

      const result = setSelfConfigAgent(
        { topicId, userId: USER, currentUserPrompt: "maestro로 바꿔" },
        "maestro",
      );

      expect(result.isError).toBe(true);
      expect(result.text).toContain("locked by the user");
      expect(getTopic(topicId)?.agent).toBe("codex");
    } finally {
      if (prevDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevDeepseekKey;
    }
  });

  test("set_agent manifests bridged rollout session in the unified log", () => {
    const prevDeepseekKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      const topicId = seedTopic("codex");
      const topic = getTopic(topicId);
      expect(topic).not.toBeNull();
      if (!topic) throw new Error("missing seeded topic");

      appendConversationEvent(USER, topic.title, "codex", {
        type: "user_message",
        content: "remember this",
      });
      appendConversationEvent(USER, topic.title, "codex", {
        type: "result",
        content: "remembered",
        stopReason: "end_turn",
      });

      const result = setSelfConfigAgent(
        {
          topicId,
          userId: USER,
          cwd: resolveTopicWorkspaceDir(topicId),
          currentUserPrompt: "런타임을 maestro로 전환해",
        },
        "maestro",
      );

      expect(result.isError).toBeUndefined();
      const sessionId = getTopicSessionId(topicId);
      expect(sessionId).toBeTruthy();

      const entries = readConversation(USER, topic.title);
      const last = entries.at(-1);
      expect(last?.agent).toBe("maestro");
      expect(last?.event).toEqual({ type: "session", sessionId: sessionId! });
    } finally {
      if (prevDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prevDeepseekKey;
    }
  });
});
