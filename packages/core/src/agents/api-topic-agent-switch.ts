import { unlinkSync } from "node:fs";
import { checkAgentAuth } from "#agents/auth-check";
import { resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { logger } from "#platform/logger";
import { setApiTopicConfig, type TopicConfig } from "#storage/api-topic-config";
import { clearTopicSessionId, setApiTopicAgent, setTopicSessionId } from "#storage/api-topics";
import {
  appendConversationEventStrict,
  findLastSessionIdForAgent,
  readConversation,
} from "#storage/conversations";
import type { AgentKind, EffortLevel } from "#types";

export type ApiTopicSwitchOutcome =
  | { kind: "fresh"; agent: AgentKind; reason: "no-history" | "bridge-failed" }
  | { kind: "bridged"; agent: AgentKind; bridgedSessionId: string; rolloutPath: string };

export type ApiTopicSwitchResult =
  | { ok: true; outcome: ApiTopicSwitchOutcome }
  | { ok: false; error: string };

export interface SwitchApiTopicAgentOptions {
  topicId: string;
  topicTitle: string;
  userId: string;
  fromAgent?: AgentKind;
  agent: AgentKind;
  cwd: string;
  config: TopicConfig;
  /** Topic base values used when config has no explicit override. */
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  reason: string;
}

function commitApiTopicSwitch(
  opts: SwitchApiTopicAgentOptions,
  bridgedSessionId: string | null,
): void {
  setApiTopicAgent(opts.topicId, opts.agent);
  setApiTopicConfig(opts.topicId, opts.config);
  if (bridgedSessionId) {
    setTopicSessionId(opts.topicId, bridgedSessionId, {
      reason: opts.reason,
      agent: opts.agent,
    });
  } else {
    clearTopicSessionId(opts.topicId, opts.reason);
  }
}

/**
 * API-topic equivalent of `switchTopicAgent`: all web/MCP agent changes must
 * pass through this path so the synthetic SDK rollout, unified-log manifest,
 * and durable topic session stay in sync.
 */
export function switchApiTopicAgent(opts: SwitchApiTopicAgentOptions): ApiTopicSwitchResult {
  const auth = checkAgentAuth(opts.agent);
  if (!auth.ok) return { ok: false, error: auth.error };

  const entries = readConversation(opts.userId, opts.topicTitle);
  if (entries.length === 0) {
    try {
      commitApiTopicSwitch(opts, null);
    } catch (err) {
      logger.warn({ err, topicId: opts.topicId, agent: opts.agent }, "api-topic switch failed");
      return { ok: false, error: `failed to set agent for "${opts.topicTitle}"` };
    }
    return { ok: true, outcome: { kind: "fresh", agent: opts.agent, reason: "no-history" } };
  }

  let bridgedSessionId: string;
  let rolloutPath: string;
  try {
    const reuseSessionId = findLastSessionIdForAgent(entries, opts.agent) ?? undefined;
    const registry = getRegistry(opts.agent);
    const model = resolveModelForAgent(
      opts.agent,
      opts.config.model ?? opts.defaultModel,
      registry,
    );
    const requestedEffort = opts.config.effort ?? opts.defaultEffort;
    const effort =
      requestedEffort && registry.validateEffort(requestedEffort)
        ? requestedEffort
        : registry.defaultEffort;
    const result = registry.writeRollout({
      cwd: opts.cwd,
      entries,
      model,
      ...(effort ? { effort } : {}),
      ...(reuseSessionId ? { reuseSessionId } : {}),
    });
    bridgedSessionId = result.sessionId;
    rolloutPath = result.rolloutPath;
  } catch (err) {
    logger.warn(
      {
        err,
        topicId: opts.topicId,
        topicTitle: opts.topicTitle,
        from: opts.fromAgent,
        to: opts.agent,
      },
      "api-topic switch: rollout encoding failed — falling back to fresh session",
    );
    try {
      commitApiTopicSwitch(opts, null);
    } catch (commitErr) {
      logger.warn(
        { err: commitErr, topicId: opts.topicId, agent: opts.agent },
        "api-topic switch fallback commit failed",
      );
      return { ok: false, error: `failed to set agent for "${opts.topicTitle}"` };
    }
    return { ok: true, outcome: { kind: "fresh", agent: opts.agent, reason: "bridge-failed" } };
  }

  try {
    appendConversationEventStrict(opts.userId, opts.topicTitle, opts.agent, {
      type: "session",
      sessionId: bridgedSessionId,
    });
  } catch (err) {
    try {
      unlinkSync(rolloutPath);
    } catch {
      // best-effort
    }
    logger.warn(
      { err, topicId: opts.topicId, rolloutPath },
      "api-topic switch: manifest append failed, removed orphan rollout",
    );
    return { ok: false, error: `failed to record agent switch for "${opts.topicTitle}"` };
  }

  try {
    commitApiTopicSwitch(opts, bridgedSessionId);
  } catch (err) {
    try {
      unlinkSync(rolloutPath);
    } catch {
      // best-effort
    }
    logger.warn(
      { err, topicId: opts.topicId, rolloutPath },
      "api-topic switch: config/session commit failed, removed orphan rollout",
    );
    return { ok: false, error: `failed to commit agent switch for "${opts.topicTitle}"` };
  }

  logger.info(
    {
      topicId: opts.topicId,
      from: opts.fromAgent,
      to: opts.agent,
      sessionId: bridgedSessionId,
      rolloutPath,
      entries: entries.length,
    },
    "api-topic switch: rollout bridged from unified log",
  );

  return {
    ok: true,
    outcome: { kind: "bridged", agent: opts.agent, bridgedSessionId, rolloutPath },
  };
}
