import { resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { getTopicConfig } from "#runtime/topic-config";
import { getTopicSessionId } from "#storage/api-topics";
import type { AgentKind, EffortLevel } from "#types";
import type { TopicDto } from "#types/api";

export interface AiTurnTopic {
  id: string;
  title: string;
  kind?: TopicDto["kind"];
  description?: string | null;
  agent?: AgentKind | null;
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  aiMode?: TopicDto["aiMode"];
  aiMention?: boolean;
}

export interface ResolvedTopicTurnExecution {
  agent: AgentKind;
  model: string;
  effort?: EffortLevel;
}

export interface TopicTurnExecutionOverrides {
  modelOverride?: string;
  effortOverride?: EffortLevel;
  agentOverride?: AgentKind;
}

/** One canonical resolver for provider execution and user-visible metadata. */
export function resolveTopicTurnExecution(
  topic: AiTurnTopic,
  overrides: TopicTurnExecutionOverrides = {},
): ResolvedTopicTurnExecution {
  const config = getTopicConfig(topic.id);
  const agent = (overrides.agentOverride ?? topic.agent ?? "maestro") as AgentKind;
  const registry = getRegistry(agent);
  const usesTopicDefaults = !overrides.agentOverride || overrides.agentOverride === topic.agent;
  const model = resolveModelForAgent(
    agent,
    overrides.modelOverride ??
      (usesTopicDefaults ? (config?.model ?? topic.defaultModel) : undefined),
    registry,
  );
  const requestedEffort = (overrides.effortOverride ??
    (usesTopicDefaults ? (config?.effort ?? topic.defaultEffort) : undefined)) as
    | EffortLevel
    | undefined;
  const effort =
    requestedEffort && registry.validateEffort(requestedEffort)
      ? requestedEffort
      : registry.defaultEffort;
  return { agent, model, ...(effort ? { effort } : {}) };
}

export interface ResolvedTopicTurnSession {
  sessionId: string | null | undefined;
  isolated: boolean;
}

export interface TopicTurnSessionOptions extends TopicTurnExecutionOverrides {
  silent?: boolean;
  sessionScope?: "topic" | "isolated";
  sessionName?: string;
  sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
  hasFork?: boolean;
  preparesSession?: boolean;
  externalSessionOwner?: boolean;
}

/**
 * Resolve topic-session ownership from execution compatibility, rather than
 * asking each adapter to remember when a provider session is safe to reuse.
 */
export function resolveTopicTurnSession(
  topic: AiTurnTopic,
  requestedSessionId: string | null | undefined,
  options: TopicTurnSessionOptions = {},
): ResolvedTopicTurnSession {
  const main = resolveTopicTurnExecution(topic);
  const requested = resolveTopicTurnExecution(topic, options);
  const incompatibleWithMain = requested.agent !== main.agent || requested.model !== main.model;
  const alternateNamespace =
    (options.sessionName !== undefined && options.sessionName !== topic.title) ||
    options.sessionType === "cron";
  const isolated = Boolean(
    options.sessionScope === "isolated" ||
      options.silent ||
      options.hasFork ||
      options.preparesSession ||
      options.externalSessionOwner ||
      incompatibleWithMain ||
      alternateNamespace,
  );
  return {
    sessionId: resolveInitialTurnSessionId(topic.id, requestedSessionId, isolated),
    isolated,
  };
}

/**
 * Resolve the provider resume key for a new turn. Direct user/channel turns
 * inherit the topic's durable session unless a caller explicitly supplies a
 * key (including null for an intentional fresh start).
 */
export function resolveInitialTurnSessionId(
  topicId: string,
  requestedSessionId: string | null | undefined,
  isolated: boolean,
): string | null | undefined {
  if (requestedSessionId !== undefined) return requestedSessionId;
  return isolated ? undefined : getTopicSessionId(topicId);
}
