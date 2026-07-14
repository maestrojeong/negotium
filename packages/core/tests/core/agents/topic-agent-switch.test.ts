import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRegistry } from "#agents/registry";
import { switchTopicAgent } from "#agents/topic-agent-switch";
import { SESSION_WORKSPACE_DIR, WORKSPACE_DIR } from "#platform/config";
import {
  appendConversationEvent,
  getConversationPath,
  readConversation,
} from "#storage/conversations";
import * as repo from "#storage/forum/index";
import { db } from "#storage/forum/schema";
import type { AgentKind } from "#types";

/**
 * Cross-agent set_agent integration tests (I4 fix from the 2026-05-16 audit).
 *
 * The audit found four of the six (claude↔codex↔maestro) switch directions had
 * zero integration coverage — only single-writer rollout tests existed. This
 * suite locks in the full end-to-end contract for every direction:
 *
 *   1. Fresh start (no prior history): outcome `kind: "fresh"`, DB agent
 *      updated, session cleared, no rollout file expected.
 *   2. Bridged (prior history exists): outcome `kind: "bridged"`, synthetic
 *      rollout file written at the target SDK's native path, DB
 *      session_id == bridgedSessionId, unified log appended with the new
 *      session event.
 *   3. Round-trip A→B→A: second switch back to A reuses the most recent
 *      sessionId for A via `findLastSessionIdForAgent`, so the synthetic
 *      file lands at the path A's SDK already manages (prompt-cache
 *      continuity).
 *
 * The user-side flow goes through runtime's set_agent MCP tool,
 * but every state transition that matters is owned by `switchTopicAgent`
 * here, so we test it directly. The MCP wrapper is a thin formatter.
 */

// Per-suite tmp WORKSPACE_DIR child for any synthetic rollouts that write
// claude-style cwd-encoded paths (`~/.claude/projects/<encoded-cwd>/<sid>.jsonl`).
// Session rollouts use SESSION_WORKSPACE_DIR, so pre-create it to keep the
// writers' `ensureCwdExists` check happy.
mkdirSync(WORKSPACE_DIR, { recursive: true });
const TMP_PARENT = mkdtempSync(join(WORKSPACE_DIR, "test-switch-"));
const writtenRollouts: Array<{ agent: AgentKind; sessionId: string }> = [];
let nextUserId = 9_900_000;

// CI runners have no real agent credentials, so checkAgentAuth (the v0.2.12
// unauthenticated-switch guard, run before any state change) would block every
// switch and fail this suite. Satisfy each backend's auth probe with throwaway
// env/files. Restored in afterAll so it doesn't leak into sibling suites that
// share the test process.
const CODEX_AUTH_FILE = join(TMP_PARENT, "codex-auth.json");
writeFileSync(CODEX_AUTH_FILE, "{}");
const PREV_AUTH_ENV: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  NEGOTIUM_CODEX_AUTH_FILE: process.env.NEGOTIUM_CODEX_AUTH_FILE,
};

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-anthropic-key";
  process.env.DEEPSEEK_API_KEY ||= "test-deepseek-key";
  process.env.NEGOTIUM_CODEX_AUTH_FILE = CODEX_AUTH_FILE;
});

