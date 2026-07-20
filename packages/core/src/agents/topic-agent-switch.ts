/**
 * Atomic agent-switch operation for a forum topic.
 *
 * Shared by API routes and runtime self-config tools when switching a topic's
 * agent backend. Both call sites share:
 *
 *   - rollout bridging (writes a synthetic native rollout for the target
 *     SDK so the new backend resumes with the cross-agent conversation),
 *   - atomic UPDATE of `agent` + `session_id` so a concurrent query can
 *     never observe the new agent paired with the stale old-agent session,
 *   - orphan-rollout cleanup if the DB commit fails after the rollout file
 *     was already written.
 *
 * Every code path returns a structured result so callers can format their
 * own response. Logging stays inside this module so callers do not have to
 * duplicate the diagnostic context.
 */
import { unlinkSync } from "node:fs";
import { checkAgentModelAuth } from "#agents/auth-check";
import { isAgentKind } from "#agents/index";
import { resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { SESSION_WORKSPACE_DIR } from "#platform/config";
import { logger } from "#platform/logger";
import {
  appendConversationEventStrict,
  findLastSessionIdForAgent,
  readConversation,
} from "#storage/conversations";
import {
  getTopicAgentSwitchState,
  setTopicAgentAndClearSession,
  setTopicAgentAndSession,
} from "#storage/topic-settings";
import type { AgentKind } from "#types";

export type SwitchAgentOutcome =
  | { kind: "noop"; agent: AgentKind }
  | {
      kind: "fresh";
      agent: AgentKind;
      reason: "no-history" | "bridge-failed";
    }
  | {
      kind: "bridged";
      agent: AgentKind;
      bridgedSessionId: string;
    };

export type SwitchAgentResult =
  | { ok: true; outcome: SwitchAgentOutcome }
  | { ok: false; error: string };

/**
 * Switch the active agent for a topic, bridging conversation history into a
 * native rollout for the target SDK when prior turns exist. Idempotent: a
 * call that targets the current agent returns `{kind: "noop"}` without
 * touching the DB or filesystem.
 */
export function switchTopicAgent(
  userId: number,
  topicName: string,
  agent: AgentKind,
): SwitchAgentResult {
  if (!isAgentKind(agent)) {
    return { ok: false, error: `invalid agent '${agent}'` };
  }
  const topic = getTopicAgentSwitchState(userId, topicName);
  if (!topic) {
    return { ok: false, error: `topic "${topicName}" not found` };
  }
  if (topic.agent === agent) {
    return { ok: true, outcome: { kind: "noop", agent } };
  }

  // Auth precondition — block the switch if the target backend isn't
  // authenticated, otherwise the topic flips and every subsequent turn
  // fails inside the provider with an opaque per-turn error.
  const registry = getRegistry(agent);
  const targetModel = resolveModelForAgent(agent, undefined, registry);
  const auth = checkAgentModelAuth(agent, targetModel);
  if (!auth.ok) return { ok: false, error: auth.error };

  const oldAgent = topic.agent;

  const conversationEntries = readConversation(userId, topicName);

  // No prior history → simple switch, clear session, fresh start.
  if (conversationEntries.length === 0) {
    const changed = setTopicAgentAndClearSession({
      userId,
      topicName,
      agent,
    });
    if (!changed) return { ok: false, error: `failed to set agent for "${topicName}"` };
    return {
      ok: true,
      outcome: { kind: "fresh", agent, reason: "no-history" },
    };
  }

  // History exists → synthesize a native rollout for the target SDK so the
  // new backend resumes with the cross-agent conversation already loaded.
  //
  // If the user has been on the target agent before (e.g. claude → codex →
  // claude round-trip), reuse the most recent session id for that agent so
  // the synthetic file lands at the path the SDK already manages. This
  // avoids two failure modes:
  //   1. Orphan SDK rollouts piling up under `~/.claude/projects/<dir>/`
  //      (one per round-trip) without ever being resumed again.
  //   2. The SDK's prompt-cache resetting each switch because the resume
  //      key changes — even though logical history is identical.
  const cwd = SESSION_WORKSPACE_DIR;
  const reuseSessionId = findLastSessionIdForAgent(conversationEntries, agent) ?? undefined;
  let bridgedSessionId: string;
  let rolloutPath: string;
  try {
    const registry = getRegistry(agent);
    const result = registry.writeRollout({
      cwd,
      entries: conversationEntries,
      model: resolveModelForAgent(agent, undefined, registry),
      ...(registry.defaultEffort ? { effort: registry.defaultEffort } : {}),
      ...(reuseSessionId ? { reuseSessionId } : {}),
    });
    bridgedSessionId = result.sessionId;
    rolloutPath = result.rolloutPath;
  } catch (err) {
    logger.warn(
      { err, userId, topicName, from: oldAgent, to: agent },
      "switchTopicAgent: rollout encoding failed — falling back to fresh session",
    );
    const changed = setTopicAgentAndClearSession({
      userId,
      topicName,
      agent,
    });
    if (!changed) return { ok: false, error: `failed to set agent for "${topicName}"` };
    return {
      ok: true,
      outcome: { kind: "fresh", agent, reason: "bridge-failed" },
    };
  }

  // Manifest the synthetic rollout before the DB commit. This is not a true
  // SQLite+filesystem transaction, but it avoids the dangerous split-brain
  // state where DB.session_id points at a rollout that the unified manifest
  // cannot discover for round-trip reuse or cleanup.
  try {
    appendConversationEventStrict(userId, topicName, agent, {
      type: "session",
      sessionId: bridgedSessionId,
    });
  } catch (err) {
    try {
      unlinkSync(rolloutPath);
    } catch (_) {
      // best-effort
    }
    logger.warn(
      { err, userId, topicName, rolloutPath },
      "switchTopicAgent: manifest append failed, removed orphan rollout",
    );
    return { ok: false, error: `failed to record agent switch for "${topicName}"` };
  }

  // Atomic DB commit: agent and session_id in one transaction. If it fails,
  // unlink the orphan rollout. The manifest entry
  // above may remain, but cleanup tolerates ENOENT and future bridge attempts
  // can safely reuse that id by overwriting the rollout.
  try {
    setTopicAgentAndSession({
      userId,
      topicName,
      agent,
      sessionId: bridgedSessionId,
    });
  } catch (err) {
    try {
      unlinkSync(rolloutPath);
    } catch (_) {
      // best-effort
    }
    logger.warn(
      { err, userId, topicName, rolloutPath },
      "switchTopicAgent: DB commit failed, removed orphan rollout",
    );
    return { ok: false, error: `failed to commit agent switch for "${topicName}"` };
  }

  return {
    ok: true,
    outcome: { kind: "bridged", agent, bridgedSessionId },
  };
}
