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
import { WsHub } from "#bus";
import { deliverPeerReply, type RemoteReplyRoute } from "#mcp/session-comm/peer-forward";
import { deleteProcessingFile, drainOutboxFile, parseOutboxLine } from "#outbox/file-ops";
import { debouncedFlush, FALLBACK_INTERVAL_MS, watchDir } from "#outbox/utils";
import { resolveTopicWorkspaceDir, SESSION_INBOX_DIR } from "#platform/config";
import { FROM_AUTO_CONTINUE, FROM_SELF_SCHEDULE } from "#platform/constants";
import { appendJsonlEntry, readJsonlLines } from "#platform/jsonl";
import { logger } from "#platform/logger";
import {
  sessionInboxPath,
  topicIdFromScheduledSessionInboxFileName,
  topicIdFromSessionInboxFileName,
} from "#query/session-inbox-path";
import { AbortReason } from "#query/types";
import { appendApiMessage, getApiMessage } from "#storage/api-messages";
import { RUNTIME_INSTANCE_ID } from "#storage/runtime-leases";
import {
  acquireRuntimeProcessLease,
  PROCESS_LEASE_HEARTBEAT_MS,
  type RuntimeProcessLeaseHandle,
} from "#storage/runtime-process-leases";
import {
  claimNextDueSelfSchedule,
  completeSelfSchedule,
  heartbeatSelfScheduleClaim,
  markSelfScheduleRunning,
  releaseSelfScheduleClaim,
} from "#storage/self-schedules";
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
      remoteReply?: RemoteReplyRoute;
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

type ScheduledSessionInboxEntry = Extract<SessionInboxEntry, { type: "tell" }> & {
  deliverAt: string;
};

function scheduledEntryDeliveryTime(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<ScheduledSessionInboxEntry>;
  const deliverAt = typeof entry.deliverAt === "string" ? Date.parse(entry.deliverAt) : Number.NaN;
  if (
    entry.type !== "tell" ||
    entry.from !== FROM_SELF_SCHEDULE ||
    typeof entry.message !== "string" ||
    !entry.message ||
    typeof entry.requestId !== "string" ||
    !entry.requestId ||
    !Number.isFinite(deliverAt)
  ) {
    return null;
  }
  return deliverAt;
}

/**
 * Avoid claiming and rewriting a future-only schedule file. Rewriting emits
 * fs.watch events which would otherwise create a 200ms self-triggering flush
 * loop until the earliest entry becomes due. A concurrent append is safe: it
 * emits its own watch event and the fallback poll covers missed notifications.
 */