afterAll(async () => {
  for (const [k, v] of Object.entries(PREV_AUTH_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const agent of ["claude", "codex", "maestro"] as const) {
    const sessionIds = [
      ...new Set(
        writtenRollouts
          .filter((rollout) => rollout.agent === agent)
          .map((rollout) => rollout.sessionId),
      ),
    ];
    try {
      await getRegistry(agent).cleanupRollouts({ cwd: SESSION_WORKSPACE_DIR, sessionIds });
    } catch {}
  }
  try {
    rmSync(TMP_PARENT, { recursive: true, force: true });
  } catch {}
});

function seedUser(userId: number): void {
  db.query("INSERT OR IGNORE INTO users (id) VALUES (?)").run(String(userId));
  mkdirSync(SESSION_WORKSPACE_DIR, { recursive: true });
}

function freshUserId(): number {
  nextUserId++;
  return nextUserId;
}

function seedTopic(userId: number, topicName: string, agent: AgentKind = "claude"): void {
  repo.addTopic(userId, topicName, 100 + (userId % 1000), undefined, undefined);
  // These tests exercise explicit switch directions; keep the seed independent
  // from whatever SESSION_AGENT the process is configured with.
  db.query("UPDATE topics SET agent = ? WHERE user_id = ? AND name = ?").run(
    agent,
    String(userId),
    topicName,
  );
}

/** Pretend the topic has had a real conversation by appending a couple of
 *  ChatPair-yielding events to the unified log. switchTopicAgent reads this
 *  via `readConversation` and feeds it to the target registry's writeRollout.
 *
 *  Returns the seeded sessionId so round-trip tests can assert it's reused
 *  after A → B → A. The id must match `UUID_RE` in rollout/shared.ts since
 *  every native rollout writer runs `assertUuidLike` on it. */
function seedHistory(userId: number, topicName: string, originAgent: AgentKind): string {
  appendConversationEvent(userId, topicName, originAgent, {
    type: "user_message",
    content: "hello there",
  });
  appendConversationEvent(userId, topicName, originAgent, {
    type: "result",
    content: "general kenobi",
    stopReason: "end_turn",
  });
  // Tag a prior session id so findLastSessionIdForAgent has something to
  // discover for round-trip tests. Real UUID required — every registry's
  // writeRollout runs assertUuidLike on the reused id.
  const sid = randomUUID();
  appendConversationEvent(userId, topicName, originAgent, { type: "session", sessionId: sid });
  return sid;
}

beforeEach(() => {
  db.exec("DELETE FROM topics");
  db.exec("DELETE FROM users");
});

// --- 1. Fresh-start matrix (6 directions, no prior history) ---

describe("switchTopicAgent — fresh start (no history)", () => {
  const directions: Array<[AgentKind, AgentKind]> = [
    ["claude", "codex"],
    ["claude", "maestro"],
    ["codex", "claude"],
    ["codex", "maestro"],
    ["maestro", "claude"],
    ["maestro", "codex"],
  ];

  for (const [from, to] of directions) {
    test(`${from} → ${to}: outcome fresh (no-history), DB pinned`, () => {
      const userId = freshUserId();
      const topic = `t-${from}-${to}-fresh`;
      seedUser(userId);
      seedTopic(userId, topic, from);

      const result = switchTopicAgent(userId, topic, to);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.kind).toBe("fresh");
      if (result.outcome.kind === "fresh") {
        expect(result.outcome.agent).toBe(to);
        expect(result.outcome.reason).toBe("no-history");
      }

      const row = repo.getTopicByName(userId, topic);
      expect(row?.agent).toBe(to);
      // rowToTopic maps DB session_id=NULL to empty string for backward
      // compat. Fresh start ⇒ session_id cleared in DB ⇒ "" here.
      expect(row?.sessionId).toBe("");
    });
  }
});

// --- 2. Bridged matrix (6 directions, with prior history) ---

