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
import { mintPeerToken, type PeerNode, resolvePeerNodeByCellId } from "@/central";
import { PEER_PROTOCOL_VERSION } from "@/protocol";
import { acknowledgePeerTerminal, listPeerTerminalOutbox, upsertPeerTerminalOutbox } from "@/store";

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
const PEER_EVENT_MAX_PENDING = 256;

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
      deleted: payload.patch.deleted,
      editedAt: payload.patch.editedAt,
      usage: payload.patch.usage,
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
  /** Number of closures retained by the ordered promise queue. */
  pendingEvents: number;
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
  /** Test/host seam. One slot is reserved for a synthetic overflow terminal. */
  maxPendingEvents?: number;
}): TurnForwarder {
  const { hostNodeId, requestId, localTopicId, sendEvent } = opts;
  const retryBaseMs = opts.retryBaseMs ?? PEER_EVENT_RETRY_BASE_MS;
  const maxPendingEvents = Math.max(2, opts.maxPendingEvents ?? PEER_EVENT_MAX_PENDING);
  const forwarder: TurnForwarder = {
    requestId,
    queryId: null,
    finished: false,
    deliveryBlocked: false,
    pendingEvents: 0,
    seq: 0,
    chain: Promise.resolve(),
    tap: () => {},
    finish: () => {},
  };

  let terminalQueued = false;

  const detach = () => {
    forwarder.finished = true;
    if (activeForwarders.get(localTopicId) === forwarder) {
      activeForwarders.delete(localTopicId);
    }
  };

  const post = (event: RawEvent) => {
    const isTerminal = TERMINAL_TYPES.has(String(event.type ?? ""));
    if (isTerminal) terminalQueued = true;
    forwarder.seq += 1;
    const seq = forwarder.seq;
    forwarder.pendingEvents += 1;
    forwarder.chain = forwarder.chain.then(async () => {
      try {
        if (forwarder.deliveryBlocked) return;
        // Prior seqs are now acknowledged. Persist immediately before the
        // first terminal send, closing the crash window without retaining a
        // terminal that can never cross an earlier permanent gap.
        if (isTerminal) {
          upsertPeerTerminalOutbox({ hostNodeId, requestId, seq, event });
        }
        for (let attempt = 1; attempt <= PEER_EVENT_MAX_ATTEMPTS; attempt++) {
          const result = await sendEvent({ v: PEER_PROTOCOL_VERSION, requestId, seq, event });
          if (result.ok) {
            if (isTerminal) acknowledgePeerTerminal(hostNodeId, requestId);
            return;
          }
          logger.warn(
            { requestId, seq, type: event.type, attempt, error: result.error },
            "otium: peer event delivery to hub failed",
          );
          if (attempt < PEER_EVENT_MAX_ATTEMPTS) {
            const delayMs = retryBaseMs * 2 ** (attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
        // Never send seq N+1 after seq N was lost. A terminal stays in the
        // durable outbox and the reconnect flusher retries its exact envelope.
        forwarder.deliveryBlocked = true;
        logger.error({ requestId, seq, type: event.type }, "otium: peer event delivery exhausted");
      } finally {
        forwarder.pendingEvents -= 1;
      }
    });
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
    const isTerminal = TERMINAL_TYPES.has(type);
    if (!isTerminal && forwarder.pendingEvents >= maxPendingEvents - 1) {
      // Do not retain an unbounded Promise chain under a noisy tool stream.
      // Since no seq was assigned to this dropped event, a synthetic terminal
      // remains contiguous and occupies the queue's reserved final slot.
      if (!terminalQueued) {
        post({
          type: "ai_error",
          topicId: localTopicId,
          queryId: forwarder.queryId ?? requestId,
          error: `worker event queue saturated (${maxPendingEvents})`,
        });
        detach();
      }
      return;
    }
    post(raw);
    if (isTerminal) detach();
  };

  forwarder.finish = (event: RawEvent) => {
    if (forwarder.finished) return;
    post(event);
    detach();
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
let terminalOutboxTimer: ReturnType<typeof setInterval> | null = null;
let terminalOutboxFlushInFlight = false;

/** Retry exact terminal envelopes left by a lost ACK or worker restart. */
export async function flushPeerTerminalOutbox(): Promise<number> {
  if (terminalOutboxFlushInFlight) return 0;
  terminalOutboxFlushInFlight = true;
  let acknowledged = 0;
  try {
    for (const row of listPeerTerminalOutbox()) {
      const node = await resolvePeerNodeByCellId(row.host_node_id).catch(() => null);
      if (!node) continue;
      let event: RawEvent;
      try {
        event = JSON.parse(row.event_json) as RawEvent;
      } catch {
        continue;
      }
      const result = await hubEventSender(node)({
        v: PEER_PROTOCOL_VERSION,
        requestId: row.request_id,
        seq: row.seq,
        event,
      });
      if (result.ok && acknowledgePeerTerminal(row.host_node_id, row.request_id)) acknowledged += 1;
    }
    return acknowledged;
  } finally {
    terminalOutboxFlushInFlight = false;
  }
}

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
  if (!terminalOutboxTimer) {
    void flushPeerTerminalOutbox();
    terminalOutboxTimer = setInterval(() => void flushPeerTerminalOutbox(), 5_000);
    terminalOutboxTimer.unref?.();
  }
  return stopEventBackflow;
}

export function stopEventBackflow(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (terminalOutboxTimer) clearInterval(terminalOutboxTimer);
  terminalOutboxTimer = null;
  activeForwarders.clear();
}
