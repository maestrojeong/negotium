/**
 * Derived-topic creation — fork (config+history copy), spawn (config-only),
 * and subagent (agent-initiated worker room) share this helper.
 *
 * Ported from otium runtime-api `api/routes/topics.ts`, minus the REST route
 * table; the route-facing wrappers (`getTopics`, `updateTopic`) live here too
 * so ported call sites keep working.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, unlinkSync } from "node:fs";
import { cleanupAgentFork, type ForkHandle, forkAgentSession } from "#agents/fork";
import { resolveCompactionExecution, resolveModelForAgent } from "#agents/model-catalog";
import { getRegistry, getRegistryOperations } from "#agents/registry";
import { WsHub } from "#bus";
import { resolveTopicWorkspaceDir } from "#platform/config";
import { logger } from "#platform/logger";
import { cloneProfileForChild } from "#platform/playwright/manager";
import { isTopicRunning } from "#query/active-rooms";
import {
  captureMessageSnapshotForTopic,
  copyMessageSnapshotToTopic,
  type TopicMessageSnapshot,
} from "#storage/api-messages";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import {
  findTopicTitleConflict,
  getTopic,
  getTopicSessionId,
  inferTopicKind,
  isTopicVisible,
  listTopics,
  setTopicSessionId,
  upsertTopic,
} from "#storage/api-topics";
import {
  appendConversationEventStrict,
  type ConversationEntry,
  getActiveConversationPath,
  getConversationPath,
  hasActiveConversation,
  readConversation,
  readRawConversation,
  replaceConversationStrict,
  replaceRawConversationStrict,
} from "#storage/conversations";
import { db } from "#storage/forum-db";
import { isRuntimeTopicMaintenance } from "#storage/runtime-topic-state";
import { isLegacySharedGeneral } from "#topics/personal-general";
import {
  type CompactSummaryRequest,
  createCompactedRolloutEntries,
  shouldCompactForkEntries,
} from "#topics/session";
import type { AgentKind } from "#types";
import type { TopicDto } from "#types/api";

export function getTopics(): TopicDto[] {
  return listTopics().filter((topic) => !isLegacySharedGeneral(topic.id));
}

/** Topics adapters may show in lists and selection UIs. */
export function getVisibleTopics(): TopicDto[] {
  return getTopics()
    .filter(isTopicVisible)
    .map((topic) => {
      if (!topic.agent) return topic;
      const registry = getRegistry(topic.agent);
      const config = getApiTopicConfig(topic.id);
      const requestedEffort = config?.effort ?? topic.defaultEffort;
      return {
        ...topic,
        effectiveModel: resolveModelForAgent(
          topic.agent,
          config?.model ?? topic.defaultModel,
          registry,
        ),
        effectiveEffort:
          requestedEffort && registry.validateEffort(requestedEffort)
            ? requestedEffort
            : registry.defaultEffort,
      };
    });
}

export function updateTopic(topicId: string, patch: Partial<TopicDto>): boolean {
  const topic = getTopic(topicId);
  if (!topic) return false;
  Object.assign(topic, patch);
  upsertTopic(topic);
  WsHub.get().broadcastTopicUpdated(topicId);
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

export class TopicDeriveBusyError extends Error {
  constructor(message = "Topic is busy; try again when the current operation finishes") {
    super(message);
    this.name = "TopicDeriveBusyError";
  }
}

export class TopicForkCompactionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TopicForkCompactionError";
  }
}

interface ForkSnapshot {
  entries: ConversationEntry[];
  rawEntries: ConversationEntry[];
  hadActiveProjection: boolean;
  messages: TopicMessageSnapshot;
  active: boolean;
  canonicalDigest: string;
}

function captureForkSnapshot(
  sourceTopicId: string,
  userId: string,
  topicTitle: string,
): ForkSnapshot {
  const capturedAt = new Date().toISOString();
  const entries = readConversation(userId, topicTitle).filter((entry) => entry.ts <= capturedAt);
  const rawEntries = readRawConversation(userId, topicTitle).filter(
    (entry) => entry.ts <= capturedAt,
  );
  const messageSnapshot = captureMessageSnapshotForTopic(sourceTopicId);
  const messageRows = messageSnapshot.rows.filter((row) => row.created_at <= capturedAt);
  return {
    entries,
    rawEntries,
    hadActiveProjection: hasActiveConversation(userId, topicTitle),
    messages: {
      ...messageSnapshot,
      rows: messageRows,
      capturedAt,
      maxRowid: messageRows.at(-1)?.rowid ?? 0,
    },
    active: isTopicRunning(sourceTopicId),
    canonicalDigest: createHash("sha256")
      .update(entries.map((entry) => JSON.stringify(entry)).join("\n"))
      .digest("hex"),
  };
}

