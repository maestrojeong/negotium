/**
 * Topic-level conversation cleanup.
 *
 * The raw and active conversation logs are operational files. The raw stream
 * is append-only while a topic lives and is archived to `wiki/archive/` by
 * reset/delete lifecycle code before this module removes it. The active stream
 * is the compactable provider projection. Every per-agent SDK rollout and both
 * operational files disappear together so a recreated topic cannot resurrect
 * orphan history.
 *
 * Permanent forensic preservation lives in `wiki/archive/` via
 * `archiveSessionLogs`; this module is the matching teardown side.
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SUPPORTED_AGENTS } from "#agents/index";
import { getRegistryOperations } from "#agents/registry";
import { logger } from "#platform/logger";
import {
  getActiveConversationPath,
  getConversationPath,
  readConversation,
  readRawConversation,
} from "#storage/conversations";
import type { AgentKind, UnifiedEvent } from "#types";

export interface TopicConversationEntry {
  ts: string;
  agent: AgentKind;
  event: UnifiedEvent;
}

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
  entries: TopicConversationEntry[],
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

export interface TopicLogMaintenanceHost {
  readonly agents: readonly AgentKind[];
  readonly readActiveConversation: (
    userId: number | string,
    topicName: string,
  ) => TopicConversationEntry[];
  readonly readRawConversation: (
    userId: number | string,
    topicName: string,
  ) => TopicConversationEntry[];
  readonly activeConversationPath: (userId: number | string, topicName: string) => string;
  readonly rawConversationPath: (userId: number | string, topicName: string) => string;
  readonly cleanupRollouts: (agent: AgentKind, cwd: string, sessionIds: string[]) => Promise<void>;
  readonly warn: (context: Record<string, unknown>, message: string) => void;
}

export interface TopicLogMaintenance {
  cleanupTopicRollouts(opts: PurgeTopicLogsOptions): Promise<boolean>;
  cleanupTopicRolloutsFromEntries(
    opts: PurgeTopicLogsOptions,
    entries: TopicConversationEntry[],
  ): Promise<boolean>;
  rotateTopicLogs(opts: RotateTopicLogsOptions): Promise<RotateTopicLogsResult>;
  purgeTopicLogs(opts: PurgeTopicLogsOptions): Promise<boolean>;
}

async function cleanupSessionRollouts(
  host: TopicLogMaintenanceHost,
  opts: PurgeTopicLogsOptions,
  entries: TopicConversationEntry[],
): Promise<boolean> {
  const { userId, topicName, cwd, extraSessions = [] } = opts;
  const idsByAgent = collectSessionIdsByAgent(entries, extraSessions);
  let cleanupFailed = false;

  await Promise.all(
    host.agents.map(async (agent) => {
      const ids = idsByAgent.get(agent);
      if (!ids || ids.size === 0) return;
      try {
        await host.cleanupRollouts(agent, cwd, Array.from(ids));
      } catch (e) {
        host.warn(
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

export function createTopicLogMaintenance(host: TopicLogMaintenanceHost): TopicLogMaintenance {
  const runtimeHost: TopicLogMaintenanceHost = Object.freeze({
    ...host,
    agents: Object.freeze([...host.agents]),
  });
  const cleanupFromEntries = (
    opts: PurgeTopicLogsOptions,
    entries: TopicConversationEntry[],
  ): Promise<boolean> => cleanupSessionRollouts(runtimeHost, opts, entries);

  return Object.freeze({
    cleanupTopicRollouts(opts: PurgeTopicLogsOptions) {
      return cleanupFromEntries(opts, runtimeHost.readRawConversation(opts.userId, opts.topicName));
    },
    cleanupTopicRolloutsFromEntries: cleanupFromEntries,
    async rotateTopicLogs(opts: RotateTopicLogsOptions) {
      const retainTurns = Math.max(0, Math.floor(opts.retainTurns));
      const entries = runtimeHost.readActiveConversation(opts.userId, opts.topicName);
      const userEntryIndexes = entries.flatMap((entry, index) =>
        entry.event.type === "user_message" ? [index] : [],
      );
      const totalTurns = userEntryIndexes.length;
      const firstRetainedIndex =
        retainTurns === 0
          ? entries.length
          : (userEntryIndexes[Math.max(0, totalTurns - retainTurns)] ?? 0);
      const retained = entries
        .slice(firstRetainedIndex)
        .filter((entry) => entry.event.type !== "session");

      if (!(await cleanupFromEntries(opts, entries))) {
        runtimeHost.warn(
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

      const path = runtimeHost.activeConversationPath(opts.userId, opts.topicName);
      const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          tempPath,
          retained.length > 0
            ? `${retained.map((entry) => JSON.stringify(entry)).join("\n")}\n`
            : "",
          { flag: "wx" },
        );
        renameSync(tempPath, path);
      } catch (e) {
        try {
          unlinkSync(tempPath);
        } catch {}
        runtimeHost.warn({ err: e, path }, "rotateTopicLogs: conversation replacement failed");
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
    },
    async purgeTopicLogs(opts: PurgeTopicLogsOptions) {
      const { userId, topicName } = opts;
      const entries = runtimeHost.readRawConversation(userId, topicName);
      if (!(await cleanupFromEntries(opts, entries))) {
        runtimeHost.warn(
          { userId, topicName },
          "purgeTopicLogs: keeping unified log because one or more rollout cleanups failed",
        );
        return false;
      }

      let unlinkFailed = false;
      for (const path of [
        runtimeHost.activeConversationPath(userId, topicName),
        runtimeHost.rawConversationPath(userId, topicName),
      ]) {
        try {
          unlinkSync(path);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
            runtimeHost.warn({ err: e, path }, "purgeTopicLogs: conversation log unlink failed");
            unlinkFailed = true;
          }
        }
      }
      return !unlinkFailed;
    },
  });
}

const defaultTopicLogMaintenance = createTopicLogMaintenance({
  agents: SUPPORTED_AGENTS,
  readActiveConversation: readConversation,
  readRawConversation,
  activeConversationPath: getActiveConversationPath,
  rawConversationPath: getConversationPath,
  async cleanupRollouts(agent, cwd, sessionIds) {
    await getRegistryOperations(agent).cleanupRollouts({ cwd, sessionIds });
  },
  warn: logger.warn.bind(logger),
});

/** Remove every provider rollout currently manifested by a topic log. */
export const cleanupTopicRollouts = defaultTopicLogMaintenance.cleanupTopicRollouts;

/** Remove rollout ids captured from a point-in-time conversation manifest. */
export const cleanupTopicRolloutsFromEntries =
  defaultTopicLogMaintenance.cleanupTopicRolloutsFromEntries;

/**
 * Replace a topic's native provider sessions while retaining a bounded tail
 * of its provider-neutral conversation log.
 */
export const rotateTopicLogs = defaultTopicLogMaintenance.rotateTopicLogs;

/**
 * Best-effort teardown of every artifact associated with a topic's
 * conversation lifecycle.
 */
export const purgeTopicLogs = defaultTopicLogMaintenance.purgeTopicLogs;
