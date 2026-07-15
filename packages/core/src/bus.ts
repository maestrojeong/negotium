/**
 * RuntimeBus — the outbound half of the host boundary.
 *
 * The runtime publishes topic-scoped events here; whatever host embeds the
 * runtime (CLI, Telegram bot, otium worker node, web API) subscribes and
 * renders them on its channel. This replaces otium's WsHub with a
 * channel-agnostic seam: negotium core never knows what a "websocket" or a
 * "chat" is.
 *
 * The default bus is backed by the shared SQLite store. Every process writes
 * events to one monotonic log and tails events written by its peers, while
 * still delivering its own events synchronously. Hosts may replace it with
 * `setRuntimeBus` in tests or specialized embeddings.
 */

import { randomUUID } from "node:crypto";
import type { ToolCallSummaryInput } from "#agents/tool-format";
import {
  appendRuntimeEvent,
  latestRuntimeEventSeq,
  listRuntimeEventsAfter,
} from "#storage/runtime-events";
import type { AgentKind } from "#types";
import type { MessageDto } from "#types/api";

export interface RuntimeBusEvent {
  type:
    | "message" // new message persisted in a topic
    | "message-updated" // existing message patched (edit-in-place progress)
    | "ai-status" // turn started/streaming/finished/aborted
    | "topic-created"
    | "topic-updated" // topic config/title changed
    | "topic-deleted";
  topicId: string;
  payload: unknown;
  /** Durable event-log ordering metadata when available. */
  seq?: number;
  createdAt?: string;
}

export type RuntimeBusListener = (event: RuntimeBusEvent) => void;

export interface RuntimeBus {
  broadcastMessage(topicId: string, message: MessageDto): void;
  broadcastMessageUpdated(
    topicId: string,
    messageId: string,
    patch: Partial<MessageDto> & Record<string, unknown>,
  ): void;
  broadcastAiStatus(topicId: string, status: Record<string, unknown>): void;
  broadcastTopicCreated(topic: { id: string }): void;
  broadcastTopicUpdated(topicId: string): void;
  broadcastTopicDeleted(topicId: string): void;
  // ── AI turn lifecycle (otium WsHub-compatible surface used by the turn runner) ──
  /** Announce a just-started AI turn so every subscriber learns its queryId. */
  broadcastAiActive(topicId: string, queryId: string): void;
  broadcastDone(
    topicId: string,
    queryId: string,
    usage?: NonNullable<MessageDto["usage"]>,
    meta?: { agent?: AgentKind; model?: string },
  ): void;
  broadcastError(topicId: string, queryId: string, error: string): void;
  broadcastAborted(topicId: string, queryId: string, reason?: "superseded" | "stopped"): void;
  broadcastToolCall(
    topicId: string,
    queryId: string,
    name: string,
    input: ToolCallSummaryInput | undefined,
    label: string,
    toolUseId: string,
  ): void;
  broadcastToolOutput(topicId: string, queryId: string, toolUseId: string, content: string): void;
  broadcastToolStatus(
    topicId: string,
    queryId: string,
    kind: "status" | "progress" | "summary",
    content: string,
    meta?: { toolName?: string; elapsed?: number },
  ): void;
  broadcastFileReady(topicId: string, queryId: string, path: string, source: string): void;
  broadcastVisual(
    topicId: string,
    queryId: string,
    url: string,
    id?: number,
    title?: string | null,
    kind?: "html" | "mermaid" | "image" | "video",
  ): void;
  /** Typing indicator: userId is the typist ("ai") or "" to clear. */
  broadcastTyping(topicId: string, userId: string): void;
  subscribe(listener: RuntimeBusListener): () => void;
}

export interface SqliteRuntimeBusOptions {
  sourceId?: string;
  pollIntervalMs?: number;
}

