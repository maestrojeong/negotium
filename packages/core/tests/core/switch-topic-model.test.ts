import { afterEach, describe, expect, test } from "bun:test";
import { SELECTABLE_MODELS, selectableModel } from "#agents/model-catalog";
import { switchTopicModel } from "#application/switch-topic-model";
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

const USER = "switch-topic-model-test-user";
const createdTopicIds: string[] = [];

function seedTopic(agent: "codex" | "maestro" = "codex"): string {
  const id = `switch-model-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `Switch Model ${id}`,
    kind: "agent",
    agent,
    aiMode: "always",
    defaultModel: agent === "codex" ? "gpt-5.6-luna" : "deepseek-pro",
    defaultEffort: "medium",
    participants: [{ userId: USER, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  createdTopicIds.push(id);
  return id;
}

afterEach(() => {
  for (const topicId of createdTopicIds.splice(0)) {
    deleteApiTopicConfig(topicId);
    deleteTopic(topicId);
  }
});

describe("topic model picker", () => {
  test("publishes the supported model choices and descriptions", () => {
    expect(SELECTABLE_MODELS.map(({ model }) => model)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "fable",
      "opus",
      "sonnet",
      "kimi-k3",
      "kimi-k2.7-code",
      "deepseek-pro",
    ]);
    expect(selectableModel("GPT-5.6-SOL")?.model).toBe("gpt-5.6-sol");
    expect(selectableModel("gpt-5.6-sol")?.intelligenceTier).toBe("fable");
    expect(selectableModel("gpt-5.6-terra")?.intelligenceTier).toBe("opus");
    expect(selectableModel("sonnet")?.intelligenceTier).toBe("sonnet");
    expect(selectableModel("gpt-5.6-luna")?.accessCost).toContain("$200/month");
    expect(selectableModel("gpt-5.6-luna")?.marginalTokenCost).toContain("$1/M");
    expect(selectableModel("opus")?.marginalTokenCost).toContain("$25/M output");
    expect(selectableModel("gpt-5.6-luna")?.estimatedUsage).toContain("1,000–5,600");
    expect(selectableModel("fable")?.estimatedUsage).toContain("explicit user request");
    expect(selectableModel("deepseek-pro")?.marginalTokenCost).toContain("$0.435/M");
    expect(selectableModel("kimi")?.model).toBe("kimi-k3");
    expect(selectableModel("kimi-pro")?.model).toBe("kimi-k3");
    expect(selectableModel("kimi-code")?.model).toBe("kimi-k2.7-code");
    expect(selectableModel("kimi-k3")?.intelligenceTier).toBe("fable");
    expect(selectableModel("kimi-k2.7-code")?.intelligenceTier).toBe("opus");
    expect(selectableModel("gpt-5.5")).toBeUndefined();
    expect(selectableModel("deepseek-flash")).toBeUndefined();
  });

  test("persists and locks a selected model without exposing its agent", () => {
    const topicId = seedTopic();
    setTopicSessionId(topicId, "old-codex-session", { reason: "test", agent: "codex" });

    const result = switchTopicModel({ topicId, userId: USER, model: "gpt-5.6-sol" });

    expect(result).toEqual({
      ok: true,
      model: "gpt-5.6-sol",
      text: "Model set to 'gpt-5.6-sol'. Applies from the next turn.",
    });
    expect(getApiTopicConfig(topicId)).toMatchObject({
      model: "gpt-5.6-sol",
      agentLocked: true,
      modelLocked: true,
    });
    expect(getTopicSessionId(topicId)).toBeNull();
  });

  test("resolves a cross-runtime model to its agent internally", () => {
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-key";
    try {
      const topicId = seedTopic("codex");
      const result = switchTopicModel({ topicId, userId: USER, model: "deepseek-pro" });

      expect(result.ok).toBe(true);
      expect(getTopic(topicId)?.agent).toBe("maestro");
      expect(getApiTopicConfig(topicId)?.model).toBe("deepseek-pro");
      if (result.ok) expect(result.text).not.toContain("maestro");
    } finally {
      if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousKey;
    }
  });

  test("canonicalizes a Kimi alias and requires Moonshot authentication", () => {
    const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
    const previousMoonshot = process.env.MOONSHOT_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    try {
      const topicId = seedTopic("maestro");
      setApiTopicConfig(topicId, { model: "kimi-pro" });
      setTopicSessionId(topicId, "existing-kimi-session", {
        reason: "test",
        agent: "maestro",
      });
      const result = switchTopicModel({ topicId, userId: USER, model: "kimi-pro" });

      expect(result).toMatchObject({ ok: true, model: "kimi-k3" });
      expect(getApiTopicConfig(topicId)?.model).toBe("kimi-k3");
      expect(getTopicSessionId(topicId)).toBe("existing-kimi-session");
    } finally {
      if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previousDeepSeek;
      if (previousMoonshot === undefined) delete process.env.MOONSHOT_API_KEY;
      else process.env.MOONSHOT_API_KEY = previousMoonshot;
    }
  });
});
