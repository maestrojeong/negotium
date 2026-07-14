/**
 * RuntimeBus — the outbound half of the host boundary.
 *
 * The runtime publishes topic-scoped events here; whatever host embeds the
 * runtime (CLI, Telegram bot, otium worker node, web API) subscribes and
 * renders them on its channel. This replaces otium's WsHub with a
 * channel-agnostic seam: negotium core never knows what a "websocket" or a
 * "chat" is.
 *
 * A default in-process bus is installed so the runtime works headless (events
 * are still observable via `subscribe`). Hosts may either subscribe to the
 * default bus or install their own implementation with `setRuntimeBus`.
 */

import type { ToolCallSummaryInput } from "#agents/tool-format";
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
    usage?: { input: number; output: number },
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

class InProcessBus implements RuntimeBus {
  private listeners = new Set<RuntimeBusListener>();

  private emit(event: RuntimeBusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the runtime.
      }
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
    usage?: { input: number; output: number },
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
    return () => this.listeners.delete(listener);
  }
}

let current: RuntimeBus = new InProcessBus();

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
