import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { switchApiTopicAgent } from "#agents/api-topic-agent-switch";
import { getRegistryOperations } from "#agents/registry";
import { WORKSPACE_DIR } from "#platform/config";
import { deleteApiTopicConfig, getApiTopicConfig } from "#storage/api-topic-config";
import {
  deleteTopic,
  getTopic,
  getTopicSessionId,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import { appendConversationEventStrict, getConversationPath } from "#storage/conversations";

const USER_ID = `api-switch-${randomUUID()}`;
const TEST_ROOT = mkdtempSync(join(WORKSPACE_DIR, "api-agent-switch-"));
const CODEX_AUTH_FILE = join(TEST_ROOT, "codex-auth.json");
const createdTopicIds: string[] = [];
const cleanupRollouts: Array<{
  agent: "claude" | "codex" | "maestro";
  cwd: string;
  sessionId: string;
}> = [];
const previousEnv = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  NEGOTIUM_CODEX_AUTH_FILE: process.env.NEGOTIUM_CODEX_AUTH_FILE,
};

function uuidV7At(date: Date): string {
  const hex = date.getTime().toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8abc-abcdef012345`;
}

function seedTopic(agent: "claude" | "codex", title: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const cwd = join(TEST_ROOT, id);
  mkdirSync(cwd, { recursive: true });
  upsertTopic({
    id,
    title,
    kind: "agent",
    agent,
    aiMode: "always",
    defaultModel: agent === "codex" ? "gpt-5.6-luna" : "sonnet",
    defaultEffort: "medium",
    participants: [{ userId: USER_ID, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  createdTopicIds.push(id);
  return { id, cwd };
}

function seedHistory(title: string, agent: "claude" | "codex", sessionId: string): void {
  appendConversationEventStrict(USER_ID, title, agent, {
    type: "user_message",
    content: "preserve this history",
  });
  appendConversationEventStrict(USER_ID, title, agent, {
    type: "result",
    content: "history preserved",
    stopReason: "end_turn",
  });
  appendConversationEventStrict(USER_ID, title, agent, {
    type: "session",
    sessionId,
  });
}

beforeAll(() => {
  mkdirSync(TEST_ROOT, { recursive: true });
  writeFileSync(CODEX_AUTH_FILE, "{}");
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.NEGOTIUM_CODEX_AUTH_FILE = CODEX_AUTH_FILE;
});

afterAll(async () => {
  for (const rollout of cleanupRollouts) {
    try {
      await getRegistryOperations(rollout.agent).cleanupRollouts({
        cwd: rollout.cwd,
        sessionIds: [rollout.sessionId],
      });
    } catch {}
  }
  for (const topicId of createdTopicIds) {
    const topic = getTopic(topicId);
    if (topic) rmSync(getConversationPath(USER_ID, topic.title), { force: true });
    deleteApiTopicConfig(topicId);
    deleteTopic(topicId);
  }
  if (previousEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousEnv.ANTHROPIC_API_KEY;
  if (previousEnv.NEGOTIUM_CODEX_AUTH_FILE === undefined) {
    delete process.env.NEGOTIUM_CODEX_AUTH_FILE;
  } else {
    process.env.NEGOTIUM_CODEX_AUTH_FILE = previousEnv.NEGOTIUM_CODEX_AUTH_FILE;
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("switchApiTopicAgent", () => {
  test("Codex → Claude → Codex reuses the canonical Codex rollout path", () => {
    const title = `api-roundtrip-${randomUUID()}`;
    const topic = seedTopic("codex", title);
    const createdAt = new Date(2026, 6, 17, 9, 8, 7, 123);
    const codexSessionId = uuidV7At(createdAt);
    seedHistory(title, "codex", codexSessionId);
    setTopicSessionId(topic.id, codexSessionId, { reason: "test", agent: "codex" });

    const toClaude = switchApiTopicAgent({
      topicId: topic.id,
      topicTitle: title,
      userId: USER_ID,
      fromAgent: "codex",
      agent: "claude",
      cwd: topic.cwd,
      config: { model: "sonnet" },
      reason: "test-roundtrip",
    });
    expect(toClaude.ok).toBe(true);
    if (!toClaude.ok || toClaude.outcome.kind !== "bridged") return;
    cleanupRollouts.push({
      agent: "claude",
      cwd: topic.cwd,
      sessionId: toClaude.outcome.bridgedSessionId,
    });

    const toCodex = switchApiTopicAgent({
      topicId: topic.id,
      topicTitle: title,
      userId: USER_ID,
      fromAgent: "claude",
      agent: "codex",
      cwd: topic.cwd,
      config: { model: "gpt-5.6-sol" },
      reason: "test-roundtrip",
    });
    expect(toCodex.ok).toBe(true);
    if (!toCodex.ok || toCodex.outcome.kind !== "bridged") return;
    cleanupRollouts.push({
      agent: "codex",
      cwd: topic.cwd,
      sessionId: toCodex.outcome.bridgedSessionId,
    });

    expect(toCodex.outcome.bridgedSessionId).toBe(codexSessionId);
    expect(toCodex.outcome.rolloutPath).toContain(
      join("2026", "07", "17", `rollout-2026-07-17T09-08-07-${codexSessionId}.jsonl`),
    );
    expect(existsSync(toCodex.outcome.rolloutPath)).toBe(true);
    expect(getTopicSessionId(topic.id)).toBe(codexSessionId);
  });

  test("bridge failure preserves the current agent, session, and config", () => {
    const title = `api-failure-${randomUUID()}`;
    const topic = seedTopic("claude", title);
    const claudeSessionId = randomUUID();
    seedHistory(title, "claude", claudeSessionId);
    setTopicSessionId(topic.id, claudeSessionId, { reason: "test", agent: "claude" });

    const result = switchApiTopicAgent({
      topicId: topic.id,
      topicTitle: title,
      userId: USER_ID,
      fromAgent: "claude",
      agent: "codex",
      cwd: "/outside-negotium-workspace",
      config: { model: "gpt-5.6-sol", modelLocked: true },
      reason: "test-failure",
    });

    expect(result.ok).toBe(false);
    expect(getTopic(topic.id)?.agent).toBe("claude");
    expect(getTopicSessionId(topic.id)).toBe(claudeSessionId);
    expect(getApiTopicConfig(topic.id)).toBeUndefined();
  });
});
