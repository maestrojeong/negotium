import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CONTEXT_LIMIT_COMPACT_PERCENT,
  cancelIdleCompactForTopic,
  idleCompactDelayMs,
  idleCompactMinContextPercent,
  runIdleCompactForTopic,
  scheduleContextLimitCompactForTopic,
  scheduleIdleCompactForTopic,
} from "#agents/idle-compact";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import type { TopicUsageSummary } from "#storage/token-stats";
import type { RestartTopicSessionResult } from "#topics/session";
import type { TopicDto } from "#types/api";

const ORIGINAL_DELAY = process.env.NEGOTIUM_IDLE_COMPACT_DELAY_MS;
const ORIGINAL_ENABLED = process.env.NEGOTIUM_IDLE_COMPACT_ENABLED;
const ORIGINAL_MIN_PERCENT = process.env.NEGOTIUM_IDLE_COMPACT_MIN_CONTEXT_PERCENT;
const createdTopicIds: string[] = [];

function makeTopic(overrides: Partial<TopicDto> = {}): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `idle-compact-${randomUUID()}`,
    title: `Idle Compact ${randomUUID()}`,
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    participants: [{ userId: "idle-owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    ...overrides,
  };
  createdTopicIds.push(topic.id);
  upsertTopic(topic);
  return topic;
}

/** Build a `getStats` stub reporting a fixed context-window occupancy. */
function statsAt(contextTokens: number, contextWindow = 200_000) {
  return (): TopicUsageSummary => ({
    topicId: "unused",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    queries: 0,
    estimatedCostUsd: 0,
    currentSession: {
      timestamp: new Date().toISOString(),
      topicId: "unused",
      topicTitle: "unused",
      agent: "claude",
      model: "sonnet",
      contextTokens,
      contextWindow,
    },
  });
}

function noStats(): TopicUsageSummary {
  return {
    topicId: "unused",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    queries: 0,
    estimatedCostUsd: 0,
  };
}

afterEach(() => {
  if (ORIGINAL_DELAY === undefined) delete process.env.NEGOTIUM_IDLE_COMPACT_DELAY_MS;
  else process.env.NEGOTIUM_IDLE_COMPACT_DELAY_MS = ORIGINAL_DELAY;
  if (ORIGINAL_ENABLED === undefined) delete process.env.NEGOTIUM_IDLE_COMPACT_ENABLED;
  else process.env.NEGOTIUM_IDLE_COMPACT_ENABLED = ORIGINAL_ENABLED;
  if (ORIGINAL_MIN_PERCENT === undefined) {
    delete process.env.NEGOTIUM_IDLE_COMPACT_MIN_CONTEXT_PERCENT;
  } else {
    process.env.NEGOTIUM_IDLE_COMPACT_MIN_CONTEXT_PERCENT = ORIGINAL_MIN_PERCENT;
  }
  for (const id of createdTopicIds.splice(0)) {
    cancelIdleCompactForTopic(id);
    deleteTopic(id);
  }
});