interface DerivedTopicOptions {
  name?: string;
  subagent?: { agent?: AgentKind; model?: string; memoryTopicId?: string };
  summarizeFork?: (request: CompactSummaryRequest) => Promise<string>;
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
 * @throws TopicDeriveBusyError when subagent creation races parent maintenance
 * @throws TopicTitleConflictError when the requested name is already taken
 */
export async function createDerivedTopic(
  sourceTopicId: string,
  userId: string,
  copyHistory: boolean,
  opts?: DerivedTopicOptions,
): Promise<TopicDto | null> {
  const topic = getTopic(sourceTopicId);
  if (!topic) return null;
  if (topic.kind === "manager") return null;
  if (!isParticipant(topic, userId)) return null;

  const subagent = copyHistory ? undefined : opts?.subagent;
  if (subagent && isRuntimeTopicMaintenance(sourceTopicId)) {
    throw new TopicDeriveBusyError();
  }

  return await createDerivedTopicImpl(topic, sourceTopicId, userId, copyHistory, opts);
}

async function createDerivedTopicImpl(
  topic: TopicDto,
  sourceTopicId: string,
  userId: string,
  copyHistory: boolean,
  opts?: DerivedTopicOptions,
): Promise<TopicDto | null> {
  const now = new Date().toISOString();
  const subagent = copyHistory ? undefined : opts?.subagent;
  const suffix = copyHistory ? "fork" : subagent ? "agent" : "spawn";
  const sourceConfig = getApiTopicConfig(sourceTopicId);
  const agent = subagent?.agent ?? effectiveAgentForTopic(sourceTopicId, topic);
  const subagentModel =
    agent && subagent?.model
      ? resolveModelForAgent(agent, subagent.model, getRegistry(agent))
      : undefined;

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
    defaultModel: subagentModel ?? topic.defaultModel,
    defaultEffort: topic.defaultEffort,
    aiMode: topic.aiMode,
    aiMention: topic.aiMention,
    participants,
    createdAt: now,
    lastMessageAt: now,
    parentTopicId: sourceTopicId,
    ...(subagent?.memoryTopicId ? { memoryTopicId: subagent.memoryTopicId } : {}),
    isFork: copyHistory,
    ...(subagent ? { isSubagent: true } : {}),
    visibility: topic.visibility,
    accessMode: topic.accessMode,
  };

  let sessionId: string | undefined;
  let rollbackHandle: ForkHandle | undefined;
  let compactedForkEntries: ConversationEntry[] | undefined;
  let wroteDerivedConversation = false;
  const forkSnapshot = copyHistory
    ? captureForkSnapshot(sourceTopicId, userId, topic.title)
    : undefined;
  const derivedWorkspace = resolveTopicWorkspaceDir(derived.id);