function scheduledFileNeedsClaim(filePath: string, nowMs: number): boolean {
  try {
    return readJsonlLines(filePath).some((line) => {
      try {
        const deliverAt = scheduledEntryDeliveryTime(JSON.parse(line));
        return deliverAt === null || deliverAt <= nowMs;
      } catch {
        return true;
      }
    });
  } catch {
    // The file may have moved between readdir and this preflight. Let the
    // atomic claim path decide whether anything remains to process.
    return true;
  }
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
  if (entry.remoteReply) return;
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
  await dispatchDueSelfSchedules();
  // Upgrade compatibility: schedules written by versions before the SQLite
  // manager remain consumable from their legacy `.schedule` sidecars.
  sweepScheduledSessionInbox();
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

type SelfScheduleTurnTrigger = typeof import("#runtime/turn-runner").triggerTopicAiTurn;

/**
 * Claim and start due DB-backed self-schedules. A busy-topic race is removed
 * from the process-local defer queue and returned to durable pending state;
 * interrupted runs are retried after the topic is idle again.
 */
export async function dispatchDueSelfSchedules(
  nowMs = Date.now(),
  triggerOverride?: SelfScheduleTurnTrigger,
): Promise<number> {
  const trigger = triggerOverride ?? (await import("#runtime/turn-runner")).triggerTopicAiTurn;
  const { cancelDeferredInject } = await import("#query/active-rooms");
  const { getTopic } = await import("#storage/api-topics");
  const ownerId = `${RUNTIME_INSTANCE_ID}:self-schedule`;
  let started = 0;

  // Bound one sweep so a corrupt/hostile database cannot monopolize the inbox
  // worker. The 5s fallback poll picks up any remaining due topics.
  for (let index = 0; index < 100; index++) {
    const schedule = claimNextDueSelfSchedule(ownerId, nowMs);
    if (!schedule) break;
    const topic = getTopic(schedule.topicId);
    if (
      !topic?.agent ||
      !topic.participants.some((participant) => participant.userId === schedule.userId)
    ) {
      completeSelfSchedule(schedule.id, ownerId);
      logger.warn(
        { scheduleId: schedule.id, topicId: schedule.topicId, userId: schedule.userId },
        "self-schedule: target topic unavailable, dropping",
      );
      continue;
    }

    let settled = false;
    let claimHeartbeat: ReturnType<typeof setInterval> | null = null;
    const stopClaimHeartbeat = () => {
      if (!claimHeartbeat) return;
      clearInterval(claimHeartbeat);
      claimHeartbeat = null;
    };
    const fromLabel = "Scheduled self";
    const queryId = trigger(
      topic.id,
      schedule.userId,
      `[Tell from **${fromLabel}**]\n\n${schedule.message}`,
      topic.agent,
      {
        origin: fromLabel,
        requestId: schedule.id,
        depth: 0,
        from: fromLabel,
        injectAuthorId: "system",
        onSettled: (result) => {
          settled = true;
          stopClaimHeartbeat();
          if (result.kind === "aborted" && result.abortReason === AbortReason.Internal) {
            // User preemption requeues injects in memory. Remove that copy and
            // restore the durable schedule instead; a newer pending schedule
            // created by this run wins if one already exists.
            cancelDeferredInject(topic.id, schedule.id);
            releaseSelfScheduleClaim(schedule.id, ownerId);
            return;
          }
          completeSelfSchedule(schedule.id, ownerId);
        },
      },
    );

    if (!queryId) {
      if (!settled) {
        // The room became busy between the DB idle check and turn claim.
        cancelDeferredInject(topic.id, schedule.id);
        releaseSelfScheduleClaim(schedule.id, ownerId);
      }
      // Avoid immediately reclaiming the same overdue schedule in this sweep.
      break;
    }
    if (markSelfScheduleRunning(schedule.id, ownerId, queryId) && !settled) {
      claimHeartbeat = setInterval(() => {
        if (heartbeatSelfScheduleClaim(schedule.id, ownerId)) return;
        stopClaimHeartbeat();
      }, 1_000);
      claimHeartbeat.unref?.();
    }
    started++;
  }
  return started;
}

/**
 * Promote due schedule_self sidecars into the normal session inbox. Files are
 * atomically claimed with the same crash-recovery primitive as every outbox;
 * future entries are appended back and due entries retain their requestId.
 */
export function sweepScheduledSessionInbox(nowMs = Date.now()): void {
  let userDirs: string[];
  try {
    userDirs = readdirSync(SESSION_INBOX_DIR);
  } catch {
    return;
  }

  for (const userId of userDirs) {
    const userInboxDir = join(SESSION_INBOX_DIR, userId);
    let files: string[];
    try {
      files = readdirSync(userInboxDir);
    } catch {
      continue;
    }
    const scheduledFiles = new Set(
      files
        .filter((file) => file.endsWith(".schedule") || file.endsWith(".schedule.processing"))
        .map((file) =>
          file.endsWith(".processing") ? file.slice(0, -".processing".length) : file,
        ),
    );

    for (const file of scheduledFiles) {
      const topicId = topicIdFromScheduledSessionInboxFileName(file);
      if (!topicId) continue;
      const schedulePath = join(userInboxDir, file);
      const hasProcessingClaim = files.includes(`${file}.processing`);
      if (!hasProcessingClaim && !scheduledFileNeedsClaim(schedulePath, nowMs)) continue;
      const drained = drainOutboxFile(schedulePath, "self-schedule");
      if (!drained) continue;
      const pending: ScheduledSessionInboxEntry[] = [];
      const due: ScheduledSessionInboxEntry[] = [];

      for (const line of drained.lines) {
        const entry = parseOutboxLine<ScheduledSessionInboxEntry>(line, "self-schedule");
        const deliverAt = scheduledEntryDeliveryTime(entry);
        if (!entry || deliverAt === null) {
          logger.warn({ userId, topicId }, "self-schedule: invalid entry dropped");
          continue;
        }
        (deliverAt <= nowMs ? due : pending).push(entry);
      }

      for (const entry of due) {
        const { deliverAt: _deliverAt, ...liveEntry } = entry;
        appendJsonlEntry(sessionInboxPath(userId, topicId), liveEntry);
      }
      for (const entry of pending) appendJsonlEntry(schedulePath, entry);
      deleteProcessingFile(drained.processingPath, "self-schedule", drained.lines.length);

      if (due.length > 0) {
        logger.info({ userId, topicId, count: due.length }, "self-schedule: due entries promoted");
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
  const requestId =
    entry.requestId ??
    stableLegacyRequestId("legacy-tell", [topicName, entry.from, entry.message, entry.timestamp]);

  if (!isAiEnabled) {
    // AI-enabled targets are persisted by triggerTopicAiTurn below. Human-only
    // targets still need a visible DB message even though no AI turn runs. A
    // request-derived id makes crash replay converge on the same row.
    const msgId = `tell-${requestId}`;
    const now = new Date().toISOString();
    const text = `[from ${fromLabel}]\n${entry.message}`;

    try {
      appendApiMessage({
        id: msgId,
        topicId: topic.id,
        authorId: "system",
        sourceAdapter: "session-comm",
        text,
        createdAt: now,
      });
    } catch (e) {
      logger.error({ err: e, topicName }, "session-inbox: failed to persist tell message");
    }
  }

  // Trigger AI turn (defers behind a running user turn via B's abort-on-new-message).
  if (isAiEnabled) {
    const isAutoContinue = entry.from === FROM_AUTO_CONTINUE;
    const isHiddenContinue = isAutoContinue;
    triggerTopicAiTurn(
      topic.id,
      String(scope.userId),
      isHiddenContinue ? entry.message : `[Tell from **${fromLabel}**]\n\n${entry.message}`,
      (topic.agent ?? undefined) as Parameters<typeof triggerTopicAiTurn>[3],
      {
        origin: fromLabel,
        requestId,
        depth: entry.depth,
        from: fromLabel,
        hideInjectMessage: isHiddenContinue,
        injectAuthorId: "system",
        injectSourceAdapter: "session-comm",
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
  const remoteReply = entry.remoteReply;

  // Build the prompt with read-only instruction (mirrors Otium).
  const prompt = `[ASK from ${fromLabel}]\n${entry.message}\n\n이건 ${fromLabel}이 당신의 context를 참조하려는 요청입니다 (READ-only).\n가지고 있는 정보를 그대로 공유하세요.\n출력 내용은 자동으로 "${fromLabel}" 세션에 돌아갑니다.`;

  if (!isAiEnabled) {
    logger.warn({ topicName, from: entry.from }, "session-inbox: ask to non-AI topic, dropping");
    clearPendingAskForEntry(scope, entry, topicName, "target-ai-disabled");
    if (remoteReply) {
      await deliverPeerReply(
        remoteReply,
        topic.title,
        `(error: target topic "${topicName}" has no AI)`,
        "error",
      );
    } else {
      await notifyAskDrop(
        scope,
        entry,
        topicName,
        `(error: target topic "${topicName}" has no AI)`,
      );
    }
    return;
  }

  // Register the ask reply callback so the AI's response routes back to the caller.
  // requestId is pre-generated by the MCP writer — we use it as-is.
  const requestId = entry.requestId;

  // Look up the caller topic to route the reply back.
  const callerTopic = remoteReply ? null : await resolveEntryCallerTopic(scope, entry);
  const callerTopicId = remoteReply?.topicId ?? callerTopic?.id;
  if (!requestId || !callerTopicId) {
    clearPendingAskForEntry(scope, entry, topicName, "caller-topic-not-found");
    logger.warn(
      { topicName, from: entry.from, fromTopicId: entry.fromTopicId, requestId, callerTopicId },
      "session-inbox: ask cannot be routed back, dropping",
    );
    return;
  }

  if (!remoteReply) {
    persistVisibleAskMessage({
      callerTopicId,
      callerUserId: String(scope.userId),
      targetLabel: topic.title,
      requestId,
      message: entry.message,
    });
  }

  const { getTopic, getTopicSessionId } = await import("#storage/api-topics");
  const fullTopic = getTopic(topic.id);
  const agentOverride = (fullTopic?.agent ?? topic.agent ?? undefined) as AgentKind | undefined;
  const cwd = resolveTopicWorkspaceDir(topic.id);
  if (!agentOverride) {
    clearPendingAskForEntry(scope, entry, topicName, "target-agent-missing");
    await notifyAskDrop(scope, entry, topicName, "(error: target topic has no agent)");
    return;
  }

  // Delay the snapshot until the queued turn actually claims the target room.
  // This ensures the fork includes any user turn that was ahead of the ask.
  const prepareSession = async () => {
    const { forkAgentSession } = await import("#agents/fork");
    const { getRegistry } = await import("#agents/registry");
    const { resolveModelForAgent } = await import("#agents/model-catalog");
    const { getApiTopicConfig } = await import("#storage/api-topic-config");
    const { readConversation } = await import("#storage/conversations");
    const currentTopic = getTopic(topic.id);
    const registry = getRegistry(agentOverride);
    const topicConfig = getApiTopicConfig(topic.id);
    const model = resolveModelForAgent(
      agentOverride,
      topicConfig?.model ?? currentTopic?.defaultModel,
      registry,
    );
    const requestedEffort = topicConfig?.effort ?? currentTopic?.defaultEffort;
    const effort =
      requestedEffort && registry.validateEffort(requestedEffort)
        ? requestedEffort
        : registry.defaultEffort;
    const parentSessionId = getTopicSessionId(topic.id);

    if (parentSessionId) {
      try {
        return await forkAgentSession({
          agent: agentOverride,
          parentSessionId,
          cwd,
          userId: scope.userId,
          topicName,
          title: `ask: ${entry.from} -> ${topicName}`,
          model,
          ...(effort ? { effort } : {}),
        });
      } catch (err) {
        // A stale provider session should not make ask_session unusable. The
        // unified log is the durable source of truth and can seed a new fork.
        logger.warn(
          { err, topicName, from: entry.from, requestId, parentSessionId },
          "session-inbox: native target fork failed; synthesizing from unified history",
        );
      }
    }

    const rollout = registry.writeRollout({
      cwd,
      entries: readConversation(scope.userId, topicName),
      model,
      ...(effort ? { effort } : {}),
    });
    return {
      agent: agentOverride,
      forkId: rollout.sessionId,
      rolloutPath: rollout.rolloutPath,
    };
  };

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
      prepareSession,
      cwd,
      onSettled: (result) => {
        if (result.queryId || result.kind !== "error") return;
        clearPendingAskForEntry(scope, entry, topicName, "target-unavailable-before-dispatch");
        if (remoteReply) {
          void deliverPeerReply(
            remoteReply,
            topic.title,
            `(error: target topic became unavailable before dispatch)`,
            "error",
          );
        } else {
          void notifyAskDrop(
            scope,
            entry,
            topicName,
            `(error: target topic became unavailable before dispatch)`,
          );
        }
      },
      onDispatched: (queryId: string) => {
        registerAskCallback({
          requestId,
          contextId: entry.contextId,
          callerTopicId,
          callerUserId: String(scope.userId),
          targetQueryId: queryId,
          createdAt: Date.now(),
          ...(remoteReply
            ? { remoteReply }
            : {
                pendingAsk: {
                  userId: scope.userId,
                  from: entry.from,
                  to: topicName,
                  requestId,
                },
              }),
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
let leadershipTimer: ReturnType<typeof setInterval> | null = null;
let workerLease: RuntimeProcessLeaseHandle | null = null;
let workerStarted = false;

const SESSION_INBOX_PROCESS_ROLE = "worker:session-inbox";

function stopLeaderResources(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  debouncedTrigger = null;
}

function tryBecomeSessionInboxLeader(): void {
  if (!workerStarted || workerLease) return;

  let acquired: RuntimeProcessLeaseHandle | null = null;
  acquired = acquireRuntimeProcessLease(SESSION_INBOX_PROCESS_ROLE, {
    onLost: () => {
      if (workerLease !== acquired) return;
      workerLease = null;
      stopLeaderResources();
      logger.warn("session-inbox: worker leadership lost");
    },
  });
  if (!acquired) return;

  workerLease = acquired;
  debouncedTrigger = debouncedFlush(flushSessionInbox, "session-inbox", 200);
  watcher = watchDir(SESSION_INBOX_DIR, () => debouncedTrigger?.());
  fallbackTimer = setInterval(() => debouncedTrigger?.(), FALLBACK_INTERVAL_MS);
  fallbackTimer.unref?.();

  logger.info(
    { dir: SESSION_INBOX_DIR, role: SESSION_INBOX_PROCESS_ROLE },
    "session-inbox: worker leadership acquired",
  );
  // Fire an initial flush to drain entries written before this leader started.
  void flushSessionInbox();
}

/**
 * Join the session-inbox worker election. Exactly one runtime process watches
 * and drains the shared inbox; contenders take over when its process lease is
 * released, expires, or belongs to a dead PID.
 * Returns a cleanup function for graceful shutdown.
 */
export function startSessionInboxWorker(): () => void {
  if (workerStarted) return () => {};
  workerStarted = true;

  tryBecomeSessionInboxLeader();
  leadershipTimer = setInterval(tryBecomeSessionInboxLeader, PROCESS_LEASE_HEARTBEAT_MS);
  leadershipTimer.unref?.();

  return () => {
    if (!workerStarted) return;
    workerStarted = false;
    if (leadershipTimer) {
      clearInterval(leadershipTimer);
      leadershipTimer = null;
    }
    stopLeaderResources();
    workerLease?.stop();
    workerLease = null;
    logger.info("session-inbox: worker stopped");
  };
}
