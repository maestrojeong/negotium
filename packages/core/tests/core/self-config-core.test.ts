import { afterEach, describe, expect, test } from "bun:test";
import {
  cancelSelfConfigSchedule,
  getSelfConfigModel,
  getSelfConfigSchedule,
  scheduleSelfConfigContinue,
  setSelfConfigAgent,
  setSelfConfigEffort,
  setSelfConfigModel,
  updateSelfConfigSchedule,
} from "#agents/self-config-core";
import { purgeTopicLogs } from "#agents/topic-cleanup";
import { runtimeBus } from "#bus";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { AbortReason } from "#query/types";
import { dispatchDueSelfSchedules } from "#runtime/inbox";
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
import {
  deleteSelfSchedulesForTopic,
  getPendingSelfSchedule,
  listSelfSchedulesForTopic,
} from "#storage/self-schedules";
import { getVisibleTopics } from "#topics/derive";

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
    deleteSelfSchedulesForTopic(id);
    deleteTopic(id);
  }
});

describe("self-config core", () => {
  test("set_model writes to api_topic_config for the current agent", () => {
    const topicId = seedTopic("codex");
    setTopicSessionId(topicId, "existing-codex-thread", { reason: "test" });
    const events: string[] = [];
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.topicId === topicId) events.push(event.type);
    });

    const result = setSelfConfigModel({ topicId, userId: USER }, "gpt-5.6-sol");
    unsubscribe();

    expect(result.isError).toBeUndefined();
    expect(getApiTopicConfig(topicId)?.model).toBe("gpt-5.6-sol");
    expect(getVisibleTopics().find((topic) => topic.id === topicId)?.effectiveModel).toBe(
      "gpt-5.6-sol",
    );
    expect(getTopicSessionId(topicId)).toBe("existing-codex-thread");
    expect(events).toContain("topic-updated");
  });

  test("get_model ignores topic default model when it belongs to another agent", () => {
    const topicId = seedTopic("codex");
    setApiTopicConfig(topicId, { model: "sonnet" });

    const result = getSelfConfigModel({ topicId, userId: USER });

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain("Model (agent=codex): default (gpt-5.6-luna)");
  });

  test("set_model rejects a model owned by another agent even when Codex accepts open IDs", () => {
    const topicId = seedTopic("codex");

    const result = setSelfConfigModel({ topicId, userId: USER }, "deepseek-pro");

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not a valid model for agent 'codex'");
    expect(getApiTopicConfig(topicId)?.model).toBeUndefined();
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

  test("schedule_self keeps one editable and cancellable pending schedule per topic", () => {
    const topicId = seedTopic("codex");
    const now = Date.parse("2026-07-14T12:00:00.000Z");

    const result = scheduleSelfConfigContinue(
      { topicId, userId: USER },
      30,
      "Check the build and report its final status.",
      now,
    );

    expect(result.isError).toBeUndefined();
    const scheduled = getPendingSelfSchedule(topicId);
    expect(scheduled).toMatchObject({
      topicId,
      userId: USER,
      message: "Check the build and report its final status.",
      deliverAt: now + 30_000,
      status: "pending",
    });
    expect(result.text).toContain(scheduled!.id);

    const duplicate = scheduleSelfConfigContinue(
      { topicId, userId: USER },
      60,
      "A second pending schedule",
      now,
    );
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toContain("update_self_schedule or cancel_self_schedule");
    expect(listSelfSchedulesForTopic(topicId)).toHaveLength(1);

    expect(getSelfConfigSchedule({ topicId, userId: USER }, now).text).toContain(scheduled!.id);
    const updated = updateSelfConfigSchedule(
      { topicId, userId: USER },
      scheduled!.id,
      { delaySeconds: 90, message: "Check the updated build status." },
      now + 1_000,
    );
    expect(updated.isError).toBeUndefined();
    expect(getPendingSelfSchedule(topicId)).toMatchObject({
      id: scheduled!.id,
      message: "Check the updated build status.",
      deliverAt: now + 91_000,
    });

    expect(cancelSelfConfigSchedule({ topicId, userId: USER }, "wrong-id").isError).toBe(true);
    expect(
      cancelSelfConfigSchedule({ topicId, userId: USER }, scheduled!.id).isError,
    ).toBeUndefined();
    expect(getPendingSelfSchedule(topicId)).toBeNull();
  });

  test("a due self-schedule is claimed once and removed after its turn settles", async () => {
    const topicId = seedTopic("codex");
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    scheduleSelfConfigContinue({ topicId, userId: USER }, 30, "Check the build.", now);
    let settle: ((result: { queryId: string; kind: "completed" }) => void) | undefined;

    expect(
      await dispatchDueSelfSchedules(now + 29_000, () => {
        throw new Error("not due");
      }),
    ).toBe(0);
    const started = await dispatchDueSelfSchedules(
      now + 30_000,
      (dispatchedTopicId, dispatchedUserId, prompt, _agent, options) => {
        expect(dispatchedTopicId).toBe(topicId);
        expect(dispatchedUserId).toBe(USER);
        expect(prompt).toContain("Check the build.");
        settle = options?.onSettled as typeof settle;
        return "scheduled-query";
      },
    );

    expect(started).toBe(1);
    expect(listSelfSchedulesForTopic(topicId)).toMatchObject([
      { status: "running", runningQueryId: "scheduled-query" },
    ]);
    settle?.({ queryId: "scheduled-query", kind: "completed" });
    expect(listSelfSchedulesForTopic(topicId)).toEqual([]);
  });

  test("a busy-room dispatch race returns the schedule to durable pending state", async () => {
    const topicId = seedTopic("codex");
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    scheduleSelfConfigContinue({ topicId, userId: USER }, 1, "Try again when idle.", now);
    const scheduleId = getPendingSelfSchedule(topicId)!.id;

    const started = await dispatchDueSelfSchedules(now + 1_000, () => null);

    expect(started).toBe(0);
    expect(getPendingSelfSchedule(topicId)).toMatchObject({
      id: scheduleId,
      status: "pending",
      message: "Try again when idle.",
    });
  });

  test("a running schedule may create its one successor, which wins if the run is interrupted", async () => {
    const topicId = seedTopic("codex");
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    scheduleSelfConfigContinue({ topicId, userId: USER }, 1, "Check once.", now);
    const originalId = getPendingSelfSchedule(topicId)!.id;
    let settle:
      | ((result: { queryId: string; kind: "aborted"; abortReason: AbortReason }) => void)
      | undefined;

    expect(
      await dispatchDueSelfSchedules(now + 1_000, (_topicId, _userId, _prompt, _agent, options) => {
        settle = options?.onSettled as typeof settle;
        return "scheduled-query";
      }),
    ).toBe(1);
    expect(getPendingSelfSchedule(topicId)).toBeNull();

    const next = scheduleSelfConfigContinue(
      { topicId, userId: USER },
      60,
      "Check again.",
      now + 2_000,
    );
    expect(next.isError).toBeUndefined();
    const successor = getPendingSelfSchedule(topicId)!;
    expect(successor.id).not.toBe(originalId);

    settle?.({
      queryId: "scheduled-query",
      kind: "aborted",
      abortReason: AbortReason.Internal,
    });
    expect(listSelfSchedulesForTopic(topicId)).toMatchObject([
      { id: successor.id, status: "pending", message: "Check again." },
    ]);
  });

  test("an explicitly stopped self-schedule is consumed instead of immediately retrying", async () => {
    const topicId = seedTopic("codex");
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    scheduleSelfConfigContinue({ topicId, userId: USER }, 1, "Stop means stop.", now);
    let settle:
      | ((result: { queryId: string; kind: "aborted"; abortReason: AbortReason }) => void)
      | undefined;

    expect(
      await dispatchDueSelfSchedules(now + 1_000, (_topicId, _userId, _prompt, _agent, options) => {
        settle = options?.onSettled as typeof settle;
        return "scheduled-query";
      }),
    ).toBe(1);

    settle?.({
      queryId: "scheduled-query",
      kind: "aborted",
      abortReason: AbortReason.External,
    });
    expect(listSelfSchedulesForTopic(topicId)).toEqual([]);
  });

  test("schedule_self rejects delays beyond 24 hours", () => {
    const topicId = seedTopic("codex");
    const result = scheduleSelfConfigContinue({ topicId, userId: USER }, 86_401, "Too far away");

    expect(result.isError).toBe(true);
    expect(getPendingSelfSchedule(topicId)).toBeNull();
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
      expect(getTopic(topicId)?.defaultModel).toBe("deepseek-pro");
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
      expect(result.text).toContain("explicit request");
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
