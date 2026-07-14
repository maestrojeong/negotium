/**
 * Derived-topic creation — fork (config+history copy), spawn (config-only),
 * and subagent (agent-initiated worker room) share this helper.
 *
 * Ported from otium runtime-api `api/routes/topics.ts`, minus the REST route
 * table; the route-facing wrappers (`getTopics`, `updateTopic`) live here too
 * so ported call sites keep working.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { cleanupAgentFork, type ForkHandle, forkAgentSession } from "#agents/fork";
import { resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry } from "#agents/registry";
import { WsHub } from "#bus";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { logger } from "#platform/logger";
import { copyMessagesForTopic } from "#storage/api-messages";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import {
  findTopicTitleConflict,
  getTopic,
  getTopicSessionId,
  inferTopicKind,
  listTopics,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import { appendConversationEventStrict, cloneConversationLog } from "#storage/conversations";
import { db } from "#storage/forum-db";
import { isLegacySharedGeneral } from "#topics/personal-general";
import type { AgentKind } from "#types";
import type { TopicDto } from "#types/api";

export function getTopics(): TopicDto[] {
  return listTopics().filter((topic) => !isLegacySharedGeneral(topic.id));
}

export function updateTopic(topicId: string, patch: Partial<TopicDto>): boolean {
  const topic = getTopic(topicId);
  if (!topic) return false;
  Object.assign(topic, patch);
  upsertTopic(topic);
  return true;
}

export function isParticipant(topic: TopicDto, userId: string): boolean {
  return topic.participants.some((p) => p.userId === userId);
}

function nextDerivedTopicTitle(
  sourceTitle: string,
  kind: TopicDto["kind"],
  suffix: "fork" | "spawn" | "agent",
): string {
  const visibleTitles = new Set(
    listTopics()
      .filter((topic) => topic.kind === kind)
      .map((topic) => topic.title.toLowerCase()),
  );
  let n = 1;
  let title = `${sourceTitle}-${suffix}-${n}`;
  while (visibleTitles.has(title.toLowerCase())) {
    n += 1;
    title = `${sourceTitle}-${suffix}-${n}`;
  }
  return title;
}

function effectiveAgentForTopic(_topicId: string, topic: TopicDto): AgentKind | undefined {
  if (!topic.agent) return undefined;
  return topic.agent;
}

function rollbackHandleFor(agent: AgentKind, sessionId: string, rolloutPath: string): ForkHandle {
  return { agent, forkId: sessionId, rolloutPath };
}

/** Thrown when a user-supplied derived-topic name collides with an existing
 *  topic title. Callers surface this as a specific "pick a different name"
 *  message instead of the generic membership/session failure. */
export class TopicTitleConflictError extends Error {
  constructor(readonly title: string) {
    super(`A topic named "${title}" already exists`);
    this.name = "TopicTitleConflictError";
  }
}

/**
 * Shared helper for spawn (config-only copy) and fork (config+history copy).
 *
 * - fork (copyHistory=true): inherits ALL source participants, copies messages,
 *   creator becomes owner, and forks the source AI session when AI is enabled.
 * - spawn (copyHistory=false): config only, creator is sole owner, empty history.
 *   It still creates a fresh AI session when AI is enabled.
 * - subagent (copyHistory=false + opts.subagent): agent-initiated worker room.
 *   Marked `isSubagent`, optionally overriding the child's agent/model.
 *
 * @param sourceTopicId - must exist and caller must be a participant
 * @param userId - caller (becomes owner of the new topic)
 * @param copyHistory - true for fork, false for spawn
 * @param opts - optional custom name and subagent overrides
 * @returns the newly created TopicDto or null on error
 * @throws TopicTitleConflictError when the requested name is already taken
 */
