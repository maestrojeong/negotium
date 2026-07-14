/**
 * Session-inbox consumer — reads MCP-written JSONL inbox files and dispatches
 * inter-session messages (ask/tell/abort) in the runtime process.
 *
 * Architecture:
 *   MCP tools (session-comm server.ts) → appendJsonlEntry → inbox JSONL
 *   Runtime host (this module)         → drainOutboxFile  → process entries
 *
 * Both converge on `triggerTopicAiTurn` from the turn runner.
 *
 * Port of otium's `query/session-inbox.ts` with every peer/placement branch
 * removed (placed rooms, peer inject dispatch, remote ask replies): this node
 * runs every turn locally, so asks route only to local caller topics.
 */

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ForkHandle } from "#agents/fork";
import { WsHub } from "#bus";
import { deleteProcessingFile, drainOutboxFile, parseOutboxLine } from "#outbox/file-ops";
import { debouncedFlush, FALLBACK_INTERVAL_MS, watchDir } from "#outbox/utils";
import { resolveTopicWorkspaceDir, SESSION_INBOX_DIR } from "#platform/config";
import { FROM_AUTO_CONTINUE } from "#platform/constants";
import { logger } from "#platform/logger";
import { topicIdFromSessionInboxFileName } from "#query/session-inbox-path";
import { appendApiMessage, getApiMessage } from "#storage/api-messages";
import { clearPendingAsk } from "#storage/session-asks";
import type { AgentKind } from "#types";

// ── Entry types (match MCP server.ts write format) ──────────────────

type SessionInboxEntry =
  | { type: "abort"; timestamp: string }
  | {
      type: "ask";
      requestId: string;
      from: string;
      fromTitle?: string;
      fromTopicId?: string;
      message: string;
      contextId?: string;
      fromDepth?: number;
      timestamp: string;
    }
  | {
      type: "tell";
      from: string;
      fromTitle?: string;
      fromTopicId?: string;
      message: string;
      depth: number;
      requestId?: string;
      silent?: boolean;
      timestamp: string;
    };

interface PendingAskScope {
  userId: string;
}

function pendingAskScope(userId: string): PendingAskScope {
  return { userId };
}

function clearPendingAskForEntry(
  scope: PendingAskScope,
  entry: Extract<SessionInboxEntry, { type: "ask" }>,
  topicName: string,
  reason: string,
): void {
  if (!entry.from) return;
  const cleared = clearPendingAsk({
    userId: scope.userId,
    from: entry.from,
    to: topicName,
    requestId: entry.requestId,
  });
  logger.info(
    { from: entry.from, to: topicName, requestId: entry.requestId, cleared, reason },
    "session-inbox: pending ask cleared",
  );
}

function entryFromLabel(entry: { from: string; fromTitle?: string }): string {
  return entry.fromTitle?.trim() || entry.from;
}

async function resolveEntryCallerTopic(
  scope: PendingAskScope,
  entry: Extract<SessionInboxEntry, { type: "ask" }>,
) {
  const { getTopic, getTopicByNameForUser } = await import("#storage/api-topics");
  if (entry.fromTopicId) {
    const byId = getTopic(entry.fromTopicId);
    if (byId?.participants.some((p) => p.userId === scope.userId)) return byId;
  }
  return getTopicByNameForUser(entry.from, String(scope.userId));
}

function notifyCallerTopic(callerTopicId: string, targetLabel: string, message: string): void {
  const msg = {
    id: randomUUID(),
    topicId: callerTopicId,
    authorId: "system",
    text: `[<- ${targetLabel}]\n${message}`,
    createdAt: new Date().toISOString(),
  };
  appendApiMessage(msg, { notify: false });
  WsHub.get().broadcastMessage(callerTopicId, msg);
}

function persistVisibleAskMessage(args: {
  callerTopicId: string;
  callerUserId: string;
  targetLabel: string;
  requestId: string;
  message: string;
}): void {
  const msg = {
    id: `ask-${args.requestId}-sent`,
    topicId: args.callerTopicId,
    authorId: args.callerUserId,
    text: `[Ask to **${args.targetLabel}**]\n\n${args.message}`,
    createdAt: new Date().toISOString(),
  };
  try {
    appendApiMessage(msg, { notify: false });
    WsHub.get().broadcastMessage(args.callerTopicId, msg);
  } catch (error) {
    // Inbox files are at-least-once. The stable request-derived id makes a
    // replay successful without duplicating the visible card.
    if (!getApiMessage(args.callerTopicId, msg.id)) throw error;
  }
}

