import { randomUUID } from "node:crypto";
import {
  type AgentKind,
  abortRoom,
  answerPendingAskUserQuestion,
  appendApiMessage,
  compactTopicSession,
  deleteTopicCascade,
  ensurePersonalGeneral,
  getAllMessagesForTopic,
  getApiMessage,
  getVisibleTopics,
  listApiMessages,
  listRecentRuntimeEventsForTopic,
  type MessageDto,
  type RuntimeBusEvent,
  registerTopic,
  restartTopicSession,
  runtimeBus,
  startAiTurn,
  type TopicDto,
} from "@negotium/core";
import {
  NODE_CONTROL_BASE_PATH,
  NODE_CONTROL_PROTOCOL_VERSION,
  type NodeDaemonConnection,
  type NodeHandle,
  startDefaultNode,
} from "@negotium/node";
import { appendTerminalInputHistory, loadTerminalInputHistory } from "@/history-store";

export type ClientResult<T> = T | Promise<T>;

export interface MessageHistoryPage {
  messages: MessageDto[];
  cursor?: string;
  hasMore: boolean;
}

export interface NegotiumClient {
  start(onEvent: (event: RuntimeBusEvent) => void): Promise<void>;
  stop(): Promise<void>;
  listTopics(): ClientResult<TopicDto[]>;
  listMessages(topicId: string): ClientResult<MessageDto[]>;
  listMessagePage?(topicId: string, cursor?: string): ClientResult<MessageHistoryPage>;
  createTopic(title: string, agent?: AgentKind): ClientResult<TopicDto>;
  resetTopic(topic: TopicDto): Promise<string>;
  compactTopic(topic: TopicDto): Promise<string>;
  deleteTopic(topic: TopicDto): Promise<void>;
  sendMessage(topic: TopicDto, text: string): ClientResult<MessageDto>;
  answerQuestion(
    topicId: string,
    messageId: string,
    label: string,
  ): ClientResult<{ ok: boolean; error?: string }>;
  abort(topicId: string): ClientResult<boolean>;
  listInputHistory?(): string[];
  appendInputHistory?(text: string): void;
  listRecentEvents?(topicId: string): ClientResult<RuntimeBusEvent[]>;
}

export interface EmbeddedClientOptions {
  userId: string;
  port?: number;
  /** Start and own a node. False attaches to an already-running in-process node. */
  startNode?: boolean;
}

/**
 * Explicit in-process recovery/development host. The default CLI path uses
 * RemoteNegotiumClient so the UI does not own the node or active turns.
 */
export class EmbeddedNegotiumClient implements NegotiumClient {
  readonly #userId: string;
  readonly #port: number;
  readonly #startNode: boolean;
  #node: NodeHandle | null = null;
  #unsubscribe: (() => void) | null = null;
  #started = false;

  constructor(options: EmbeddedClientOptions) {
    this.#userId = options.userId;
    this.#port = options.port ?? 0;
    this.#startNode = options.startNode !== false;
  }

