/**
 * Topic-level conversation cleanup.
 *
 * The unified conversation log (`data/conversations/<userId>/<topic>.jsonl`)
 * is **transient** by design — its only job is to feed the cross-agent
 * bridge in `set_agent` and to give per-agent SDK rollout reconstruction a
 * provider-agnostic source. Once a topic is reset (`/new`) or deleted
 * (`/del`, MCP `delete_topic`), the unified log AND every per-agent SDK
 * rollout file the topic produced should disappear together so a subsequent
 * fresh-start on the same topic name (or a stray `set_agent` call against a
 * recreated row) cannot resurrect orphan history.
 *
 * Permanent forensic preservation lives in `wiki/archive/` via
 * `archiveSessionLogs`; this module is the matching teardown side.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SUPPORTED_AGENTS } from "#agents/index";
import { getRegistry } from "#agents/registry";
import { logger } from "#platform/logger";
import {
  type ConversationEntry,
  getConversationPath,
  readConversation,
} from "#storage/conversations";
import type { AgentKind } from "#types";

export interface PurgeSessionRef {
  agent: AgentKind;
  sessionId: string;
}

/**
 * Group every SDK session id this topic ever produced by its emitting
 * agent. `set_agent` round-trips can leave many ids per agent (one per
 * switch back), so we collect into a Set to deduplicate before deletion.
 */
function collectSessionIdsByAgent(
  entries: ConversationEntry[],
  extraSessions: PurgeSessionRef[] = [],
): Map<AgentKind, Set<string>> {
  const out = new Map<AgentKind, Set<string>>();
  for (const e of entries) {
    if (e.event.type !== "session") continue;
    const set = out.get(e.agent) ?? new Set<string>();
    set.add(e.event.sessionId);
    out.set(e.agent, set);
  }
  for (const { agent, sessionId } of extraSessions) {
    if (!sessionId) continue;
    const set = out.get(agent) ?? new Set<string>();
    set.add(sessionId);
    out.set(agent, set);
  }
  return out;
}

export interface PurgeTopicLogsOptions {
  userId: number | string;
  /** Topic key for the unified log path. Use `__dm__` for the DM session. */
  topicName: string;
  /**
   * Working directory the topic ran with — Claude embeds an encoded copy
   * in its rollout path, so a wrong value would silently miss the actual
   * files. API topics should pass `resolveTopicWorkspaceDir(topicId)`.
   */
  cwd: string;
  /**
   * Additional SDK resume keys that may not have reached the unified log yet.
   *
   * `set_agent` writes a synthetic rollout and stores its id in DB before the
   * target agent's first real turn emits a `session` event. If the user resets
   * or deletes the topic in that window, the DB session id is the only manifest
   * entry for that synthetic file.
   */
  extraSessions?: PurgeSessionRef[];
}

async function cleanupSessionRollouts(
  opts: PurgeTopicLogsOptions,
  entries: ConversationEntry[],
): Promise<boolean> {
  const { userId, topicName, cwd, extraSessions = [] } = opts;
  const idsByAgent = collectSessionIdsByAgent(entries, extraSessions);
  let cleanupFailed = false;

  await Promise.all(
    SUPPORTED_AGENTS.map(async (agent) => {
      const ids = idsByAgent.get(agent);
      if (!ids || ids.size === 0) return;
      try {
        await getRegistry(agent).cleanupRollouts({
          cwd,
          sessionIds: Array.from(ids),
        });
      } catch (e) {
        logger.warn(
          { err: e, userId, topicName, agent, count: ids.size },
          "topic logs: agent cleanup failed",
        );
        cleanupFailed = true;
      }
    }),
  );

  return !cleanupFailed;
}

export interface RotateTopicLogsOptions extends PurgeTopicLogsOptions {
  /** Number of complete user turns carried into the replacement session. */
  retainTurns: number;
}

export interface RotateTopicLogsResult {
  rotated: boolean;
  totalTurns: number;
  retainedTurns: number;
  retainedEntries: number;
}

/**
 * Replace a topic's native provider sessions while retaining a bounded tail
 * of its provider-neutral conversation log. This is used by long-lived Cron
 * topics: a fresh native rollout keeps prompt/session state bounded, and the
 * retained tail gives the next rollout enough context to continue naturally.
 */
export async function rotateTopicLogs(
  opts: RotateTopicLogsOptions,
): Promise<RotateTopicLogsResult> {
  const retainTurns = Math.max(0, Math.floor(opts.retainTurns));
  const entries = readConversation(opts.userId, opts.topicName);
  const userEntryIndexes = entries.flatMap((entry, index) =>
    entry.event.type === "user_message" ? [index] : [],
  );
  const totalTurns = userEntryIndexes.length;
  const firstRetainedIndex =
    retainTurns === 0
      ? entries.length
      : (userEntryIndexes[Math.max(0, totalTurns - retainTurns)] ?? 0);
  // Native session ids point at rollouts that are removed below. Keeping
  // those manifest entries would make later cleanup treat deleted files as
  // live context, so only conversational events cross the rotation boundary.
  const retained = entries
    .slice(firstRetainedIndex)
    .filter((entry) => entry.event.type !== "session");

  if (!(await cleanupSessionRollouts(opts, entries))) {
    logger.warn(
      { userId: opts.userId, topicName: opts.topicName },
      "rotateTopicLogs: keeping current context because rollout cleanup failed",
    );
    return {
      rotated: false,
      totalTurns,
      retainedTurns: Math.min(totalTurns, retainTurns),
      retainedEntries: retained.length,
    };
  }

  const path = getConversationPath(opts.userId, opts.topicName);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      tempPath,
      retained.length > 0 ? `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "",
      { flag: "wx" },
    );
    renameSync(tempPath, path);
  } catch (e) {
    try {
      unlinkSync(tempPath);
    } catch {}
    logger.warn({ err: e, path }, "rotateTopicLogs: conversation replacement failed");
    return {
      rotated: false,
      totalTurns,
      retainedTurns: Math.min(totalTurns, retainTurns),
      retainedEntries: retained.length,
    };
  }

  return {
    rotated: true,
    totalTurns,
    retainedTurns: Math.min(totalTurns, retainTurns),
    retainedEntries: retained.length,
  };
}

/**
 * Best-effort teardown of every artifact associated with a topic's
 * conversation lifecycle. Order matters and is intentional:
 *
 *   1. Read the unified log first — it's the authoritative manifest of
 *      every SDK session id the topic has emitted. Merge any DB session id
 *      passed via `extraSessions` for synthetic rollouts not yet emitted.
 *   2. Dispatch per-agent rollout cleanup in parallel (independent
 *      filesystems, no shared state).
 *   3. Unlink the unified log LAST so a partial rollout-cleanup failure
 *      leaves the manifest in place for a future retry.
 *
 * Errors at every step are logged but never thrown — cleanup runs at
 * topic teardown when there is nothing left to abort to.
 */
export async function purgeTopicLogs(opts: PurgeTopicLogsOptions): Promise<void> {
  const { userId, topicName } = opts;
  const entries = readConversation(userId, topicName);
  if (!(await cleanupSessionRollouts(opts, entries))) {
    logger.warn(
      { userId, topicName },
      "purgeTopicLogs: keeping unified log because one or more rollout cleanups failed",
    );
    return;
  }

  const path = getConversationPath(userId, topicName);
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn({ err: e, path }, "purgeTopicLogs: unified log unlink failed");
    }
  }
}
