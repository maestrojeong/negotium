import { getRegistry } from "#agents/registry";
import { SESSION_WORKSPACE_DIR } from "#platform/config";
import { delay } from "#platform/delay";
import { logger } from "#platform/logger";
import { readConversation } from "#storage/conversations";
import { getTopicAgent } from "#storage/forum/agent-settings";
import { clearDmSessionId, clearSessionForTopic } from "#storage/forum/index";
import { type AskReplySource, markPendingAskSources } from "#storage/session-asks";
import { AbortReason, type HandleAgentQueryParams } from "./types";

export function topicQueryKey(userId: number, topicName: string): string {
  return `${userId}:${topicName}`;
}

// --- Active queries (userId:topicName → abort control) ---

export interface ActiveQueryControl {
  abortReason: AbortReason;
  userId: number;
  abortController: AbortController;
  params?: HandleAgentQueryParams;
  // Playwright instance this query is using. Set inside handleAgentQuery
  // right after `ensurePlaywright` resolves so the playwright manager's
  // crash callback can find which queries are tool-blocked on a dead MCP
  // and abort them — without this the SDK waits indefinitely for a tool
  // result the MCP will never deliver (observed 22-min stalls).
  instanceKey?: string;
}

export const activeQueries = new Map<string, ActiveQueryControl>();

// --- Inter-session queue: defers inject requests while a query is running ---

class SessionInjectQueue {
  private queue = new Map<string, HandleAgentQueryParams[]>();

  /** Enqueue params if requestId is set and not a duplicate. Returns true if enqueued. */
  enqueue(queryKey: string, params: HandleAgentQueryParams, logReason: string): boolean {
    if (!params.requestId) {
      // Missing requestId means the caller forgot to thread it through — this
      // is a code bug, not a runtime condition. The inject will be silently
      // dropped, so escalate to `error` so it surfaces in monitoring instead
      // of hiding in warn-level noise.
      logger.error(
        { queryKey, from: params.from, logReason },
        "BUG: session inject reached enqueue without requestId — DROPPING inject",
      );
      return false;
    }
    const q = this.queue.get(queryKey) ?? [];
    if (q.some((p) => p.requestId === params.requestId)) {
      // Intentional dedup (e.g. retry-after-restart, replayed inbox entry).
      // Surface it so operators can distinguish a legit dedup from a buggy
      // collision when investigating a missing reply.
      logger.info(
        { queryKey, requestId: params.requestId, from: params.from },
        "session inject deduped (existing entry with same requestId)",
      );
      return false;
    }
    q.push(params);
    this.queue.set(queryKey, q);
    markPendingAskSources({
      userId: params.userId,
      callerTopic: params.topicName,
      sources: params.askReplySources,
      state: "queued_for_caller",
    });
    logger.info({ queryKey, from: params.from, requestId: params.requestId }, logReason);
    return true;
  }

  /**
   * True when an entry with this requestId is still queued under the key.
   * Used by `handleAgentQuery`'s finally to detect the abort-requeue case:
   * the dying invocation's params (and its forkHandle) were re-enqueued for a
   * later dequeue, so resources tied to them must not be cleaned up yet.
   */
  hasRequest(queryKey: string, requestId: string): boolean {
    return this.queue.get(queryKey)?.some((p) => p.requestId === requestId) ?? false;
  }

  /** Remove and return the next queued params for this key, or undefined if empty. */
  dequeueNext(queryKey: string): HandleAgentQueryParams | undefined {
    const q = this.queue.get(queryKey);
    if (!q?.length) return undefined;
    const next = q.shift()!;
    if (q.length === 0) this.queue.delete(queryKey);
    return next;
  }