  async start(onEvent: (event: RuntimeBusEvent) => void): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribe = runtimeBus().subscribe(onEvent);
    try {
      if (this.#startNode) this.#node = await startDefaultNode({ port: this.#port });
      ensurePersonalGeneral(this.#userId);
    } catch (error) {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#started = false;
    const node = this.#node;
    this.#node = null;
    if (node) await node.stop();
  }

  listTopics(): TopicDto[] {
    return getVisibleTopics().filter((topic) =>
      topic.participants.some((participant) => participant.userId === this.#userId),
    );
  }

  listMessages(topicId: string): MessageDto[] {
    const rows = getAllMessagesForTopic(topicId) as Array<{ id?: unknown }>;
    return rows
      .map((row) => (typeof row.id === "string" ? getApiMessage(topicId, row.id) : null))
      .filter((message): message is MessageDto => message !== null);
  }

  listMessagePage(topicId: string, cursor?: string): MessageHistoryPage {
    const result = listApiMessages(topicId, { cursor, limit: 50 });
    return { messages: result.page, cursor: result.cursor, hasMore: result.hasMore };
  }

  listRecentEvents(topicId: string): RuntimeBusEvent[] {
    return listRecentRuntimeEventsForTopic(topicId).map((event) => ({
      type: event.type,
      topicId: event.topicId,
      payload: event.payload,
      seq: event.seq,
      createdAt: event.createdAt,
    }));
  }

  createTopic(title: string, agent?: AgentKind): TopicDto {
    return registerTopic({
      title,
      userId: this.#userId,
      kind: "agent",
      ...(agent ? { agent } : {}),
    });
  }

  async resetTopic(topic: TopicDto): Promise<string> {
    const result = await restartTopicSession(topic.id, this.#userId, "terminal-session-reset");
    if (result.isError) throw new Error(result.text);
    return result.text;
  }

  async compactTopic(topic: TopicDto): Promise<string> {
    const result = await compactTopicSession(topic.id, this.#userId, "terminal-session-compact");
    if (result.isError) throw new Error(result.text);
    return result.text;
  }

  async deleteTopic(topic: TopicDto): Promise<void> {
    if (topic.kind === "manager") throw new Error("Manager topics cannot be deleted");
    const owner = topic.participants.some(
      (participant) => participant.userId === this.#userId && participant.role === "owner",
    );
    if (!owner) throw new Error("Only a topic owner can delete it");
    await deleteTopicCascade(topic, this.#userId);
  }

  sendMessage(topic: TopicDto, text: string): MessageDto {
    const message: MessageDto = {
      id: randomUUID(),
      topicId: topic.id,
      authorId: this.#userId,
      text,
      createdAt: new Date().toISOString(),
    };
    appendApiMessage(message);
    runtimeBus().broadcastMessage(topic.id, message);
    startAiTurn({
      topic,
      userId: this.#userId,
      prompt: text,
      allowAutoContinue: true,
    });
    return message;
  }

  answerQuestion(
    topicId: string,
    messageId: string,
    label: string,
  ): { ok: boolean; error?: string } {
    const result = answerPendingAskUserQuestion(topicId, messageId, label, this.#userId);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  abort(topicId: string): boolean {
    return abortRoom(topicId);
  }

  listInputHistory(): string[] {
    return loadTerminalInputHistory(this.#userId);
  }

  appendInputHistory(text: string): void {
    appendTerminalInputHistory(this.#userId, text);
  }
}

export interface RemoteClientOptions extends NodeDaemonConnection {
  userId: string;
}

interface ApiEnvelope {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

/** REST/SSE client. Stopping it only disconnects the UI; it never stops the node. */
export class RemoteNegotiumClient implements NegotiumClient {
  readonly #userId: string;
  readonly #baseUrl: string;
  readonly #token: string;
  #onEvent: ((event: RuntimeBusEvent) => void) | null = null;
  #eventAbort: AbortController | null = null;
  #eventTask: Promise<void> | null = null;
  #started = false;

  constructor(options: RemoteClientOptions) {
    this.#userId = options.userId;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#token = options.token;
  }

  async start(onEvent: (event: RuntimeBusEvent) => void): Promise<void> {
    if (this.#started) return;
    const session = await this.#request(`/session?user=${encodeURIComponent(this.#userId)}`);
    if (session.protocolVersion !== NODE_CONTROL_PROTOCOL_VERSION) {
      throw new Error(
        `Node protocol ${String(session.protocolVersion)} is incompatible with terminal protocol ${NODE_CONTROL_PROTOCOL_VERSION}`,
      );
    }
    const cursor = Number(session.cursor ?? 0);
    this.#onEvent = onEvent;
    this.#eventAbort = new AbortController();
    try {
      const first = await this.#openEventStream(cursor, this.#eventAbort.signal);
      this.#started = true;
      this.#eventTask = this.#runEventLoop(first, cursor, this.#eventAbort.signal);
    } catch (error) {
      this.#eventAbort = null;
      this.#onEvent = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#eventAbort?.abort();
    this.#eventAbort = null;
    await this.#eventTask?.catch(() => {});
    this.#eventTask = null;
    this.#onEvent = null;
  }

  async listTopics(): Promise<TopicDto[]> {
    const result = await this.#request(`/topics?user=${encodeURIComponent(this.#userId)}`);
    return (result.topics ?? []) as TopicDto[];
  }

  async listMessages(topicId: string): Promise<MessageDto[]> {
    const result = await this.#request(
      `/topics/${encodeURIComponent(topicId)}/messages?user=${encodeURIComponent(this.#userId)}`,
    );
    return (result.messages ?? []) as MessageDto[];
  }

  async listMessagePage(topicId: string, cursor?: string): Promise<MessageHistoryPage> {
    const query = new URLSearchParams({ user: this.#userId, limit: "50" });
    if (cursor) query.set("cursor", cursor);
    const result = await this.#request(
      `/topics/${encodeURIComponent(topicId)}/messages?${query.toString()}`,
    );
    return {
      messages: (result.messages ?? []) as MessageDto[],
      cursor: typeof result.cursor === "string" ? result.cursor : undefined,
      hasMore: result.hasMore === true,
    };
  }

  async listRecentEvents(topicId: string): Promise<RuntimeBusEvent[]> {
    const result = await this.#request(
      `/topics/${encodeURIComponent(topicId)}/recent-events?user=${encodeURIComponent(this.#userId)}`,
    );
    return (result.events ?? []) as RuntimeBusEvent[];
  }

  async createTopic(title: string, agent?: AgentKind): Promise<TopicDto> {
    const result = await this.#request("/topics", {
      method: "POST",
      body: JSON.stringify({ userId: this.#userId, title, agent }),
    });
    return result.topic as TopicDto;
  }

  async resetTopic(topic: TopicDto): Promise<string> {
    const result = await this.#request(`/topics/${encodeURIComponent(topic.id)}/session/reset`, {
      method: "POST",
      body: JSON.stringify({ userId: this.#userId }),
    });
    return String(result.result ?? `Session reset for "${topic.title}".`);
  }

  async compactTopic(topic: TopicDto): Promise<string> {
    const result = await this.#request(
      `/topics/${encodeURIComponent(topic.id)}/session/compact`,
      {
        method: "POST",
        body: JSON.stringify({ userId: this.#userId }),
      },
      180_000,
    );
    return String(result.result ?? `Compacted context for "${topic.title}".`);
  }

  async deleteTopic(topic: TopicDto): Promise<void> {
    await this.#request(
      `/topics/${encodeURIComponent(topic.id)}?user=${encodeURIComponent(this.#userId)}`,
      { method: "DELETE" },
    );
  }

  async sendMessage(topic: TopicDto, text: string): Promise<MessageDto> {
    const result = await this.#request(`/topics/${encodeURIComponent(topic.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ userId: this.#userId, text }),
    });
    return result.message as MessageDto;
  }

  async answerQuestion(
    topicId: string,
    messageId: string,
    label: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const result = await this.#request(`/questions/${encodeURIComponent(messageId)}/answer`, {
        method: "POST",
        body: JSON.stringify({ topicId, userId: this.#userId, label }),
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async abort(topicId: string): Promise<boolean> {
    const result = await this.#request(`/topics/${encodeURIComponent(topicId)}/abort`, {
      method: "POST",
      body: JSON.stringify({ userId: this.#userId }),
    });
    return result.aborted === true;
  }

  listInputHistory(): string[] {
    return loadTerminalInputHistory(this.#userId);
  }

  appendInputHistory(text: string): void {
    appendTerminalInputHistory(this.#userId, text);
  }

  async #request(path: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<ApiEnvelope> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.#baseUrl}${NODE_CONTROL_BASE_PATH}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
      });
      const result = (await response.json().catch(() => ({}))) as ApiEnvelope;
      if (!response.ok || result.ok === false) {
        throw new Error(result.error || `Node request failed with HTTP ${response.status}`);
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async #openEventStream(after: number, signal: AbortSignal): Promise<Response> {
    const response = await fetch(
      `${this.#baseUrl}${NODE_CONTROL_BASE_PATH}/events?user=${encodeURIComponent(this.#userId)}&after=${after}`,
      {
        signal,
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${this.#token}`,
        },
      },
    );
    if (!response.ok || !response.body) {
      const result = (await response.json().catch(() => ({}))) as ApiEnvelope;
      throw new Error(result.error || `Event stream failed with HTTP ${response.status}`);
    }
    return response;
  }

  async #runEventLoop(first: Response, initialCursor: number, signal: AbortSignal): Promise<void> {
    let response = first;
    let cursor = initialCursor;
    while (!signal.aborted) {
      try {
        cursor = await this.#consumeEventStream(response, cursor, signal);
      } catch {
        if (signal.aborted) break;
      }
      if (signal.aborted) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      try {
        response = await this.#openEventStream(cursor, signal);
      } catch {
        if (signal.aborted) break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
      }
    }
  }

  async #consumeEventStream(
    response: Response,
    initialCursor: number,
    signal: AbortSignal,
  ): Promise<number> {
    const reader = response.body?.getReader();
    if (!reader) return initialCursor;
    const decoder = new TextDecoder();
    let cursor = initialCursor;
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const fields = new Map<string, string>();
        for (const line of block.split("\n")) {
          if (!line || line.startsWith(":")) continue;
          const separator = line.indexOf(":");
          if (separator < 0) continue;
          fields.set(line.slice(0, separator), line.slice(separator + 1).trimStart());
        }
        const id = Number.parseInt(fields.get("id") ?? "", 10);
        if (Number.isFinite(id)) cursor = Math.max(cursor, id);
        if (fields.get("event") === "runtime" && fields.has("data")) {
          try {
            this.#onEvent?.(JSON.parse(fields.get("data") ?? "null") as RuntimeBusEvent);
          } catch {
            // Ignore one malformed event without dropping the durable stream.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
    return cursor;
  }
}