  try {
    if (agent) {
      const cwd = derivedWorkspace;
      mkdirSync(cwd, { recursive: true });
      const registry = getRegistry(agent);
      const requestedRolloutModel =
        subagentModel ??
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
      const compactionExecution = resolveCompactionExecution(agent, registry);

      if (copyHistory) {
        if (!forkSnapshot) throw new Error("fork snapshot was not captured");
        const parentSessionId = getTopicSessionId(sourceTopicId);
        const nativeSameAgentFork = agent === "codex" || agent === "maestro";
        if (nativeSameAgentFork && parentSessionId) {
          try {
            rollbackHandle = await forkAgentSession({
              agent,
              parentSessionId,
              cwd,
              userId,
              topicName: topic.title,
              title,
              model: rolloutModel,
              ...(rolloutEffort ? { effort: rolloutEffort } : {}),
            });
            sessionId = rollbackHandle.forkId;
            logger.info(
              { sourceTopicId, derivedTopicId: derived.id, parentSessionId, sessionId },
              "createDerivedTopic: native provider fork materialized",
            );
          } catch (error) {
            logger.warn(
              { err: error, sourceTopicId, derivedTopicId: derived.id, parentSessionId },
              "createDerivedTopic: native provider fork failed; using snapshot fallback",
            );
          }
        }
        // A native same-agent fork must retain the provider's exact working
        // prefix so prompt caching can reuse it. Its synthetic fallback also
        // keeps the full snapshot rather than replacing history with a summary.
        // Cross-provider/model bridging owns its compaction policy elsewhere.
        const compactionRequired =
          !nativeSameAgentFork && !sessionId && shouldCompactForkEntries(forkSnapshot.entries);
        if (compactionRequired) {
          try {
            compactedForkEntries = await createCompactedRolloutEntries(
              {
                topicId: sourceTopicId,
                topicTitle: topic.title,
                userId,
                entries: forkSnapshot.entries,
                visibleMessages: forkSnapshot.messages.rows,
                agent,
                model: rolloutModel,
                ...(rolloutEffort ? { effort: rolloutEffort } : {}),
                summaryModel: compactionExecution.model,
                ...(compactionExecution.effort
                  ? { summaryEffort: compactionExecution.effort }
                  : {}),
                cwd,
              },
              opts?.summarizeFork,
            );
            const rollout = getRegistryOperations(agent).writeRollout({
              cwd,
              entries: compactedForkEntries,
              model: rolloutModel,
              ...(rolloutEffort ? { effort: rolloutEffort } : {}),
            });
            sessionId = rollout.sessionId;
            rollbackHandle = rollbackHandleFor(agent, rollout.sessionId, rollout.rolloutPath);
          } catch (err) {
            compactedForkEntries = undefined;
            throw new TopicForkCompactionError(
              `Fork compaction failed for "${title}"; the fork was not created`,
              err,
            );
          }
        }
        if (!sessionId) {
          const rollout = getRegistryOperations(agent).writeRollout({
            cwd,
            entries: forkSnapshot.entries,
            model: rolloutModel,
            ...(rolloutEffort ? { effort: rolloutEffort } : {}),
          });
          sessionId = rollout.sessionId;
          rollbackHandle = rollbackHandleFor(agent, rollout.sessionId, rollout.rolloutPath);
          logger.info(
            {
              sourceTopicId,
              derivedTopicId: derived.id,
              activeSnapshot: forkSnapshot.active,
              entries: forkSnapshot.entries.length,
              visibleRows: forkSnapshot.messages.rows.length,
              visibleMaxRowid: forkSnapshot.messages.maxRowid,
              snapshotCapturedAt: forkSnapshot.messages.capturedAt,
              canonicalDigest: forkSnapshot.canonicalDigest,
              compacted: Boolean(compactedForkEntries),
            },
            "createDerivedTopic: synthetic fork materialized from immutable snapshot",
          );
        }
      } else {
        const rollout = getRegistryOperations(agent).writeRollout({
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
        const currentSource = getTopic(sourceTopicId);
        if (
          !currentSource ||
          currentSource.kind === "manager" ||
          !isParticipant(currentSource, userId) ||
          (subagent && isRuntimeTopicMaintenance(sourceTopicId))
        ) {
          throw new TopicDeriveBusyError("Source topic changed while deriving; try again");
        }
        const transactionalConflict = findTopicTitleConflict(title, kind);
        if (transactionalConflict) throw new TopicTitleConflictError(title);
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
          if (subagentModel) childConfig.model = subagentModel;
          if (Object.keys(childConfig).length > 0) setApiTopicConfig(derived.id, childConfig);
        } else if (sourceConfig) {
          setApiTopicConfig(derived.id, sourceConfig);
        }
        if (copyHistory) {
          if (!forkSnapshot) throw new Error("fork snapshot was not captured");
          copyMessageSnapshotToTopic(forkSnapshot.messages, derived.id);
          replaceRawConversationStrict(userId, derived.title, forkSnapshot.rawEntries);
          if (compactedForkEntries) {
            replaceConversationStrict(userId, derived.title, compactedForkEntries);
          } else if (forkSnapshot.hadActiveProjection) {
            replaceConversationStrict(userId, derived.title, forkSnapshot.entries);
          }
          wroteDerivedConversation = true;
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

    // Derived rooms inherit the browser profile only when the creator already
    // owns the source. Crossing an owner boundary always starts with a fresh
    // profile so cookies and login state cannot be transferred by a member.
    try {
      const profileClone = await cloneProfileForChild({
        userId,
        srcTopic: sourceTopicId,
        dstTopic: derived.id,
      });
      logger.info(
        {
          sourceTopicId,
          derivedTopicId: derived.id,
          copyHistory,
          subagent: Boolean(subagent),
          profileClone,
        },
        "createDerivedTopic: playwright profile clone",
      );
    } catch (profileErr) {
      logger.warn(
        { err: profileErr, sourceTopicId, derivedTopicId: derived.id },
        "createDerivedTopic: playwright profile clone threw (continuing)",
      );
    }

    // Every derived room (fork/spawn/subagent) is user-visible: tell all
    // inherited participants, not just the client that issued the request.
    WsHub.get().broadcastTopicCreated(created);
    return created;
  } catch (err) {
    if (rollbackHandle) cleanupAgentFork(rollbackHandle);
    if (wroteDerivedConversation) {
      for (const path of [
        getActiveConversationPath(userId, derived.title),
        getConversationPath(userId, derived.title),
      ]) {
        try {
          unlinkSync(path);
        } catch {}
      }
    }
    rmSync(derivedWorkspace, { recursive: true, force: true });
    if (
      err instanceof TopicDeriveBusyError ||
      err instanceof TopicTitleConflictError ||
      err instanceof TopicForkCompactionError
    ) {
      throw err;
    }
    logger.warn(
      { err, sourceTopicId, derivedTopicId: derived.id, copyHistory },
      "createDerivedTopic: failed to create derived topic",
    );
    return null;
  }
}
