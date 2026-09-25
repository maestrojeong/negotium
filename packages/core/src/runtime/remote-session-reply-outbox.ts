/**
 * Durable delivery of remote ask answers to the hub.
 *
 * The target side of a hub-routed `ask_session` answers by posting to the
 * hub with the one-shot `rsr1` reply token the hub put in the inbox entry.
 * The hub may be briefly unreachable (relay hiccup, restart), so the answer
 * is written to `remote_session_reply_outbox` first and posted from there:
 * immediately, then on a 5/10/20/30 s (cap) jittered backoff polled every
 * `REMOTE_SESSION_REPLY_RETRY_MS`, until the hub settles it or the caller's
 * pending-ask TTL (15 min) has passed — after which the caller has already
 * timed out and the answer is dropped with a log line.
 *
 * The same worker is the node's periodic remote-session maintenance: it also
 * purges expired inbox claims and stale caller asks, and re-runs inbox
 * deliveries an earlier process left mid-flight.
 */
import { hubRemoteReply } from "#mcp/session-comm/hub-remote-session";
import { logger } from "#platform/logger";
import { deleteHubRemoteAskCallbackRow, purgeStaleAsks } from "#runtime/ask-callbacks";
import {
  expireUnknownRemoteSessionAsks,
  recoverRemoteSessionInbox,
} from "#runtime/remote-session-inbox";
import { db } from "#storage/forum-db";
import {
  deferRemoteSessionReplyOutbox,
  deleteRemoteSessionReplyOutbox,
  listRemoteSessionReplyOutbox,
  purgeExpiredRemoteSessionReplyOutbox,
  purgeRemoteSessionInboxClaims,
  purgeStaleRemoteSessionAsks,
  REMOTE_SESSION_REPLY_RETRY_MS,
  reconcileRemoteSessionAsks,
  upsertRemoteSessionReplyOutbox,
} from "#storage/remote-session";

let retryRandom: () => number = Math.random;

/** Test seam: make the backoff jitter deterministic. */
export function setRemoteSessionRetryRandom(random: (() => number) | null): void {
  retryRandom = random ?? Math.random;
}

export interface HubRemoteReplyRoute {
  via: "hub";
  hubUrl: string;
  /** One-shot `rsr1.` reply token, verified by the hub only. */
  token: string;
  /** Origin node's name, for the "[Reply from node/room]" label on the caller side. */
  nodeName: string;
  /** Caller's node topic id, as the hub recorded it; informational on this side. */
  topicId: string;
  requestId: string;
}

/**
 * Queue the answer and try to post it right away. Always durable, hence
 * always true. The outbox insert and the removal of the durable ask-callback
 * row (`remote_ask_callbacks`, kept by `resolveAskCallback` for hub routes)
 * are one transaction: at no point is there neither a callback nor an outbox
 * row, so a crash anywhere leaves either the startup "interrupted" error or
 * the real answer to be posted — never silence.
 */
export async function deliverHubRemoteReply(
  route: HubRemoteReplyRoute,
  fromLabel: string,
  replyText: string,
  kind: "reply" | "error",
): Promise<boolean> {
  db.transaction(() => {
    upsertRemoteSessionReplyOutbox({
      requestId: route.requestId,
      hubUrl: route.hubUrl,
      token: route.token,
      kind,
      replyText,
      fromLabel,
    });
    deleteHubRemoteAskCallbackRow(route.requestId);
  })();
  // Network only after commit.
  await flushRemoteSessionReplyOutbox();
  return true;
}

let inFlight: Promise<void> | null = null;

/** Post every due answer once. Concurrent callers share one pass. */
export function flushRemoteSessionReplyOutbox(now: number = Date.now()): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    for (const expired of purgeExpiredRemoteSessionReplyOutbox(now)) {
      logger.warn(
        { requestId: expired.requestId, attempts: expired.attempts, lastError: expired.lastError },
        "session-comm: remote ask reply expired before the hub accepted it",
      );
    }
    for (const entry of listRemoteSessionReplyOutbox({ now })) {
      const result = await hubRemoteReply({
        hubUrl: entry.hubUrl,
        token: entry.token,
        requestId: entry.requestId,
        kind: entry.kind,
        replyText: entry.replyText,
        fromLabel: entry.fromLabel,
      });
      if (result.settled) {
        deleteRemoteSessionReplyOutbox(entry.requestId);
        continue;
      }
      deferRemoteSessionReplyOutbox({
        requestId: entry.requestId,
        error: result.error,
        now,
        random: retryRandom,
      });
      logger.info(
        { requestId: entry.requestId, attempts: entry.attempts + 1, error: result.error },
        "session-comm: remote ask reply deferred",
      );
    }
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * One maintenance pass: flush due answers, forget inbox claims past their
 * 24 h TTL and caller asks past the 15 min pending-ask TTL (and the in-memory
 * ask callbacks past theirs), then re-run inbox deliveries whose lease
 * expired. Returns what was purged, for tests and logs.
 */
export async function runRemoteSessionMaintenance(
  now: number = Date.now(),
): Promise<{ claims: number; asks: number; recovered: number }> {
  await flushRemoteSessionReplyOutbox(now);
  const claims = purgeRemoteSessionInboxClaims(now);
  // Outbound hub asks (row + pending marker): drop the ones the hub never
  // got, release the marker of the ones nobody will learn about (`unknown`).
  const reconciled = reconcileRemoteSessionAsks(now);
  const asks = purgeStaleRemoteSessionAsks(now) + reconciled.removed;
  purgeStaleAsks(now);
  const recovered = await recoverRemoteSessionInbox(now);
  // After the inbox recovery, so a late reply it just delivered wins.
  const noReply = await expireUnknownRemoteSessionAsks(now);
  if (claims || asks || recovered || reconciled.unknown || noReply) {
    logger.info(
      { claims, asks, recovered, unknownAsks: reconciled.unknown, noReplyNotices: noReply },
      "session-comm: remote session maintenance",
    );
  }
  return { claims, asks, recovered };
}

/** Periodic retry + maintenance loop; returns a stop function. */
export function startRemoteSessionReplyOutboxWorker(
  intervalMs: number = REMOTE_SESSION_REPLY_RETRY_MS,
): () => void {
  const timer = setInterval(() => {
    void runRemoteSessionMaintenance().catch((err) => {
      logger.warn({ err }, "session-comm: remote session maintenance pass failed");
    });
  }, intervalMs);
  timer.unref?.();
  void runRemoteSessionMaintenance().catch(() => {});
  return () => clearInterval(timer);
}
