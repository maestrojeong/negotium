/**
 * Room-keyed in-flight query registry + abort-on-new-message priority +
 * inter-session inject queue (requestId dedup + mergeable-prefix merging).
 *
 * ActiveQueries + SessionInjectQueue semantics, adapted to Otium's REST/WS
 * model where the "room" is a `topicId` and the live runner is
 * `api/routes/ai.ts`.
 *
 * Invariant: AT MOST ONE in-flight AI turn per room (topicId). A new turn
 * arriving on a busy room is resolved by origin priority:
 *   - incoming user, running user   → abort running (superseded), replace
 *   - incoming user, running inject → re-queue running inject, abort, replace
 *   - incoming inject (any running) → defer incoming (the user keeps priority)
 */

import type { ForkHandle } from "#agents/fork";
import { logger } from "#platform/logger";
import {
  claimRuntimeTurnLease,
  getRuntimeTurnLease,
  heartbeatRuntimeTurnLease,
  RUNTIME_INSTANCE_ID,
  type RuntimeTurnLease,
  releaseRuntimeTurnLease,
  requestRuntimeTurnAbort,
} from "#storage/runtime-leases";
import type { AskReplySource } from "#storage/session-asks";
import type { AgentKind, PeerRuntimeBridgeContext } from "#types";
import { AbortReason } from "./types";

/** Lazily create an isolated provider session immediately before execution. */
export type PrepareInjectSession = () => Promise<ForkHandle>;

/** A turn started by a session-inject, replayed when its room frees up. */
export interface DeferredInject {
  topicId: string;
  /** Topic execution epoch captured when this work was accepted. */
  runtimeEpoch?: number;
  userId: string;
  prompt: string;
  /** Inject source — the topic name/id this inject came from (never "user"). */
  origin: string;
  /** Inter-session request id for dedup. */
  requestId?: string;
  /** Nesting depth (starts at 1 for the first cross-topic hop). */
  depth?: number;
  /** Whether this inject is silent (injected but hidden from the user). */
  silent?: boolean;
  /** Context chain id for continuing an inter-session conversation. */
  contextId?: string;
  /** Agent override for injected turns that must resume a provider-specific session. */
  agentOverride?: AgentKind;
  /** Model override for specialized internal turns such as cron. */
  modelOverride?: string;
  /** Effort override for specialized internal turns such as cron. */
  effortOverride?: import("#types").EffortLevel;
  /** SDK-native session/thread id to resume for a forked injected turn. */
  sessionId?: string | null;
  /** Explicit provider-session ownership boundary. */
  sessionScope?: "topic" | "isolated";
  /** Rollout file backing a synthetic/native fork; cleaned when the turn finishes. */
  forkHandle?: ForkHandle;
  /** Build a fresh isolated session at dispatch time (used by ask_session). */
  prepareSession?: PrepareInjectSession;
  /** Working directory override for provider-native resumed sessions. */
  cwd?: string;
  /** Conversation/session namespace override (cron jobs keep isolated rollouts). */
  sessionName?: string;
  /** MCP/tool scope override for a specialized internal turn. */
  sessionType?: "dm" | "forum" | "ephemeral" | "manager" | "cron";
  /** Optional session owner; when present the topic's main session is not replaced. */
  onSessionId?: (sessionId: string) => void;
  /** Clear an externally-owned session after an unrecoverable expiry. */
  onSessionReset?: () => void;
  /** Rebuild a provider-native rollout from the shared conversation log when needed. */
  bridgeSessionFromHistory?: boolean;
  /** Final result hook for optional modules that own an internal turn. */
  onSettled?: (result: {
    queryId: string;
    kind: "completed" | "aborted" | "error";
    error?: string;
  }) => void;
  /** Canonical hub identity for a placed-room runtime turn. */
  peerBridge?: PeerRuntimeBridgeContext;
  /** True after a session-expired recovery retry has already been attempted. */
  _sessionRetried?: boolean;
  /** Original ask_session replies represented by this inject, preserved across dequeueAll merges. */
  askReplySources?: AskReplySource[];
  /** Source marker forwarded to startAiTurn (e.g. FROM_AUTO_CONTINUE). */
  from?: string;
  /** Fired with the AI turn's queryId once the deferred turn is dispatched. */
  onDispatched?: (queryId: string) => void;
}

