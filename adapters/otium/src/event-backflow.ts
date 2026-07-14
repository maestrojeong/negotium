/**
 * Event backflow — worker → hub. Reconstructs otium's WsHub feed from
 * negotium's RuntimeBus (`bus.ts` publishes `ai-status` payloads with a
 * `kind` discriminator mirroring the WS `type` names precisely for this) and
 * forwards one placed turn's events to the hub as
 * `POST /api/v1/peer/event {v, requestId, seq, event}`.
 *
 * Contract (docs/OTIUM-COUPLING.md §1.4/§2.2, otium turn-runner.ts):
 *  - seq starts at 1 per requestId and MUST be contiguous; sends are chained
 *    (next POST only after the previous settled).
 *  - delivery failure retries ≤ 5 times with 100ms-base exponential backoff;
 *    once exhausted the forwarder hard-blocks — later seqs are NEVER sent
 *    (losing seq N and sending N+1 is the one forbidden move). The hub's
 *    30-minute watchdog fails the turn.
 *  - exactly one terminal event (ai_done | ai_error | ai_aborted) per
 *    requestId; a superseding turn emits a synthetic
 *    `ai_aborted(reason:"superseded")` for its predecessor via `finish()`.
 */

import { logger, type RuntimeBusEvent, runtimeBus } from "@negotium/core";
import { mintPeerToken, type PeerNode } from "@/central";
import { PEER_PROTOCOL_VERSION } from "@/protocol";
import { markPeerTurnRequestFinished } from "@/store";

const FORWARDED_TYPES = new Set([
  "message",
  "message_updated",
  "typing",
  "tool_call",
  "tool_output",
  "tool_status",
  "visual",
  "file_ready",
  "ai_done",
  "ai_error",
  "ai_aborted",
]);

const TERMINAL_TYPES = new Set(["ai_done", "ai_error", "ai_aborted"]);
const PEER_EVENT_MAX_ATTEMPTS = 5;
const PEER_EVENT_RETRY_BASE_MS = 100;
const PEER_EVENT_TIMEOUT_MS = 15_000;

export type SendEventResult = { ok: true } | { ok: false; error: string; status?: number };

export type SendPeerEvent = (payload: {
  v: number;
  requestId: string;
  seq: number;
  event: Record<string, unknown>;
}) => Promise<SendEventResult>;

/** Production event sender — peer-token POST to the hub's event endpoint. */
export function hubEventSender(hubNode: PeerNode): SendPeerEvent {
  return async (payload) => {
    let token: string;
    try {
      token = await mintPeerToken(hubNode.cellId);
    } catch (err) {
      return { ok: false, error: `peer token mint failed: ${(err as Error).message}` };
    }
    let response: Response;
    try {
      response = await fetch(`${hubNode.baseUrl.replace(/\/+$/, "")}/api/v1/peer/event`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PEER_EVENT_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, error: `hub "${hubNode.nodeName ?? hubNode.cellId}" unreachable` };
    }
    const parsed = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (!response.ok || !parsed?.ok) {
      return {
        ok: false,
        error: parsed?.error ?? `peer event rejected (${response.status})`,
        status: response.status,
      };
    }
    return { ok: true };
  };
}

// ── Bus → WsServerMessage translation ────────────────────────────────

type RawEvent = Record<string, unknown>;