async function notifyAskDrop(
  scope: PendingAskScope,
  entry: Extract<SessionInboxEntry, { type: "ask" }>,
  targetLabel: string,
  message: string,
): Promise<void> {
  if (!entry.from) return;
  const callerTopic = await resolveEntryCallerTopic(scope, entry);
  if (!callerTopic) {
    logger.warn(
      { from: entry.from, to: targetLabel, requestId: entry.requestId },
      "session-inbox: failed to notify ask caller — caller topic not found",
    );
    return;
  }
  try {
    notifyCallerTopic(callerTopic.id, targetLabel, message);
  } catch (err) {
    logger.warn(
      { err, from: entry.from, to: targetLabel, requestId: entry.requestId },
      "session-inbox: failed to notify ask caller",
    );
  }
}

function stableLegacyRequestId(prefix: string, parts: Array<string | number | undefined>): string {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}-${hash}`;
}

// ── Per-topic worker mutex ──────────────────────────────────────────

/**
 * Key: `${userId}/${topicName}`. While a worker is draining a topic's inbox,
 * the dispatcher skips it — same-topic entries must be serial to preserve
 * order and avoid `drainOutboxFile` rename races.
 */
const topicWorkerBusy = new Set<string>();

// ── Dispatcher ──────────────────────────────────────────────────────

/**
 * Scan all user inbox dirs and kick a worker per topic. Returns immediately
 * — workers run in the background.
 *
 * Triggered by fs.watch (200ms debounce) + {@link FALLBACK_INTERVAL_MS} fallback poll.
 */
export async function flushSessionInbox() {
  let userDirs: string[];
  try {
    userDirs = readdirSync(SESSION_INBOX_DIR);
  } catch {
    // Dir doesn't exist yet — nothing to drain.
    return;
  }

  for (const uid of userDirs) {
    const userInboxDir = join(SESSION_INBOX_DIR, uid);
    let entries: string[];
    try {
      entries = readdirSync(userInboxDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(userInboxDir, entry);

      let isDir = false;
      try {
        isDir = statSync(entryPath).isDirectory();
      } catch {
        continue;
      }

      if (!isDir && entry.endsWith(".jsonl")) {
        // New files are keyed by an encoded canonical topic id. Keep reading
        // legacy title-keyed files during rolling upgrades.
        const topicId = topicIdFromSessionInboxFileName(entry);
        const topicName = topicId ? "" : entry.replace(/\.jsonl$/, "");
        const topicKey = `${uid}/${topicId ? `id:${topicId}` : topicName}`;
        if (topicWorkerBusy.has(topicKey)) continue;

        topicWorkerBusy.add(topicKey);
        processTopicInbox({ topicKey, filePath: entryPath, userId: uid, topicId, topicName })
          .catch((e) => logger.error({ err: e, topicKey }, "session-inbox: topic worker crashed"))
          .finally(() => topicWorkerBusy.delete(topicKey));
      }
    }
  }
}

// ── Topic worker ────────────────────────────────────────────────────

async function processTopicInbox(args: {
  topicKey: string;
  filePath: string;
  userId: string;
  topicId: string | null;
  topicName: string;
}) {
  // Lazy-import to avoid circular deps at module-load time.
  const { getTopic, getTopicByNameForUser } = await import("#storage/api-topics");
  const { topicKey, filePath, userId, topicId, topicName } = args;
  const scope = pendingAskScope(userId);

  while (true) {
    const drained = drainOutboxFile(filePath, "session-inbox");
    if (!drained) return;
    const { lines, processingPath } = drained;
    const seenRequestIds = new Set<string>();

    for (const line of lines) {
      const raw = parseOutboxLine<Record<string, unknown>>(line, "session-inbox");
      if (!raw) continue;

      // Normalize: Otium legacy compat (command/type-less → tell/ask).
      let entry: SessionInboxEntry;
      if (raw.type === "abort") {
        entry = raw as SessionInboxEntry;
      } else if (raw.command || raw.type === "command" || raw.type === "tell") {
        entry = { ...raw, type: "tell" } as SessionInboxEntry;
      } else {
        entry = { ...raw, type: "ask" } as SessionInboxEntry;
      }

      if (!topicId && !topicName) {
        logger.error({ filePath, topicKey }, "session-inbox: could not extract topic name");
        continue;
      }

      // ── abort ──────────────────────────────────────────────────
      if (entry.type === "abort") {
        await handleAbortEntry(userId, topicName, topicId, entry.timestamp);
        continue;
      }

      // ── validate from/message ──────────────────────────────────
      if (!entry.from || !entry.message) {
        logger.error({ entry }, "session-inbox: missing from/message, dropping");
        // MCP writer clears its own pending ask on write failure;
        // the inbox consumer only drops the entry.
        if (entry.type === "ask") {
          clearPendingAskForEntry(scope, entry, topicName, "invalid-entry");
          logger.warn({ from: entry.from, to: topicName }, "session-inbox: dropping invalid ask");
          await notifyAskDrop(scope, entry, topicName, "(error: invalid ask entry)");
        }
        continue;
      }

      if (entry.requestId) {
        if (seenRequestIds.has(entry.requestId)) {
          logger.info(
            { topicKey, topicName, requestId: entry.requestId, from: entry.from },
            "session-inbox: duplicate requestId in drained batch, skipping",
          );
          continue;
        }
        seenRequestIds.add(entry.requestId);
      }

      // Look up the target topic.
      const byId = topicId ? getTopic(topicId) : null;
      const topic = topicId
        ? byId?.participants.some((participant) => participant.userId === userId)
          ? byId
          : null
        : getTopicByNameForUser(topicName, userId);
      if (!topic) {
        logger.warn({ topicName, from: entry.from }, "session-inbox: topic not found, dropping");
        if (entry.type === "ask") {
          clearPendingAskForEntry(scope, entry, topicName, "target-topic-not-found");
          await notifyAskDrop(
            scope,
            entry,
            topicName,
            `(error: target topic "${topicName}" was not found)`,
          );
        }
        continue;
      }

      // The AI-enabled check: topics without agent can't run AI turns.
      const isAiEnabled = Boolean(topic.agent?.trim());

      // ── tell ───────────────────────────────────────────────────
      if (entry.type === "tell") {
        await handleTellEntry(topic, topic.title, entry, isAiEnabled, scope);
        continue;
      }

      // ── ask ────────────────────────────────────────────────────
      if (entry.type === "ask") {
        await handleAskEntry(topic, topic.title, entry, isAiEnabled, scope);
      }
    }

    // At-least-once: drop the claim only after the whole batch was handled.
    // A crash mid-batch leaves the `.processing` claim on disk; the next
    // drain's leftover-merge redelivers it.
    deleteProcessingFile(processingPath, "session-inbox", lines.length);
  }
}

// ── Entry handlers ──────────────────────────────────────────────────

async function handleAbortEntry(
  userId: string,
  topicName: string,
  topicId: string | null,
  issuedAt?: string,
) {
  const { getTopic, getTopicByNameForUser } = await import("#storage/api-topics");
  const byId = topicId ? getTopic(topicId) : null;
  const topic = topicId
    ? byId?.participants.some((participant) => participant.userId === userId)
      ? byId
      : null
    : getTopicByNameForUser(topicName, userId);
  if (!topic) {
    logger.warn({ topicName }, "session-inbox: abort for unknown topic, skipping");
    return;
  }

  const { abortRoom, getRoomQuery, interSessionQueue } = await import("#query/active-rooms");

  // The user's intent at abort time also covers work still waiting in the
  // defer queue — otherwise the "aborted" room immediately restarts.
  interSessionQueue.drop(topic.id);

  // Stale-abort guard: the inbox is at-least-once, so an abort entry can be
  // consumed AFTER a newer turn already claimed the room. Only abort turns
  // that started before the abort was issued (60s skew allowance).
  const issuedMs = issuedAt ? Date.parse(issuedAt) : Number.NaN;
  const running = getRoomQuery(topic.id);
  if (running?.startedAt && Number.isFinite(issuedMs) && running.startedAt > issuedMs + 60_000) {
    logger.info(
      { topicName, topicId: topic.id, startedAt: running.startedAt, issuedMs },
      "session-inbox: stale abort ignored — turn started after abort was issued",
    );
    return;
  }

  // Abort the running query via the room-keyed registry (B from active-rooms.ts).
  const aborted = abortRoom(topic.id);
  logger.info({ topicName, topicId: topic.id, aborted }, "session-inbox: abort processed");
}

async function handleTellEntry(
  topic: { id: string; title: string; agent?: string | null },
  topicName: string,
  entry: Extract<SessionInboxEntry, { type: "tell" }>,
  isAiEnabled: boolean,
  scope: PendingAskScope,
) {
  const { triggerTopicAiTurn } = await import("#runtime/turn-runner");
  const fromLabel = entryFromLabel(entry);

  if (!isAiEnabled) {
    // AI-enabled targets are persisted by triggerTopicAiTurn below. Human-only
    // targets still need a visible DB message even though no AI turn runs.
    // TODO(C2-A idempotency): derive a stable id from requestId/entry fields so
    // inbox crash-replay cannot duplicate visible tell messages.
    const msgId =
      (globalThis.crypto?.randomUUID?.() as string | undefined) ??
      `tell-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const now = new Date().toISOString();
    const text = `[from ${fromLabel}]\n${entry.message}`;

    try {
      appendApiMessage({
        id: msgId,
        topicId: topic.id,
        authorId: "system",
        text,
        createdAt: now,
      });
    } catch (e) {
      logger.error({ err: e, topicName }, "session-inbox: failed to persist tell message");
    }
  }

  // Trigger AI turn (defers behind a running user turn via B's abort-on-new-message).
  if (isAiEnabled) {
    const requestId =
      entry.requestId ??
      stableLegacyRequestId("legacy-tell", [topicName, entry.from, entry.message, entry.timestamp]);
    const isAutoContinue = entry.from === FROM_AUTO_CONTINUE;
    triggerTopicAiTurn(
      topic.id,
      String(scope.userId),
      isAutoContinue ? entry.message : `[Tell from **${fromLabel}**]\n\n${entry.message}`,
      (topic.agent ?? undefined) as Parameters<typeof triggerTopicAiTurn>[3],
      {
        origin: fromLabel,
        requestId,
        depth: entry.depth,
        from: fromLabel,
        hideInjectMessage: isAutoContinue,
        injectAuthorId: "system",
      },
    );
  }

  logger.info(
    { topicName, from: entry.from, fromLabel, aiEnabled: isAiEnabled },
    "session-inbox: tell delivered",
  );
}