export interface RoomQueryControl {
  topicId: string;
  queryId: string;
  /** "user" for a human message; otherwise the inject source topic name. */
  origin: string;
  /** Prompt currently being processed. User-turn preemption merges this with the new prompt. */
  prompt: string;
  /** Attachment ids currently being processed. User-turn preemption carries them forward. */
  attachments?: string[];
  /** Provider session id this turn resumed from. Superseding user turns restart from this base. */
  sessionId?: string | null;
  abortController: AbortController;
  abortReason: AbortReason;
  /** Epoch ms when this turn claimed the room (stale-abort guard). */
  startedAt?: number;
  /**
   * Set when this turn was started by a session-inject — the params needed to
   * re-enqueue it if a user message preempts it mid-flight. undefined for user
   * turns (a preempted user turn is simply discarded).
   */
  injectParams?: DeferredInject;
}

// ── Room-keyed in-flight registry ──────────────────────────────────────

const activeByRoom = new Map<string, RoomQueryControl>();
const leaseMonitors = new Map<string, ReturnType<typeof setInterval>>();

export function getRoomQuery(topicId: string): RoomQueryControl | undefined {
  return activeByRoom.get(topicId);
}

export function getRoomQueryStatus(topicId: string, queryId: string): "running" | "not_found" {
  if (activeByRoom.get(topicId)?.queryId === queryId) return "running";
  return getRuntimeTurnLease(topicId)?.queryId === queryId ? "running" : "not_found";
}

export function setRoomQuery(control: RoomQueryControl): boolean {
  control.startedAt ??= Date.now();
  const claimed = claimRuntimeTurnLease({
    topicId: control.topicId,
    queryId: control.queryId,
    origin: control.origin,
  });
  if (!claimed) return false;

  const previousMonitor = leaseMonitors.get(control.topicId);
  if (previousMonitor) clearInterval(previousMonitor);
  activeByRoom.set(control.topicId, control);
  const monitor = setInterval(() => {
    const current = activeByRoom.get(control.topicId);
    if (!current || current.queryId !== control.queryId) {
      clearInterval(monitor);
      if (leaseMonitors.get(control.topicId) === monitor) {
        leaseMonitors.delete(control.topicId);
      }
      return;
    }
    const heartbeat = heartbeatRuntimeTurnLease(control.topicId, control.queryId);
    if (!heartbeat.owned) {
      control.abortReason = AbortReason.External;
      control.abortController.abort();
      return;
    }
    if (heartbeat.abortRequested && !control.abortController.signal.aborted) {
      control.abortReason =
        heartbeat.abortReason === "internal" ? AbortReason.Internal : AbortReason.External;
      control.abortController.abort();
    }
  }, 1_000);
  monitor.unref?.();
  leaseMonitors.set(control.topicId, monitor);
  return true;
}

/**
 * Delete the room's in-flight entry, but ONLY if it is still this query — a
 * newer turn may have already replaced it (abort-and-replace), and the dying
 * turn's cleanup must not clobber its successor. Mirrors Otium's
 * "Only delete our own entry" guard.
 */
export function clearRoomQuery(topicId: string, queryId: string): void {
  const cur = activeByRoom.get(topicId);
  if (cur && cur.queryId === queryId) {
    activeByRoom.delete(topicId);
    const monitor = leaseMonitors.get(topicId);
    if (monitor) clearInterval(monitor);
    leaseMonitors.delete(topicId);
  }
  releaseRuntimeTurnLease(topicId, queryId);
}

/** Abort the currently-running turn in a room, if any. Cleanup is still owned by
 *  the streaming turn's finally block so deferred injects drain in order. */
export function abortRoom(topicId: string, reason: AbortReason = AbortReason.External): boolean {
  const running = activeByRoom.get(topicId);
  if (running) {
    running.abortReason = reason;
    running.abortController.abort();
    requestRuntimeTurnAbort(topicId, reason === AbortReason.Internal ? "internal" : "external");
    return true;
  }
  return requestRuntimeTurnAbort(
    topicId,
    reason === AbortReason.Internal ? "internal" : "external",
  );
}