export class SqliteRuntimeBus implements RuntimeBus {
  private listeners = new Set<RuntimeBusListener>();
  private readonly sourceId: string;
  private readonly pollIntervalMs: number;
  private cursor: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(options: SqliteRuntimeBusOptions = {}) {
    this.sourceId = options.sourceId ?? `${process.pid}-${randomUUID()}`;
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 100);
    this.cursor = latestRuntimeEventSeq();
  }

  private deliver(event: RuntimeBusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the runtime.
      }
    }
  }

  private emit(event: RuntimeBusEvent): void {
    // Do not jump the read cursor to our insert's seq. Another process may
    // have committed an event immediately before this insert that we have not
    // tailed yet. The poller advances through every seq in order and skips our
    // own rows after the synchronous delivery below.
    const stored = appendRuntimeEvent(this.sourceId, event);
    this.deliver({ ...event, seq: stored.seq, createdAt: stored.createdAt });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.pollTimer.unref?.();
    this.poll();
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private poll(): void {
    if (this.polling || this.listeners.size === 0) return;
    this.polling = true;
    try {
      while (true) {
        const events = listRuntimeEventsAfter(this.cursor);
        if (events.length === 0) break;
        for (const event of events) {
          this.cursor = Math.max(this.cursor, event.seq);
          if (event.sourceId === this.sourceId) continue;
          this.deliver({
            type: event.type,
            topicId: event.topicId,
            payload: event.payload,
            seq: event.seq,
            createdAt: event.createdAt,
          });
        }
        if (events.length < 500) break;
      }
    } finally {
      this.polling = false;
    }
  }

  broadcastMessage(topicId: string, message: MessageDto): void {
    this.emit({ type: "message", topicId, payload: message });
  }

  broadcastMessageUpdated(
    topicId: string,
    messageId: string,
    patch: Partial<MessageDto> & Record<string, unknown>,
  ): void {
    this.emit({ type: "message-updated", topicId, payload: { messageId, patch } });
  }

  broadcastAiStatus(topicId: string, status: Record<string, unknown>): void {
    this.emit({ type: "ai-status", topicId, payload: status });
  }

  broadcastTopicCreated(topic: { id: string }): void {
    this.emit({ type: "topic-created", topicId: topic.id, payload: topic });
  }

  broadcastTopicUpdated(topicId: string): void {
    this.emit({ type: "topic-updated", topicId, payload: null });
  }

  broadcastTopicDeleted(topicId: string): void {
    this.emit({ type: "topic-deleted", topicId, payload: null });
  }

  // The turn-lifecycle methods all flow through the "ai-status" channel with a
  // `kind` discriminator mirroring otium's WS message `type` names, so a host
  // can reconstruct the exact WsHub feed from the bus if it wants to.
  broadcastAiActive(topicId: string, queryId: string): void {
    this.broadcastAiStatus(topicId, { kind: "ai_active", queryId });
  }

  broadcastDone(
    topicId: string,
    queryId: string,
    usage?: NonNullable<MessageDto["usage"]>,
    meta?: { agent?: AgentKind; model?: string },
  ): void {
    this.broadcastAiStatus(topicId, {
      kind: "ai_done",
      queryId,
      usage,
      agent: meta?.agent,
      model: meta?.model,
    });
  }

  broadcastError(topicId: string, queryId: string, error: string): void {
    this.broadcastAiStatus(topicId, { kind: "ai_error", queryId, error });
  }

  broadcastAborted(topicId: string, queryId: string, reason?: "superseded" | "stopped"): void {
    this.broadcastAiStatus(topicId, { kind: "ai_aborted", queryId, reason });
  }

  broadcastToolCall(
    topicId: string,
    queryId: string,
    name: string,
    input: ToolCallSummaryInput | undefined,
    label: string,
    toolUseId: string,
  ): void {
    const id = toolUseId.trim() || `${queryId}:tool`;
    this.broadcastAiStatus(topicId, {
      kind: "tool_call",
      queryId,
      name,
      input,
      label,
      toolUseId: id,
    });
  }

  broadcastToolOutput(topicId: string, queryId: string, toolUseId: string, content: string): void {
    const id = toolUseId.trim() || `${queryId}:tool`;
    this.broadcastAiStatus(topicId, { kind: "tool_output", queryId, toolUseId: id, content });
  }

  broadcastToolStatus(
    topicId: string,
    queryId: string,
    kind: "status" | "progress" | "summary",
    content: string,
    meta?: { toolName?: string; elapsed?: number },
  ): void {
    this.broadcastAiStatus(topicId, {
      kind: "tool_status",
      queryId,
      statusKind: kind,
      content,
      toolName: meta?.toolName,
      elapsed: meta?.elapsed,
    });
  }

  broadcastFileReady(topicId: string, queryId: string, path: string, source: string): void {
    this.broadcastAiStatus(topicId, { kind: "file_ready", queryId, path, source });
  }

  broadcastVisual(
    topicId: string,
    queryId: string,
    url: string,
    id?: number,
    title?: string | null,
    kind?: "html" | "mermaid" | "image" | "video",
  ): void {
    this.broadcastAiStatus(topicId, { kind: "visual", queryId, url, id, title, visualKind: kind });
  }

  broadcastTyping(topicId: string, userId: string): void {
    this.broadcastAiStatus(topicId, { kind: "typing", userId });
  }

  subscribe(listener: RuntimeBusListener): () => void {
    this.listeners.add(listener);
    this.startPolling();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }
}

let current: RuntimeBus = new SqliteRuntimeBus();

export function runtimeBus(): RuntimeBus {
  return current;
}

export function setRuntimeBus(bus: RuntimeBus): void {
  current = bus;
}

/** Drop-in compat for code ported from otium's `WsHub.get()` call sites. */
export const WsHub = {
  get(): RuntimeBus {
    return current;
  },
};
