/**
 * Wake signal for the session-inbox worker.
 *
 * `enqueueSessionInbox` writes to SQLite only. Nothing about that write is
 * visible to the leader's `fs.watch` on the legacy JSONL directory, so before
 * this module the *only* thing that ever noticed a new local `tell_session` /
 * `ask_session` was the fallback poll — which made delivery latency equal to
 * the poll interval, and made a broken poll equal to no delivery at all.
 *
 * Two delivery paths, both best-effort (the fallback poll stays the backstop):
 *
 *  - In-process: the elected leader subscribes, so an enqueue in the same
 *    process (the embedded MCP endpoint, adapters, the runtime itself) reaches
 *    it with no syscall and no polling delay.
 *  - Cross-process: with no local subscriber this process is not the leader, so
 *    touch a sentinel file inside the watched inbox directory. The leader's
 *    existing `fs.watch` turns that into a trigger.
 *
 * Notification is deferred by one macrotask so that an enqueue wrapped in a
 * wider synchronous SQLite transaction is committed before the leader looks.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_INBOX_DIR } from "#platform/config";
import { logger } from "#platform/logger";

/**
 * Sentinel touched to wake a leader in another process. Safe to leave in the
 * inbox root: both inbox scans only descend into per-user *directories* and
 * skip entries they cannot `readdir`.
 */
export const SESSION_INBOX_WAKE_FILE = join(SESSION_INBOX_DIR, ".wake");

const listeners = new Set<() => void>();
let scheduled: ReturnType<typeof setTimeout> | null = null;

/** Register a local wake listener. Returns an idempotent unsubscribe. */
export function subscribeSessionInboxWrite(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function deliver(): void {
  if (listeners.size > 0) {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        logger.warn({ err }, "session-inbox: wake listener failed");
      }
    }
    return;
  }
  try {
    mkdirSync(SESSION_INBOX_DIR, { recursive: true });
    writeFileSync(SESSION_INBOX_WAKE_FILE, `${Date.now()}\n`);
  } catch (err) {
    logger.debug({ err }, "session-inbox: could not touch the wake sentinel");
  }
}

/**
 * Announce that a row was added to `session_inbox`. Coalesced: a notification
 * already scheduled covers every write until it fires, and — like the runner it
 * feeds — an existing timer is never pushed back.
 */
export function notifySessionInboxWrite(): void {
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    deliver();
  }, 0);
}