/** Abort every in-flight provider turn before the node tears down its resources. */
export function abortAllRooms(reason: AbortReason = AbortReason.External): number {
  let aborted = 0;
  for (const running of activeByRoom.values()) {
    running.abortReason = reason;
    if (!running.abortController.signal.aborted) {
      running.abortController.abort();
      aborted++;
    }
  }
  return aborted;
}

export function isUserOrigin(origin: string | undefined): boolean {
  return !origin || origin === "user";
}

// ── Priority decision ──────────────────────────────────────────────────

export type NewQueryDecision =
  | { action: "proceed" }
  | { action: "abort-replace"; running: RoomQueryControl }
  | { action: "defer" }
  | { action: "remote-defer"; running: RuntimeTurnLease }
  | { action: "remote-abort-wait"; running: RuntimeTurnLease };

/**
 * Decide what to do when a new turn (with `incomingOrigin`) arrives on a room.
 * Mirrors the abort-on-new-message priority used by live topic turns.
 */
export function decideNewQuery(topicId: string, incomingOrigin: string): NewQueryDecision {
  const running = activeByRoom.get(topicId);
  if (!running) {
    const remote = getRuntimeTurnLease(topicId);
    if (!remote || remote.ownerId === RUNTIME_INSTANCE_ID) return { action: "proceed" };
    return isUserOrigin(incomingOrigin)
      ? { action: "remote-abort-wait", running: remote }
      : { action: "remote-defer", running: remote };
  }
  // Session-injects never preempt — the user keeps priority. Defer it (whether
  // the running turn is a user turn or another inject).
  if (!isUserOrigin(incomingOrigin)) return { action: "defer" };
  // Incoming is a user message → preempt the running turn and take its slot.
  return { action: "abort-replace", running };
}

// ── Session-inject queue (inter-session) ───────────────────────────────
//
// Session-inject queue for cross-topic ask/tell messages.
// Key differences: Otium doesn't have per-user concurrency caps, so the key
// is just the `topicId` (room).
// `markPendingAskSources` is handled by the MCP layer; the queue here only
// manages in-memory defer/replay.

export class InterSessionQueue {
  private queue = new Map<
    string,
    { items: DeferredInject[]; head: number; requestIds: Set<string> }
  >();

  private compactOrDelete(
    topicId: string,
    bucket: { items: DeferredInject[]; head: number; requestIds: Set<string> },
  ): void {
    if (bucket.head >= bucket.items.length) {
      this.queue.delete(topicId);
      return;
    }
    // Keep dequeue O(1) on the hot path; compact only when the reclaimed
    // prefix is large enough to justify copying the remaining references.
    if (bucket.head >= 64 && bucket.head * 2 >= bucket.items.length) {
      bucket.items = bucket.items.slice(bucket.head);
      bucket.head = 0;
    }
  }

  /** Enqueue inject if requestId is set and not a duplicate. Returns true if enqueued. */
  enqueue(topicId: string, inject: DeferredInject): boolean {
    if (!inject.requestId) {
      logger.error(
        { topicId, origin: inject.origin },
        "BUG: session inject reached enqueue without requestId — DROPPING inject",
      );
      return false;
    }
    let bucket = this.queue.get(topicId);
    if (!bucket) {
      bucket = { items: [], head: 0, requestIds: new Set<string>() };
      this.queue.set(topicId, bucket);
    }
    if (bucket.requestIds.has(inject.requestId)) {
      logger.info(
        { topicId, requestId: inject.requestId, origin: inject.origin },
        "session inject deduped (existing entry with same requestId)",
      );
      return false;
    }
    bucket.items.push(inject);
    bucket.requestIds.add(inject.requestId);
    logger.info(
      { topicId, origin: inject.origin, requestId: inject.requestId, depth: inject.depth },
      "session inject enqueued",
    );
    return true;
  }

  /** True when an entry with this requestId is still queued for this topic. */
  hasRequest(topicId: string, requestId: string): boolean {
    return this.queue.get(topicId)?.requestIds.has(requestId) ?? false;
  }

