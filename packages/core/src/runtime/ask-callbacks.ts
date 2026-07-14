/**
 * Ask callback registry (requestId → caller topic + cleanup).
 *
 * ask_session registers a callback here after the target AI turn is
 * dispatched; when the target AI completes, the turn runner resolves it and
 * routes the result back to the caller topic automatically.
 *
 * Ported from the in-memory registry half of otium's `api/routes/sessions.ts`
 * (the ask/tell REST routes stayed in the host).
 */

import { PENDING_ASK_TTL_MS, type PendingAskUserId } from "#storage/session-asks";

interface PendingAskIdentity {
  userId: PendingAskUserId;
  from: string;
  to: string;
  requestId?: string;
}

export interface AskPending {
  requestId: string;
  contextId?: string;
  callerTopicId: string;
  callerUserId: string;
  targetQueryId: string;
  createdAt: number;
  timedOut?: boolean; // set when resolved past TTL — caller gets timeout notice
  pendingAsk?: PendingAskIdentity;
}

/** In-memory callback registry. Survives restarts? No — JSONL backup is a
 *  future enhancement.  Process crashes lose pending asks (acceptable for MVP:
 *  the caller will time out and can retry). */
const pendingAsks = new Map<string, AskPending>(); // keyed by targetQueryId (the AI turn's queryId)
const MAX_ASK_AGE_MS = PENDING_ASK_TTL_MS;

/** Register an ask callback. Called after the target AI turn is dispatched. */
export function registerAskCallback(entry: AskPending): void {
  pendingAsks.set(entry.targetQueryId, entry);
}

/** Resolve an ask callback after the target AI finishes.
 *  Called from the turn runner when the agent stream ends — matches by the AI
 *  turn's queryId. Returns the AskPending or null if not found.
 *  Past TTL: returns entry with timedOut=true (caller gets timeout notice). */
export function resolveAskCallback(queryId: string): AskPending | null {
  const entry = pendingAsks.get(queryId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > MAX_ASK_AGE_MS) {
    entry.timedOut = true;
  }
  pendingAsks.delete(queryId);
  return entry;
}

/** Clean up stale asks that outlived their TTL (periodic, lightweight). */
export function purgeStaleAsks(now: number = Date.now()): void {
  for (const [id, entry] of pendingAsks) {
    if (now - entry.createdAt > MAX_ASK_AGE_MS) pendingAsks.delete(id);
  }
}