  /**
   * Remove and return the longest mergeable PREFIX of the queue as a single
   * entry, or undefined if empty. Multiple prompts are joined so they land in
   * one turn instead of chaining N turns for N queued injects.
   *
   * Caller-bound ask_session replies (`askReplySources`) are safe to merge
   * even when they came from different target topics: the merged turn is just
   * more context for the same caller topic. Other inter-session work remains
   * conservative: same `from`, same `silent` flag, same `sessionId`.
   */
  dequeueAll(queryKey: string): HandleAgentQueryParams | undefined {
    const q = this.queue.get(queryKey);
    if (!q?.length) return undefined;
    const base = q[0];
    const isAskReplyInject = (p: HandleAgentQueryParams) =>
      !p.silent && Boolean(p.askReplySources?.length);
    const baseIsAskReplyInject = isAskReplyInject(base);
    const mergeable = (p: HandleAgentQueryParams) =>
      baseIsAskReplyInject
        ? isAskReplyInject(p)
        : !isAskReplyInject(p) &&
          p.from === base.from &&
          (p.silent ?? false) === (base.silent ?? false) &&
          p.sessionId === base.sessionId;
    let take = 1;
    while (take < q.length && mergeable(q[take])) take++;
    const batch = q.splice(0, take);
    if (q.length === 0) this.queue.delete(queryKey);
    if (batch.length === 1) return batch[0];
    const sources = batch.flatMap((p): AskReplySource[] => {
      if (p.askReplySources?.length) return p.askReplySources;
      if (!p.requestId || !p.from) return [];
      return [{ from: p.from, requestId: p.requestId, contextId: p.contextId }];
    });
    const depths = batch
      .map((p) => p.depth)
      .filter((depth): depth is number => typeof depth === "number");
    return {
      ...base,
      prompt: batch.map((p) => p.prompt).join("\n\n"),
      from: baseIsAskReplyInject
        ? [...new Set(batch.map((p) => p.from).filter(Boolean))].join(", ")
        : base.from,
      depth: depths.length ? Math.min(...depths) : base.depth,
      requestId: `merged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Same-caller batches share one context; only drop it when the batch
      // disagrees (a merged turn must not append to the wrong context).
      contextId: batch.every((p) => p.contextId === base.contextId) ? base.contextId : undefined,
      askReplySources: sources,
    };
  }

  /**
   * All non-empty queue keys belonging to a user (queryKey starts with
   * `${userId}:`). Used by `handleAgentQuery`'s finally to drain other
   * topics' queued inter-session injects when the per-user concurrency cap
   * frees up.
   */
  keysForUser(userId: number): string[] {
    const prefix = `${userId}:`;
    const result: string[] = [];
    for (const key of this.queue.keys()) {
      if (key.startsWith(prefix)) result.push(key);
    }
    return result;
  }
}

export const interSessionQueue = new SessionInjectQueue();

/**
 * Abort the in-flight query (if any) for `userId:topicName` and wait for
 * `handleAgentQuery`'s finally block to clean up before returning.
 *
 * Used by topic lifecycle (delete/reset) so the dying query's tail writes
 * (`setSessionForTopic`, `appendConversationEvent`, `recordUsage`) don't race
 * against row removal — without this wait, those writes silently target a
 * row that no longer exists, leaving orphan log files and zero-row UPDATEs.
 *
 * Returns true when the query exited cleanly (or none was running). Returns
 * false on timeout — caller may still proceed but should treat the topic as
 * potentially having stragglers.
 */
export async function abortAndWaitForQuery(
  userId: number,
  topicName: string,
  reason: AbortReason = AbortReason.External,
  timeoutMs = 5000,
): Promise<boolean> {
  const queryKey = topicQueryKey(userId, topicName);
  const running = activeQueries.get(queryKey);
  if (!running) return true;
  running.abortReason = reason;
  running.abortController.abort();
  const start = Date.now();
  while (activeQueries.get(queryKey) === running) {
    if (Date.now() - start > timeoutMs) {
      logger.warn(
        { userId, topicName, timeoutMs },
        "abortAndWaitForQuery: timeout — proceeding without confirmation",
      );
      return false;
    }
    await delay(50);
  }
  return true;
}

// --- Initializing topics: blocks message handling during /new reset ---

export const initializingTopics = new Set<string>();

// --- DM session retry guard: prevents duplicate retries on concurrent expiry ---

const dmRetryingUsers = new Set<number>();
export const deleteDmRetrying = (userId: number) => dmRetryingUsers.delete(userId);

// SDK does not expose a typed session-expiry error; match by message
const SESSION_EXPIRED_MSG = "No conversation found with session ID";

/**
 * Result of detecting (and acting on) a session-expiry error.
 *
 * - `{ type: "dm-retry" }`: DM expiry — caller retries with `sessionId: null`.
 * - `{ type: "forum-retry", sessionId: null }`: forum expiry where reconstruct
 *   was not attempted or failed — caller retries with a FRESH session and the
 *   DB session_id has been cleared. Context is lost.
 * - `{ type: "forum-retry", sessionId: "<id>" }`: forum expiry where the
 *   native SDK rollout has been REBUILT from the unified conversation log at
 *   the SAME path the SDK expects. Caller retries with the preserved
 *   sessionId. Full context (1500+ entries) is restored. DB session_id is
 *   left untouched.
 */
export type SessionExpiryResult =
  | { type: "dm-retry" }
  | { type: "forum-retry"; sessionId: string | null };

/**
 * Try to rebuild the native SDK rollout file for the topic from the unified
 * conversation log. Returns true on success — the rollout is written at the
 * exact path the SDK looks for and the DB sessionId remains valid.
 *
 * Falls through to `false` silently when there are no entries to encode or
 * the registry's `writeRollout` throws (malformed entries, disk error, etc.)
 * so the caller can fall back to a fresh-session retry.
 */
function tryReconstructForumRollout(
  params: HandleAgentQueryParams,
  userId: number,
  topicName: string,
): boolean {
  const sessionId = params.sessionId;
  if (!sessionId) return false;
  try {
    const entries = readConversation(userId, topicName);
    if (entries.length === 0) return false;
    const cwd = SESSION_WORKSPACE_DIR;
    const agent = getTopicAgent(userId, topicName);
    const result = getRegistry(agent).writeRollout({
      cwd,
      entries,
      reuseSessionId: sessionId,
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
    });
    logger.info(
      {
        userId,
        topicName,
        agent,
        sessionId: result.sessionId,
        rolloutPath: result.rolloutPath,
        entries: entries.length,
      },
      "Forum session expired — rollout reconstructed from unified log, sessionId preserved",
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, userId, topicName, sessionId },
      "Forum session reconstruct failed — falling back to fresh session",
    );
    return false;
  }
}

/**
 * Detects a session-expiry error and either rebuilds the rollout (preferred,
 * keeps context) or clears the stale session (fallback, loses context).
 * Returns the retry result, or null if not an expiry (or already retried once).
 */
export function detectSessionExpiry(
  params: HandleAgentQueryParams,
  errMsg: string,
  userId: number,
  topicName: string,
): SessionExpiryResult | null {
  if (params._sessionRetried || !errMsg.includes(SESSION_EXPIRED_MSG)) return null;

  if (params.sessionType === "dm") {
    if (!dmRetryingUsers.has(userId)) {
      clearDmSessionId(userId);
      dmRetryingUsers.add(userId);
      logger.info({ userId }, "DM session expired, cleared and will retry");
      return { type: "dm-retry" };
    }
    return null;
  }

  // Forum path: try to rebuild the rollout from the unified log so the SDK
  // can resume on the SAME sessionId with full context. Only clear when that
  // path is unavailable (no entries, encoder error, missing sessionId).
  if (tryReconstructForumRollout(params, userId, topicName)) {
    return { type: "forum-retry", sessionId: params.sessionId ?? null };
  }
  clearSessionForTopic(userId, topicName);
  logger.info(
    { userId, topicName },
    "Forum session expired, cleared and will retry with fresh session",
  );
  return { type: "forum-retry", sessionId: null };
}
