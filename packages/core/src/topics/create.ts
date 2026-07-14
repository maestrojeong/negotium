/**
 * Programmatic topic registration — the host-agnostic core of otium's
 * `POST /topics` route. Every surface (negotium MCP `register_topic`, CLI,
 * channel adapters) creates topics through this one function so validation
 * and defaults never fork.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { WsHub } from "#bus";
import { FALLBACK_AGENT, resolveTopicWorkspaceDir } from "#platform/config";
import { RESERVED_TOPIC_NAMES } from "#platform/constants";
import { logger } from "#platform/logger";
import {
  findTopicTitleConflict,
  normalizeTopicKind,
  normalizeTopicState,
  upsertTopic,
} from "#storage/api-topics";
import { type AgentKind, type EffortLevel, isAgentKind } from "#types";
import type { TopicDto } from "#types/api";

// Agent rooms default to the node-level FALLBACK_AGENT (env), not a hardcoded
// backend — a node without DeepSeek auth can still default to claude/codex.
const DEFAULT_AGENT_ROOM_AGENT: AgentKind = FALLBACK_AGENT;

export class TopicValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicValidationError";
  }
}

export interface RegisterTopicOptions {
  title: string;
  userId: string;
  /** "agent" (AI room, default) or "channel" (human room, AI optional). */
  kind?: TopicDto["kind"];
  /** AI backend for the room. Defaults to maestro for agent rooms. */
  agent?: AgentKind | "none";
  model?: string;
  effort?: EffortLevel;
  description?: string;
}

/**
 * Create a topic owned by `userId`. Throws {@link TopicValidationError} on
 * invalid input (reserved/conflicting title, bad agent/model combination).
 */
export function registerTopic(opts: RegisterTopicOptions): TopicDto {
  const title = opts.title?.trim();
  if (!title) throw new TopicValidationError("title is required");
  if (RESERVED_TOPIC_NAMES.has(title.toLowerCase())) {
    throw new TopicValidationError(`"${title}" is a reserved name`);
  }

  const requestedKind = normalizeTopicKind(opts.kind) ?? "agent";
  if (requestedKind === "manager") {
    throw new TopicValidationError("Manager rooms are system-managed");
  }
  const conflict = findTopicTitleConflict(title, requestedKind);
  if (conflict) {
    throw new TopicValidationError(`A topic named "${title}" already exists`);
  }

  const rawAgent = opts.agent;
  if (requestedKind === "agent" && rawAgent === "none") {
    throw new TopicValidationError("Agent rooms must have an AI agent");
  }
  if (rawAgent && rawAgent !== "none" && !isAgentKind(rawAgent)) {
    throw new TopicValidationError(`Unknown agent '${rawAgent}'`);
  }
  const requestedAgent: AgentKind | undefined =
    rawAgent === "none" || (requestedKind === "channel" && rawAgent === undefined)
      ? undefined
      : ((rawAgent as AgentKind | undefined) ?? DEFAULT_AGENT_ROOM_AGENT);

  const { kind, aiMode, agent } = normalizeTopicState({
    kind: requestedKind,
    agent: requestedAgent,
  });

  // Derive per-mode model/effort defaults from the chosen agent's registry.
  const registry = getRegistry(agent ?? "maestro");
  if (agent && opts.model && !registry.validateModel(opts.model)) {
    throw new TopicValidationError(`model '${opts.model}' is not valid for agent '${agent}'`);
  }
  if (agent && opts.effort && !registry.validateEffort(opts.effort)) {
    throw new TopicValidationError(`effort '${opts.effort}' is not valid for agent '${agent}'`);
  }
  const defaultModel = resolveModelForAgent(agent ?? "maestro", opts.model, registry);
  const defaultEffort = opts.effort ?? registry.defaultEffort;

  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: randomUUID(),
    title,
    kind,
    description: opts.description,
    agent,
    defaultModel,
    defaultEffort: defaultEffort ?? "medium",
    aiMode,
    participants: [{ userId: opts.userId, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  };

  upsertTopic(topic);
  try {
    mkdirSync(resolveTopicWorkspaceDir(topic.id), { recursive: true });
  } catch (err) {
    logger.warn({ err, topicId: topic.id }, "registerTopic: workspace dir create failed");
  }
  WsHub.get().broadcastTopicCreated(topic);
  logger.info({ topicId: topic.id, title, kind, agent }, "topic registered");
  return topic;
}