  /** Remove and return the next queued inject for this topic, or undefined if empty. */
  dequeueNext(topicId: string): DeferredInject | undefined {
    const bucket = this.queue.get(topicId);
    if (!bucket || bucket.head >= bucket.items.length) return undefined;
    const next = bucket.items[bucket.head++];
    if (next.requestId) bucket.requestIds.delete(next.requestId);
    this.compactOrDelete(topicId, bucket);
    return next;
  }

  /**
   * Remove and return the longest mergeable PREFIX of the queue as a single
   * entry, or undefined if empty. Multiple prompts are joined so they land in
   * one turn instead of chaining N turns for N queued injects.
   *
   * Merge rule (mirrors Otium): caller-bound ask_session replies can merge
   * even when they came from different target topics; ordinary inter-session
   * injects remain conservative and require the same origin/silent/session
   * shape. `onDispatched` callbacks from each merged entry are composed.
   */
  dequeueAll(topicId: string): DeferredInject | undefined {
    const bucket = this.queue.get(topicId);
    if (!bucket || bucket.head >= bucket.items.length) return undefined;
    const base = bucket.items[bucket.head];
    const isAskReplyInject = (e: DeferredInject) => !e.silent && Boolean(e.askReplySources?.length);
    const baseIsAskReplyInject = isAskReplyInject(base);
    const mergeable = (e: DeferredInject) =>
      (baseIsAskReplyInject
        ? isAskReplyInject(e)
        : !isAskReplyInject(e) &&
          e.origin === base.origin &&
          (e.silent ?? false) === (base.silent ?? false)) &&
      (e.onDispatched !== undefined) === (base.onDispatched !== undefined) &&
      (e.agentOverride ?? null) === (base.agentOverride ?? null) &&
      (e.modelOverride ?? null) === (base.modelOverride ?? null) &&
      (e.effortOverride ?? null) === (base.effortOverride ?? null) &&
      (e.runtimeEpoch ?? 0) === (base.runtimeEpoch ?? 0) &&
      (e.sessionId ?? null) === (base.sessionId ?? null) &&
      (e.forkHandle?.forkId ?? null) === (base.forkHandle?.forkId ?? null) &&
      (e.prepareSession ?? null) === (base.prepareSession ?? null) &&
      (e.cwd ?? null) === (base.cwd ?? null) &&
      (e.sessionName ?? null) === (base.sessionName ?? null) &&
      (e.sessionType ?? null) === (base.sessionType ?? null) &&
      (e.onSessionId ?? null) === (base.onSessionId ?? null) &&
      (e.onSessionReset ?? null) === (base.onSessionReset ?? null) &&
      (e.bridgeSessionFromHistory ?? false) === (base.bridgeSessionFromHistory ?? false) &&
      (e.onSettled ?? null) === (base.onSettled ?? null);
    let end = bucket.head + 1;
    while (end < bucket.items.length && mergeable(bucket.items[end])) end++;
    const batch = bucket.items.slice(bucket.head, end);
    bucket.head = end;
    for (const entry of batch) {
      if (entry.requestId) bucket.requestIds.delete(entry.requestId);
    }
    this.compactOrDelete(topicId, bucket);
    if (batch.length === 1) return batch[0];

    const callbacks = batch
      .map((e) => e.onDispatched)
      .filter((cb): cb is NonNullable<typeof cb> => !!cb);
    const askReplySources = batch.flatMap((e): AskReplySource[] => {
      if (e.askReplySources?.length) return e.askReplySources;
      if (!e.requestId || !e.origin) return [];
      return [{ from: e.origin, requestId: e.requestId, contextId: e.contextId }];
    });
    const depths = batch
      .map((e) => e.depth)
      .filter((depth): depth is number => typeof depth === "number");
    return {
      ...base,
      prompt: batch.map((e) => e.prompt).join("\n\n"),
      origin: baseIsAskReplyInject
        ? [...new Set(batch.map((e) => e.origin).filter(Boolean))].join(", ")
        : base.origin,
      depth: depths.length ? Math.min(...depths) : base.depth,
      requestId: `merged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Same-origin batches share one context; only drop it when the batch
      // disagrees (a merged turn must not append to the wrong context).
      contextId: batch.every((e) => e.contextId === base.contextId) ? base.contextId : undefined,
      askReplySources,
      onDispatched: callbacks.length
        ? (queryId: string) => {
            callbacks.forEach((cb) => {
              cb(queryId);
            });
          }
        : undefined,
    };
  }

  /** All non-empty queue keys for this topic room. */
  keysForRoom(): string[] {
    return Array.from(this.queue.keys());
  }

  /** Drop all queued injects for a topic (e.g. after room abort). */
  drop(topicId: string): void {
    this.queue.delete(topicId);
  }

  /** Number of queued injects for a topic. */
  size(topicId: string): number {
    const bucket = this.queue.get(topicId);
    return bucket ? bucket.items.length - bucket.head : 0;
  }

  /** Remove one queued inject by request id. Used by bounded background queues. */
  remove(topicId: string, requestId: string): DeferredInject | undefined {
    const bucket = this.queue.get(topicId);
    if (!bucket?.requestIds.has(requestId)) return undefined;
    const index = bucket.items.findIndex(
      (entry, entryIndex) => entryIndex >= bucket.head && entry.requestId === requestId,
    );
    if (index < 0) return undefined;
    const [removed] = bucket.items.splice(index, 1);
    bucket.requestIds.delete(requestId);
    this.compactOrDelete(topicId, bucket);
    return removed;
  }
}

export interface DeferredInjectBatcherOptions {
  queue: InterSessionQueue;
  delayMs: number;
  isBusy: (topicId: string) => boolean;
  dispatch: (inject: DeferredInject) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
}

/**
 * Gives caller-bound ask replies a short window to collect before dispatch.
 * `dequeueAll()` only merges entries that are already queued, so the first
 * reply must pass through this gate too when its caller room is idle.
 */
export class DeferredInjectBatcher {
  private readonly timers = new Map<string, unknown>();
  private readonly scheduleTimer: (callback: () => void, delayMs: number) => unknown;

  constructor(private readonly options: DeferredInjectBatcherOptions) {
    this.scheduleTimer = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  }

  enqueue(inject: DeferredInject): boolean {
    const queued = this.options.queue.enqueue(inject.topicId, inject);
    if (!queued) return false;
    if (this.timers.has(inject.topicId)) return true;

    const timer = this.scheduleTimer(() => {
      this.timers.delete(inject.topicId);
      // A busy room owns the drain in its turn-finally path. Leaving the
      // entries queued avoids a second dispatcher racing that owner.
      if (this.options.isBusy(inject.topicId)) return;
      const batch = this.options.queue.dequeueAll(inject.topicId);
      if (batch) this.options.dispatch(batch);
    }, this.options.delayMs);
    this.timers.set(inject.topicId, timer);
    return true;
  }

  isScheduled(topicId: string): boolean {
    return this.timers.has(topicId);
  }
}

export const interSessionQueue = new InterSessionQueue();

// ── Defer / drain helpers (thin wrappers around InterSessionQueue) ────

/**
 * Enqueue a deferred inject. With the full queue, this also deduplicates by
 * requestId.
 */
export function deferInject(inject: DeferredInject): boolean {
  return interSessionQueue.enqueue(inject.topicId, inject);
}

/**
 * Remove and return the longest mergeable batch of deferred injects for a room,
 * or undefined if empty.
 */
export function takeDeferredInject(topicId: string): DeferredInject | undefined {
  return interSessionQueue.dequeueAll(topicId);
}

/** Cancel one deferred inject before it claims the room. */
export function cancelDeferredInject(topicId: string, requestId: string): boolean {
  return interSessionQueue.remove(topicId, requestId) !== undefined;
}

// ── WS discriminator ───────────────────────────────────────────────────

/** Map the internal AbortReason → the WS `ai_aborted` discriminator. */
export function wsAbortReason(reason: AbortReason): "superseded" | "stopped" {
  return reason === AbortReason.Internal ? "superseded" : "stopped";
}