export async function createDerivedTopic(
  sourceTopicId: string,
  userId: string,
  copyHistory: boolean,
  opts?: { name?: string; subagent?: { agent?: AgentKind; model?: string } },
): Promise<TopicDto | null> {
  const topic = getTopic(sourceTopicId);
  if (!topic) return null;
  if (topic.kind === "manager") return null;
  if (!isParticipant(topic, userId)) return null;

  const now = new Date().toISOString();
  const subagent = copyHistory ? undefined : opts?.subagent;
  const suffix = copyHistory ? "fork" : subagent ? "agent" : "spawn";
  const sourceConfig = getApiTopicConfig(sourceTopicId);
  const agent = subagent?.agent ?? effectiveAgentForTopic(sourceTopicId, topic);

  // Fork: inherit all source participants, creator becomes owner
  // Spawn: creator is sole owner
  // Subagent: inherit all source participants — everyone who can see the
  // parent room sees the card there, so its "view room" target must be
  // accessible to them too (single-topic GET rejects non-participants).
  const participants: TopicDto["participants"] =
    copyHistory || subagent
      ? [
          ...topic.participants
            .filter((p) => p.userId !== userId)
            .map((p) => ({ ...p, role: "member" as const })),
          { userId, role: "owner" as const },
        ]
      : [{ userId, role: "owner" as const }];
  const kind = topic.kind ?? inferTopicKind(topic);
  const title = opts?.name?.trim() || nextDerivedTopicTitle(topic.title, kind, suffix);
  const conflict = findTopicTitleConflict(title, kind);
  if (conflict) {
    logger.info(
      { sourceTopicId, title, kind, conflictTopicId: conflict.id },
      "createDerivedTopic: title conflict",
    );
    throw new TopicTitleConflictError(title);
  }
  const derived: TopicDto = {
    id: randomUUID(),
    title,
    kind,
    description: topic.description,
    agent: subagent?.agent ?? topic.agent,
    defaultModel: subagent?.model ?? topic.defaultModel,
    defaultEffort: topic.defaultEffort,
    aiMode: topic.aiMode,
    aiMention: topic.aiMention,
    participants,
    createdAt: now,
    lastMessageAt: now,
    parentTopicId: sourceTopicId,
    isFork: copyHistory,
    ...(subagent ? { isSubagent: true } : {}),
  };

  let sessionId: string | undefined;
  let rollbackHandle: ForkHandle | undefined;

  try {
    if (agent) {
      const cwd = resolveTopicWorkspaceDir(derived.id);
      mkdirSync(cwd, { recursive: true });
      const registry = getRegistry(agent);
      const requestedRolloutModel =
        subagent?.model ??
        (subagent?.agent ? undefined : sourceConfig?.model) ??
        derived.defaultModel;
      const rolloutModel = resolveModelForAgent(agent, requestedRolloutModel, registry);
      const requestedRolloutEffort = subagent?.agent
        ? registry.defaultEffort
        : (sourceConfig?.effort ?? derived.defaultEffort);
      const rolloutEffort =
        requestedRolloutEffort && registry.validateEffort(requestedRolloutEffort)
          ? requestedRolloutEffort
          : registry.defaultEffort;

      if (copyHistory) {
        const parentSessionId = getTopicSessionId(sourceTopicId);
        if (parentSessionId) {
          const fork = await forkAgentSession({
            agent,
            parentSessionId,
            cwd,
            userId,
            topicName: topic.title,
            title,
            model: rolloutModel,
            ...(rolloutEffort ? { effort: rolloutEffort } : {}),
          });
          sessionId = fork.forkId;
          rollbackHandle = fork;
        } else {
          logger.info(
            { sourceTopicId, title: topic.title, agent },
            "createDerivedTopic: fork requested without active source session; creating topic without SDK fork",
          );
        }
      } else {
        const rollout = registry.writeRollout({
          cwd,
          entries: [],
          model: rolloutModel,
          ...(rolloutEffort ? { effort: rolloutEffort } : {}),
        });
        sessionId = rollout.sessionId;
        rollbackHandle = rollbackHandleFor(agent, rollout.sessionId, rollout.rolloutPath);
      }
    }

    const created = db
      .transaction(() => {
        upsertTopic(derived);
        if (subagent) {
          // Subagent worker rooms do NOT cascade the parent's optional MCP
          // whitelist — they start with the default (required-only) MCP set,
          // mirroring clawgram's subagent policy. An explicit agent/model
          // override must also beat the parent's config override, which
          // startAiTurn resolves ahead of the topic defaults; dropping the
          // inherited model when only the agent changes avoids pinning the
          // child to a model that belongs to the parent's agent.
          const childConfig = { ...(sourceConfig ?? {}) };
          delete childConfig.mcp;
          if (subagent.agent) {
            delete childConfig.model;
          }
          if (subagent.model) childConfig.model = subagent.model;
          if (Object.keys(childConfig).length > 0) setApiTopicConfig(derived.id, childConfig);
        } else if (sourceConfig) {
          setApiTopicConfig(derived.id, sourceConfig);
        }
        if (copyHistory) {
          copyMessagesForTopic(sourceTopicId, derived.id);
          cloneConversationLog({
            userId,
            srcTopic: topic.title,
            dstTopic: derived.title,
          });
        }
        if (sessionId && agent) {
          setTopicSessionId(derived.id, sessionId, {
            reason: copyHistory ? "slash-fork" : subagent ? "spawn-subagent" : "slash-spawn",
            agent,
          });
          appendConversationEventStrict(userId, derived.title, agent, {
            type: "session",
            sessionId,
          });
        }
        return derived;
      })
      .immediate();
    // Every derived room (fork/spawn/subagent) is user-visible: tell all
    // inherited participants, not just the client that issued the request.
    WsHub.get().broadcastTopicCreated(created);
    return created;
  } catch (err) {
    if (rollbackHandle) cleanupAgentFork(rollbackHandle);
    logger.warn(
      { err, sourceTopicId, derivedTopicId: derived.id, copyHistory },
      "createDerivedTopic: failed to create derived topic",
    );
    return null;
  }
}