describe("idle compact defaults", () => {
  test("defaults to 6 hours before compacting an idle topic", () => {
    delete process.env.NEGOTIUM_IDLE_COMPACT_DELAY_MS;
    expect(idleCompactDelayMs()).toBe(6 * 60 * 60 * 1000);
  });

  test("NEGOTIUM_IDLE_COMPACT_DELAY_MS overrides the default", () => {
    process.env.NEGOTIUM_IDLE_COMPACT_DELAY_MS = "54321";
    expect(idleCompactDelayMs()).toBe(54321);
  });

  test("defaults to a 50% context-window threshold", () => {
    delete process.env.NEGOTIUM_IDLE_COMPACT_MIN_CONTEXT_PERCENT;
    expect(idleCompactMinContextPercent()).toBe(50);
  });

  test("NEGOTIUM_IDLE_COMPACT_MIN_CONTEXT_PERCENT overrides the default", () => {
    process.env.NEGOTIUM_IDLE_COMPACT_MIN_CONTEXT_PERCENT = "70";
    expect(idleCompactMinContextPercent()).toBe(70);
  });

  test("does not schedule for mention-only channels", () => {
    const topic = makeTopic({ aiMode: "mention" });
    expect(scheduleIdleCompactForTopic(topic.id, "idle-owner")).toBe("mention-only-channel");
  });

  test("schedules for always-respond agent rooms and can be cancelled", () => {
    const topic = makeTopic();
    expect(scheduleIdleCompactForTopic(topic.id, "idle-owner")).toBe("scheduled");
    expect(cancelIdleCompactForTopic(topic.id)).toBe(true);
    expect(cancelIdleCompactForTopic(topic.id)).toBe(false);
  });

  test("schedules near-immediate compaction only at 90% context occupancy", () => {
    const topic = makeTopic();
    expect(CONTEXT_LIMIT_COMPACT_PERCENT).toBe(90);
    expect(scheduleContextLimitCompactForTopic(topic.id, "idle-owner", 179_999, 200_000)).toBe(
      "below-threshold",
    );
    expect(scheduleContextLimitCompactForTopic(topic.id, "idle-owner", 180_000, 200_000)).toBe(
      "scheduled",
    );
    expect(cancelIdleCompactForTopic(topic.id)).toBe(true);
  });

  test("respects NEGOTIUM_IDLE_COMPACT_ENABLED=false", async () => {
    process.env.NEGOTIUM_IDLE_COMPACT_ENABLED = "false";
    const topic = makeTopic();
    expect(scheduleIdleCompactForTopic(topic.id, "idle-owner")).toBe("disabled");
    expect(await runIdleCompactForTopic(topic.id, "idle-owner")).toBe("disabled");
  });

  test("defers to the busy callback instead of compacting", async () => {
    const topic = makeTopic();
    let busyChecks = 0;
    let notified = 0;
    let compacted = 0;

    const status = await runIdleCompactForTopic(topic.id, "idle-owner", {
      isBusy: () => {
        busyChecks++;
        return true;
      },
      onBusy: () => {
        notified++;
      },
      getStats: statsAt(150_000),
      compact: async () => {
        compacted++;
        return { text: "compacted" };
      },
    });

    expect(status).toBe("busy");
    expect(busyChecks).toBe(1);
    expect(notified).toBe(1);
    expect(compacted).toBe(0);
  });

  test("skips compaction when no context usage has been reported yet", async () => {
    const topic = makeTopic();
    let compacted = 0;

    const status = await runIdleCompactForTopic(topic.id, "idle-owner", {
      isBusy: () => false,
      getStats: noStats,
      compact: async () => {
        compacted++;
        return { text: "compacted" };
      },
    });

    expect(status).toBe("below-threshold");
    expect(compacted).toBe(0);
  });

  test("skips compaction when context usage is below the percent threshold", async () => {
    const topic = makeTopic();
    let compacted = 0;

    // 40% of the window, under the default 50% bar.
    const status = await runIdleCompactForTopic(topic.id, "idle-owner", {
      isBusy: () => false,
      getStats: statsAt(80_000, 200_000),
      compact: async () => {
        compacted++;
        return { text: "compacted" };
      },
    });

    expect(status).toBe("below-threshold");
    expect(compacted).toBe(0);
  });

  test("compacts once idle context usage clears the percent threshold", async () => {
    const topic = makeTopic();
    const calls: Array<{ topicId: string; userId: string; reason: string }> = [];

    // 75% of the window, over the default 50% bar.
    const status = await runIdleCompactForTopic(topic.id, "idle-owner", {
      isBusy: () => false,
      getStats: statsAt(150_000, 200_000),
      compact: async (topicId, userId, reason): Promise<RestartTopicSessionResult> => {
        calls.push({ topicId, userId, reason });
        return { text: "Compacted context." };
      },
    });

    expect(status).toBe("compacted");
    expect(calls).toEqual([{ topicId: topic.id, userId: "idle-owner", reason: "idle-compact" }]);
  });

  test("honors a custom minContextPercent override", async () => {
    const topic = makeTopic();
    let compacted = 0;

    // 60% of the window clears a custom 55% bar even though it is under the
    // 70% bar set via a different override in another test.
    const status = await runIdleCompactForTopic(topic.id, "idle-owner", {
      isBusy: () => false,
      minContextPercent: 55,
      getStats: statsAt(120_000, 200_000),
      compact: async () => {
        compacted++;
        return { text: "compacted" };
      },
    });

    expect(status).toBe("compacted");
    expect(compacted).toBe(1);
  });

  test("passes a context-limit reason to non-preemptive compaction", async () => {
    const topic = makeTopic();
    const reasons: string[] = [];
    const status = await runIdleCompactForTopic(topic.id, "idle-owner", {
      isBusy: () => false,
      minContextPercent: 90,
      reason: "context-limit-compact",
      getStats: statsAt(190_000, 200_000),
      compact: async (_topicId, _userId, reason) => {
        reasons.push(reason);
        return { text: "compacted" };
      },
    });

    expect(status).toBe("compacted");
    expect(reasons).toEqual(["context-limit-compact"]);
  });

  test("surfaces a failed compaction without throwing", async () => {
    const topic = makeTopic();

    const status = await runIdleCompactForTopic(topic.id, "idle-owner", {
      isBusy: () => false,
      getStats: statsAt(150_000, 200_000),
      compact: async () => ({ text: "boom", isError: true }),
    });

    expect(status).toBe("failed");
  });

  test("reschedules instead of failing when compact reports busy", async () => {
    const topic = makeTopic();
    let notified = 0;

    const status = await runIdleCompactForTopic(topic.id, "idle-owner", {
      isBusy: () => false,
      onBusy: () => {
        notified++;
      },
      getStats: statsAt(150_000, 200_000),
      compact: async () => ({ text: "busy", isError: true, busy: true }),
    });

    expect(status).toBe("busy");
    expect(notified).toBe(1);
  });
});