describe("switchTopicAgent — bridged (with history)", () => {
  const directions: Array<[AgentKind, AgentKind]> = [
    ["claude", "codex"],
    ["claude", "maestro"],
    ["codex", "claude"],
    ["codex", "maestro"],
    ["maestro", "claude"],
    ["maestro", "codex"],
  ];

  for (const [from, to] of directions) {
    test(`${from} → ${to}: outcome bridged, rollout file written, DB session_id set`, () => {
      const userId = freshUserId();
      const topic = `t-${from}-${to}-bridged`;
      seedUser(userId);
      seedTopic(userId, topic, from);
      seedHistory(userId, topic, from);

      const result = switchTopicAgent(userId, topic, to);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.outcome.kind).toBe("bridged");
      if (result.outcome.kind !== "bridged") return;

      const { bridgedSessionId } = result.outcome;
      expect(bridgedSessionId).toBeTruthy();
      writtenRollouts.push({ agent: to, sessionId: bridgedSessionId });

      // DB session_id flipped to the synthetic id.
      const row = repo.getTopicByName(userId, topic);
      expect(row?.agent).toBe(to);
      expect(row?.sessionId).toBe(bridgedSessionId);

      // Unified log got a new {type:"session"} event for the bridged sid so
      // a follow-up switch can discover it via findLastSessionIdForAgent.
      const conv = getConversationPath(userId, topic);
      expect(existsSync(conv)).toBe(true);
      const entries = readConversation(userId, topic);
      expect(
        entries.some(
          (e) =>
            e.agent === to && e.event.type === "session" && e.event.sessionId === bridgedSessionId,
        ),
      ).toBe(true);
    });
  }
});

// --- 3. Round-trip matrix: A → B → A reuses A's original session id ---

describe("switchTopicAgent — round-trip reuses prior sessionId", () => {
  const directions: Array<[AgentKind, AgentKind]> = [
    ["claude", "codex"],
    ["claude", "maestro"],
    ["codex", "claude"],
    ["codex", "maestro"],
    ["maestro", "claude"],
    ["maestro", "codex"],
  ];

  for (const [a, b] of directions) {
    test(`${a} → ${b} → ${a}: second ${a} reuses ${a}'s seeded sessionId`, () => {
      const userId = freshUserId();
      const topic = `t-${a}-${b}-${a}-rt`;
      seedUser(userId);
      seedTopic(userId, topic, a);
      const seededSid = seedHistory(userId, topic, a);

      // A → B (bridges; conversation log now also has a session event for B).
      const first = switchTopicAgent(userId, topic, b);
      expect(first.ok).toBe(true);
      if (!first.ok || first.outcome.kind !== "bridged") return;
      writtenRollouts.push({ agent: b, sessionId: first.outcome.bridgedSessionId });

      // B → A (must re-pick the SEEDED sessionId for A, not mint a new one).
      const second = switchTopicAgent(userId, topic, a);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.outcome.kind).toBe("bridged");
      if (second.outcome.kind !== "bridged") return;
      writtenRollouts.push({ agent: a, sessionId: second.outcome.bridgedSessionId });

      // findLastSessionIdForAgent walks the unified log backwards for the
      // most recent `session` event whose `agent === a`. The seeded sid is
      // forwarded as reuseSessionId to the target registry. Each writer
      // uses it as the SDK's resume key (claude sessionId / codex threadId
      // / maestro sessionId), so the returned bridgedSessionId matches.
      expect(second.outcome.bridgedSessionId).toBe(seededSid);
    });
  }
});

// --- 4. No-op when target equals current ---

describe("switchTopicAgent — noop edge cases", () => {
  test("switching to the same agent returns kind:noop without touching DB or rollout", () => {
    const userId = freshUserId();
    const topic = "t-noop";
    seedUser(userId);
    seedTopic(userId, topic, "claude");
    // Set a session id so we can verify it didn't change.
    repo.setSessionForTopic(userId, topic, "session-sentinel");

    const result = switchTopicAgent(userId, topic, "claude");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.kind).toBe("noop");

    const row = repo.getTopicByName(userId, topic);
    expect(row?.agent).toBe("claude");
    expect(row?.sessionId).toBe("session-sentinel");
  });

  test("invalid agent string returns ok:false", () => {
    const userId = freshUserId();
    const topic = "t-invalid";
    seedUser(userId);
    seedTopic(userId, topic, "claude");

    const result = switchTopicAgent(userId, topic, "foo" as AgentKind);
    expect(result.ok).toBe(false);
  });

  test("unknown topic returns ok:false", () => {
    const userId = freshUserId();
    seedUser(userId);
    const result = switchTopicAgent(userId, "missing-topic", "maestro");
    expect(result.ok).toBe(false);
  });
});