function defined(record: RawEvent): RawEvent {
  const out: RawEvent = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Translate one RuntimeBus event into the otium `WsServerMessage`-shaped raw
 * object the hub applies verbatim (field names matter — the hub does no
 * schema validation). Returns null for events the worker must not forward.
 */
export function translateBusEvent(event: RuntimeBusEvent): RawEvent | null {
  const topicId = event.topicId;
  if (event.type === "message") {
    return { type: "message", topicId, message: event.payload };
  }
  if (event.type === "message-updated") {
    const payload = event.payload as { messageId: string; patch: Record<string, unknown> };
    return defined({
      type: "message_updated",
      topicId,
      messageId: payload.messageId,
      text: payload.patch.text,
      editedAt: payload.patch.editedAt,
    });
  }
  if (event.type !== "ai-status") return null;
  const status = event.payload as RawEvent;
  const kind = typeof status.kind === "string" ? status.kind : "";
  switch (kind) {
    case "typing":
      return { type: "typing", topicId, userId: status.userId ?? "" };
    case "tool_call":
      return defined({
        type: "tool_call",
        topicId,
        queryId: status.queryId,
        name: status.name,
        input: status.input,
        label: status.label,
        toolUseId: status.toolUseId,
      });
    case "tool_output":
      return defined({
        type: "tool_output",
        topicId,
        queryId: status.queryId,
        toolUseId: status.toolUseId,
        content: status.content,
      });
    case "tool_status":
      // bus.ts stores the WS `kind` field as `statusKind` (the outer `kind`
      // slot carries the event discriminator).
      return defined({
        type: "tool_status",
        topicId,
        queryId: status.queryId,
        kind: status.statusKind,
        content: status.content,
        toolName: status.toolName,
        elapsed: status.elapsed,
      });
    case "file_ready":
      return defined({
        type: "file_ready",
        topicId,
        queryId: status.queryId,
        path: status.path,
        source: status.source,
      });
    case "visual":
      return defined({
        type: "visual",
        topicId,
        queryId: status.queryId,
        url: status.url,
        id: status.id,
        title: status.title,
        kind: status.visualKind,
      });
    case "ai_done":
      return defined({
        type: "ai_done",
        topicId,
        queryId: status.queryId,
        usage: status.usage,
        agent: status.agent,
        model: status.model,
      });
    case "ai_error":
      return defined({
        type: "ai_error",
        topicId,
        queryId: status.queryId,
        error: status.error,
      });
    case "ai_aborted":
      return defined({
        type: "ai_aborted",
        topicId,
        queryId: status.queryId,
        reason: status.reason,
      });
    default:
      // ai_active and anything future-shaped is not in FORWARDED_TYPES.
      return null;
  }
}

// ── Per-turn forwarder ───────────────────────────────────────────────

export interface TurnForwarder {
  requestId: string;
  /** Local queryId of the running turn; events from other turns are dropped. */
  queryId: string | null;
  finished: boolean;
  deliveryBlocked: boolean;
  seq: number;
  chain: Promise<void>;
  /** Feed one already-translated raw event through filter → seq → delivery. */
  tap: (raw: RawEvent) => void;
  /** Send a synthetic terminal (superseded / dispatch failure) and clean up. */
  finish: (event: RawEvent) => void;
}

/** localTopicId → the forwarder of its in-flight peer turn. */
const activeForwarders = new Map<string, TurnForwarder>();

export function getActiveForwarder(localTopicId: string): TurnForwarder | undefined {
  return activeForwarders.get(localTopicId);
}

export function createTurnForwarder(opts: {
  hostNodeId: string;
  requestId: string;
  localTopicId: string;
  sendEvent: SendPeerEvent;
  /** Test seam — production keeps the contract's 100ms base backoff. */
  retryBaseMs?: number;
}): TurnForwarder {
  const { hostNodeId, requestId, localTopicId, sendEvent } = opts;
  const retryBaseMs = opts.retryBaseMs ?? PEER_EVENT_RETRY_BASE_MS;
  const forwarder: TurnForwarder = {
    requestId,
    queryId: null,
    finished: false,
    deliveryBlocked: false,
    seq: 0,
    chain: Promise.resolve(),
    tap: () => {},
    finish: () => {},
  };

  const post = (event: RawEvent) => {
    forwarder.seq += 1;
    const seq = forwarder.seq;
    forwarder.chain = forwarder.chain.then(async () => {
      if (forwarder.deliveryBlocked) return;
      for (let attempt = 1; attempt <= PEER_EVENT_MAX_ATTEMPTS; attempt++) {
        const result = await sendEvent({ v: PEER_PROTOCOL_VERSION, requestId, seq, event });
        if (result.ok) return;
        logger.warn(
          { requestId, seq, type: event.type, attempt, error: result.error },
          "otium: peer event delivery to hub failed",
        );
        if (attempt < PEER_EVENT_MAX_ATTEMPTS) {
          const delayMs = retryBaseMs * 2 ** (attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      // Never send seq N+1 after seq N was lost. The hub requires a
      // contiguous cursor; its watchdog fails the turn if connectivity does
      // not recover within this bounded retry budget.
      forwarder.deliveryBlocked = true;
      logger.error({ requestId, seq, type: event.type }, "otium: peer event delivery exhausted");
    });
  };

  const cleanup = () => {
    forwarder.finished = true;
    markPeerTurnRequestFinished(hostNodeId, requestId);
    if (activeForwarders.get(localTopicId) === forwarder) {
      activeForwarders.delete(localTopicId);
    }
  };

  forwarder.tap = (raw: RawEvent) => {
    if (forwarder.finished) return;
    const type = String(raw.type ?? "");
    if (!FORWARDED_TYPES.has(type)) return;
    // Attribute only this turn's events: overlapping aborted events from a
    // preempted previous turn carry a different queryId and were already
    // settled by that turn's synthetic terminal.
    if (type === "message") {
      const message = raw.message as { queryId?: string; authorId?: string } | undefined;
      if (
        message?.authorId === "ai" &&
        forwarder.queryId &&
        message.queryId !== forwarder.queryId
      ) {
        return;
      }
    } else if (type !== "typing") {
      const queryId = raw.queryId;
      if (forwarder.queryId && typeof queryId === "string" && queryId !== forwarder.queryId) {
        return;
      }
    }
    post(raw);
    if (TERMINAL_TYPES.has(type)) cleanup();
  };

  forwarder.finish = (event: RawEvent) => {
    if (forwarder.finished) return;
    post(event);
    cleanup();
  };

  return forwarder;
}

/** Register the turn's forwarder as the topic's WsHub-tap equivalent. */
export function registerTurnForwarder(localTopicId: string, forwarder: TurnForwarder): void {
  activeForwarders.set(localTopicId, forwarder);
  ensureBackflowSubscription();
}

// ── Global bus subscription (otium's registerTopicTap equivalent) ────

let unsubscribe: (() => void) | null = null;

function onBusEvent(event: RuntimeBusEvent): void {
  const forwarder = activeForwarders.get(event.topicId);
  if (!forwarder) return;
  const raw = translateBusEvent(event);
  if (raw) forwarder.tap(raw);
}

function ensureBackflowSubscription(): void {
  if (!unsubscribe) unsubscribe = runtimeBus().subscribe(onBusEvent);
}

/** Subscribe the backflow tap to the RuntimeBus. Returns a stop function. */
export function startEventBackflow(): () => void {
  ensureBackflowSubscription();
  return stopEventBackflow;
}

export function stopEventBackflow(): void {
  unsubscribe?.();
  unsubscribe = null;
  activeForwarders.clear();
}
