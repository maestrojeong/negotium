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

import { unlinkSync } from "node:fs";
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
  const { userId, topicName, cwd, extraSessions = [] } = opts;
  const entries = readConversation(userId, topicName);
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
          "purgeTopicLogs: agent cleanup failed",
        );
        cleanupFailed = true;
      }
    }),
  );

  if (cleanupFailed) {
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