async function handleAskEntry(
  topic: { id: string; title: string; agent?: string | null },
  topicName: string,
  entry: Extract<SessionInboxEntry, { type: "ask" }>,
  isAiEnabled: boolean,
  scope: PendingAskScope,
) {
  const { triggerTopicAiTurn } = await import("#runtime/turn-runner");
  const { registerAskCallback } = await import("#runtime/ask-callbacks");
  const fromLabel = entryFromLabel(entry);

  // Build the prompt with read-only instruction (mirrors Otium).
  const prompt = `[ASK from ${fromLabel}]\n${entry.message}\n\n이건 ${fromLabel}이 당신의 context를 참조하려는 요청입니다 (READ-only).\n가지고 있는 정보를 그대로 공유하세요.\n출력 내용은 자동으로 "${fromLabel}" 세션에 돌아갑니다.`;

  if (!isAiEnabled) {
    logger.warn({ topicName, from: entry.from }, "session-inbox: ask to non-AI topic, dropping");
    clearPendingAskForEntry(scope, entry, topicName, "target-ai-disabled");
    await notifyAskDrop(scope, entry, topicName, `(error: target topic "${topicName}" has no AI)`);
    return;
  }

  // Register the ask reply callback so the AI's response routes back to the caller.
  // requestId is pre-generated by the MCP writer — we use it as-is.
  const requestId = entry.requestId;

  // Look up the caller topic to route the reply back.
  const callerTopic = await resolveEntryCallerTopic(scope, entry);
  const callerTopicId = callerTopic?.id;
  if (!requestId || !callerTopicId) {
    clearPendingAskForEntry(scope, entry, topicName, "caller-topic-not-found");
    logger.warn(
      { topicName, from: entry.from, fromTopicId: entry.fromTopicId, requestId, callerTopicId },
      "session-inbox: ask cannot be routed back, dropping",
    );
    return;
  }

  persistVisibleAskMessage({
    callerTopicId,
    callerUserId: String(scope.userId),
    targetLabel: topic.title,
    requestId,
    message: entry.message,
  });

  let sessionId: string | undefined | null;
  let forkHandle: ForkHandle | undefined;
  const { getTopic, getTopicSessionId } = await import("#storage/api-topics");
  const fullTopic = getTopic(topic.id);
  const parentSessionId = getTopicSessionId(topic.id);
  const agentOverride = (fullTopic?.agent ?? topic.agent ?? undefined) as AgentKind | undefined;
  const cwd = resolveTopicWorkspaceDir(topic.id);
  if (parentSessionId && agentOverride) {
    try {
      const { forkAgentSession } = await import("#agents/fork");
      const { getRegistry } = await import("#agents/registry");
      const { resolveModelForAgent } = await import("#agents/model-catalog");
      const { getApiTopicConfig } = await import("#storage/api-topic-config");
      const registry = getRegistry(agentOverride);
      const topicConfig = getApiTopicConfig(topic.id);
      const model = resolveModelForAgent(
        agentOverride,
        topicConfig?.model ?? fullTopic?.defaultModel,
        registry,
      );
      const requestedEffort = topicConfig?.effort ?? fullTopic?.defaultEffort;
      const effort =
        requestedEffort && registry.validateEffort(requestedEffort)
          ? requestedEffort
          : registry.defaultEffort;
      forkHandle = await forkAgentSession({
        agent: agentOverride,
        parentSessionId,
        cwd,
        userId: scope.userId,
        topicName,
        title: `ask: ${entry.from} -> ${topicName}`,
        model,
        ...(effort ? { effort } : {}),
      });
      sessionId = forkHandle.forkId;
    } catch (err) {
      clearPendingAskForEntry(scope, entry, topicName, "main-fork-failed");
      await notifyAskDrop(scope, entry, topicName, "(error: failed to fork target session)");
      logger.warn(
        { err, topicName, from: entry.from, requestId, parentSessionId },
        "session-inbox: failed to fork target session",
      );
      return;
    }
  } else {
    sessionId = null;
  }

  // Trigger the AI turn. The onDispatched callback registers the reply route
  // at the moment the turn actually starts (immediately, or after being deferred
  // behind a running user turn via B's queue).
  triggerTopicAiTurn(
    topic.id,
    String(scope.userId),
    prompt,
    (agentOverride ?? topic.agent ?? undefined) as Parameters<typeof triggerTopicAiTurn>[3],
    {
      origin: entry.from,
      requestId,
      contextId: entry.contextId,
      depth: (entry.fromDepth ?? 0) + 1,
      silent: true,
      sessionId,
      forkHandle,
      cwd,
      onDispatched: (queryId: string) => {
        registerAskCallback({
          requestId,
          contextId: entry.contextId,
          callerTopicId,
          callerUserId: String(scope.userId),
          targetQueryId: queryId,
          createdAt: Date.now(),
          pendingAsk: {
            userId: scope.userId,
            from: entry.from,
            to: topicName,
            requestId,
          },
        });
      },
    },
  );

  logger.info(
    { topicName, from: entry.from, requestId, callerTopicId },
    "session-inbox: ask delivered",
  );
}

// ── Bootstrap ───────────────────────────────────────────────────────

let watcher: ReturnType<typeof watchDir> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let debouncedTrigger: (() => void) | null = null;

/**
 * Start the session-inbox consumer. Call once on host boot.
 * Returns a cleanup function for graceful shutdown.
 */
export function startSessionInboxWorker(): () => void {
  if (debouncedTrigger) return () => {}; // Already started.

  debouncedTrigger = debouncedFlush(flushSessionInbox, "session-inbox", 200);
  watcher = watchDir(SESSION_INBOX_DIR, () => debouncedTrigger?.());
  fallbackTimer = setInterval(() => debouncedTrigger?.(), FALLBACK_INTERVAL_MS);

  logger.info({ dir: SESSION_INBOX_DIR }, "session-inbox: worker started");
  // Fire an initial flush to drain any entries written before the worker started.
  void flushSessionInbox();

  return () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    debouncedTrigger = null;
    logger.info("session-inbox: worker stopped");
  };
}
