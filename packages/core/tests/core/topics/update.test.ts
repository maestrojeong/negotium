import { afterEach, describe, expect, test } from "bun:test";
import {
  deleteApiTopicConfig,
  getApiTopicConfig,
  setApiTopicConfig,
} from "#storage/api-topic-config";
import { deleteTopic, getTopic, upsertTopic } from "#storage/api-topics";
import { TopicValidationError } from "#topics/create";
import { TopicUpdateConflictError, updateTopicSettings } from "#topics/update";

const USER = "update-topic-settings-test-user";
const createdTopicIds: string[] = [];

function seedTopic(
  overrides: Partial<Parameters<typeof upsertTopic>[0]> = {},
): ReturnType<typeof getTopic> {
  const id = `update-topic-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `Update Topic ${id}`,
    kind: "agent",
    agent: "codex",
    aiMode: "always",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    participants: [{ userId: USER, role: "owner" }],
    surface: "otium",
    surfaceScope: null,
    createdAt: now,
    lastMessageAt: now,
    ...overrides,
  });
  createdTopicIds.push(id);
  return getTopic(id);
}

afterEach(() => {
  for (const topicId of createdTopicIds.splice(0)) {
    deleteApiTopicConfig(topicId);
    deleteTopic(topicId);
  }
});

describe("updateTopicSettings", () => {
  test("changes only the fields the caller sent", () => {
    const topic = seedTopic();
    if (!topic) throw new Error("seed failed");
    const updated = updateTopicSettings({ topicId: topic.id, title: "  Renamed Room  " });
    expect(updated.title).toBe("Renamed Room");
    // An absent agent/model/effort must not be read as "reset to defaults".
    expect(updated.agent).toBe("codex");
    expect(updated.defaultModel).toBe("gpt-5.6-luna");
    expect(updated.defaultEffort).toBe("medium");
    expect(getTopic(topic.id)?.title).toBe("Renamed Room");
  });

  test("switches the backend and re-derives a model the new backend can run", () => {
    const topic = seedTopic();
    if (!topic) throw new Error("seed failed");
    const updated = updateTopicSettings({ topicId: topic.id, agent: "claude" });
    expect(updated.agent).toBe("claude");
    // `gpt-5.6-luna` is not selectable on claude, so carrying it over would
    // persist a token the registry rejects on the very next turn.
    expect(updated.defaultModel).not.toBe("gpt-5.6-luna");
  });

  test("accepts a model and effort the chosen agent's registry knows", () => {
    const topic = seedTopic();
    if (!topic) throw new Error("seed failed");
    const updated = updateTopicSettings({
      topicId: topic.id,
      defaultModel: "gpt-5.6-terra",
      defaultEffort: "high",
    });
    expect(updated.defaultModel).toBe("gpt-5.6-terra");
    expect(updated.defaultEffort).toBe("high");
  });

  test("rejects a model or effort the chosen agent cannot run", () => {
    const topic = seedTopic();
    if (!topic) throw new Error("seed failed");
    expect(() => updateTopicSettings({ topicId: topic.id, defaultEffort: "turbo" })).toThrow(
      TopicValidationError,
    );
    // Validated against the agent named in the same request, not the stored
    // one, so a combined backend+model switch cannot land half-applied.
    expect(() =>
      updateTopicSettings({ topicId: topic.id, agent: "claude", defaultModel: "gpt-5.6-terra" }),
    ).toThrow(TopicValidationError);
    expect(
      updateTopicSettings({ topicId: topic.id, agent: "claude", defaultModel: "sonnet" })
        .defaultModel,
    ).toBe("sonnet");
  });

  test("a room with no AI cannot be given a model or an effort", () => {
    const topic = seedTopic({ kind: "channel", agent: undefined, aiMode: "off" });
    if (!topic) throw new Error("seed failed");
    expect(() => updateTopicSettings({ topicId: topic.id, defaultModel: "sonnet" })).toThrow(
      TopicValidationError,
    );
    expect(() => updateTopicSettings({ topicId: topic.id, defaultEffort: "high" })).toThrow(
      TopicValidationError,
    );
  });

  test("clears the per-topic override that would otherwise shadow the new default", () => {
    const topic = seedTopic();
    if (!topic) throw new Error("seed failed");
    setApiTopicConfig(topic.id, { model: "gpt-5.6-sol", effort: "max", mcp: ["wiki"] });
    updateTopicSettings({ topicId: topic.id, defaultModel: "gpt-5.6-terra" });
    const config = getApiTopicConfig(topic.id);
    expect(config?.model).toBeUndefined();
    // Untouched fields survive: only what the caller actually changed is cleared.
    expect(config?.effort).toBe("max");
    expect(config?.mcp).toEqual(["wiki"]);
  });

  test("removing the agent turns the room into a channel with the AI off", () => {
    const topic = seedTopic();
    if (!topic) throw new Error("seed failed");
    const updated = updateTopicSettings({ topicId: topic.id, agent: null });
    expect(updated.agent).toBeUndefined();
    expect(updated.kind).toBe("channel");
    expect(updated.aiMode).toBe("off");
  });

  test("aiMode and agent can never be written in a contradictory pair", () => {
    const topic = seedTopic();
    if (!topic) throw new Error("seed failed");
    // "off" on a room that still names an agent would read as an AI room that
    // never answers; normalization drops the agent instead.
    const off = updateTopicSettings({ topicId: topic.id, aiMode: "off" });
    expect(off.aiMode).toBe("off");
    expect(off.agent).toBeUndefined();

    const mention = updateTopicSettings({
      topicId: topic.id,
      agent: "maestro",
      aiMode: "mention",
    });
    expect(mention.kind).toBe("channel");
    expect(mention.aiMode).toBe("mention");
    expect(mention.agent).toBe("maestro");
  });

  test("rejects an empty or reserved title and a title another room already holds", () => {
    const topic = seedTopic();
    const other = seedTopic();
    if (!topic || !other) throw new Error("seed failed");
    expect(() => updateTopicSettings({ topicId: topic.id, title: "   " })).toThrow(
      TopicValidationError,
    );
    expect(() => updateTopicSettings({ topicId: topic.id, title: "general" })).toThrow(
      TopicValidationError,
    );
    expect(() => updateTopicSettings({ topicId: topic.id, title: other.title })).toThrow(
      TopicUpdateConflictError,
    );
    // Its own current title is not a conflict with itself.
    expect(updateTopicSettings({ topicId: topic.id, title: topic.title }).title).toBe(topic.title);
  });

  test("refuses an unknown agent and a missing topic", () => {
    const topic = seedTopic();
    if (!topic) throw new Error("seed failed");
    expect(() => updateTopicSettings({ topicId: topic.id, agent: "gemini" as never })).toThrow(
      TopicValidationError,
    );
    expect(() => updateTopicSettings({ topicId: "no-such-topic", title: "x" })).toThrow(
      TopicValidationError,
    );
  });
});
