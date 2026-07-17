import {
  type AgentKind,
  type BackgroundSessionDto,
  deleteVaultEntry,
  type EffortLevel,
  ensurePersonalGeneral,
  executeVaultCommand,
  getAllMessagesForTopic,
  getApiMessage,
  getVisibleTopics,
  listApiMessages,
  listBackgroundSessionsForUser,
  listRecentRuntimeEventsForTopic,
  listRunningTopicQueries,
  listVaultEntries,
  type MessageDto,
  type RuntimeBusEvent,
  runtimeBus,
  type SaveVaultEntryResult,
  saveVaultEntry,
  submitUserMessage,
  switchTopicEffort,
  switchTopicModel,
  type TopicDto,
  topicService,
  type VaultEntry,
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

export const MESSAGE_HISTORY_PAGE_SIZE = 50;
export const INITIAL_MESSAGE_HISTORY_PAGE_COUNT = 3;
export const INITIAL_MESSAGE_HISTORY_LIMIT =
  MESSAGE_HISTORY_PAGE_SIZE * INITIAL_MESSAGE_HISTORY_PAGE_COUNT;

export interface MessageHistoryPage {
  messages: MessageDto[];
  cursor?: string;
  hasMore: boolean;
}

export interface NegotiumClient {
  start(onEvent: (event: RuntimeBusEvent) => void): Promise<void>;
  stop(): Promise<void>;
  listTopics(): ClientResult<TopicDto[]>;
  listBackgroundSessions?(): ClientResult<BackgroundSessionDto[]>;
  listMessages(topicId: string): ClientResult<MessageDto[]>;
  listMessagePage?(
    topicId: string,
    cursor?: string,
    limit?: number,
  ): ClientResult<MessageHistoryPage>;
  createTopic(title: string, agent?: AgentKind): ClientResult<TopicDto>;
  deriveTopic(topic: TopicDto, copyHistory: boolean, name?: string): Promise<TopicDto>;
  resetTopic(topic: TopicDto): Promise<string>;
  compactTopic(topic: TopicDto): Promise<string>;
  setModel(topic: TopicDto, model: string): ClientResult<string>;
  setEffort(topic: TopicDto, effort: EffortLevel): ClientResult<string>;
  deleteTopic(topic: TopicDto): Promise<void>;
  sendMessage(topic: TopicDto, text: string): ClientResult<MessageDto>;
  answerQuestion(
    topicId: string,
    messageId: string,
    label: string,
  ): ClientResult<{ ok: boolean; error?: string }>;
  abort(topicId: string): ClientResult<boolean>;
  runVaultCommand?(commandLine: string): ClientResult<string | null>;
  listVaultEntries?(): ClientResult<VaultEntry[]>;
  saveVaultEntry?(
    key: string,
    value: string,
    description: string,
  ): ClientResult<SaveVaultEntryResult>;
  deleteVaultEntry?(key: string): ClientResult<boolean>;
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
    const runningTopics = listRunningTopicQueries();
    return getVisibleTopics()
      .filter((topic) =>
        topic.participants.some((participant) => participant.userId === this.#userId),
      )
      .map((topic) => {
        const runningQueryId = runningTopics.get(topic.id);
        return { ...topic, running: Boolean(runningQueryId), runningQueryId };
      });
  }

  listBackgroundSessions(): BackgroundSessionDto[] {
    return listBackgroundSessionsForUser(this.#userId);
  }

  listMessages(topicId: string): MessageDto[] {
    const rows = getAllMessagesForTopic(topicId) as Array<{ id?: unknown }>;
    return rows
      .map((row) => (typeof row.id === "string" ? getApiMessage(topicId, row.id) : null))
      .filter((message): message is MessageDto => message !== null);
  }

  listMessagePage(
    topicId: string,
    cursor?: string,
    limit = MESSAGE_HISTORY_PAGE_SIZE,
  ): MessageHistoryPage {
    const result = listApiMessages(topicId, { cursor, limit });
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
    return topicService.create({
      title,
      userId: this.#userId,
      kind: "agent",
      ...(agent ? { agent } : {}),
    });
  }

  async deriveTopic(topic: TopicDto, copyHistory: boolean, name?: string): Promise<TopicDto> {
    const derived = await topicService.derive({
      sourceTopicId: topic.id,
      userId: this.#userId,
      copyHistory,
      ...(name ? { name } : {}),
    });
    if (!derived) throw new Error(`Failed to ${copyHistory ? "fork" : "spawn"} "${topic.title}"`);
    return derived;
  }

  async resetTopic(topic: TopicDto): Promise<string> {
    const result = await topicService.reset({
      topicId: topic.id,
      userId: this.#userId,
      reason: "terminal-session-reset",
    });
    if (result.isError) throw new Error(result.text);
    return result.text;
  }

  async compactTopic(topic: TopicDto): Promise<string> {
    const result = await topicService.compact({
      topicId: topic.id,
      userId: this.#userId,
      reason: "terminal-session-compact",
    });
    if (result.isError) throw new Error(result.text);
    return result.text;
  }

  setModel(topic: TopicDto, model: string): string {
    const result = switchTopicModel({ topicId: topic.id, userId: this.#userId, model });
    if (!result.ok) throw new Error(result.error);
    return result.text;
  }

  setEffort(topic: TopicDto, effort: EffortLevel): string {
    const result = switchTopicEffort({ topicId: topic.id, userId: this.#userId, effort });
    if (!result.ok) throw new Error(result.error);
    return result.text;
  }

  async deleteTopic(topic: TopicDto): Promise<void> {
    await topicService.delete({ topicId: topic.id, userId: this.#userId });
  }

  sendMessage(topic: TopicDto, text: string): MessageDto {
    return submitUserMessage({
      topic,
      userId: this.#userId,
      text,
      sourceAdapter: "terminal",
    }).message;
  }

  answerQuestion(
    topicId: string,
    messageId: string,
    label: string,
  ): { ok: boolean; error?: string } {
    const result = topicService.answerQuestion(topicId, messageId, label, this.#userId);
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }

  abort(topicId: string): boolean {
    return topicService.abortTurn(topicId, this.#userId);
  }

  runVaultCommand(commandLine: string): string | null {
    return executeVaultCommand(this.#userId, commandLine);
  }

  listVaultEntries(): VaultEntry[] {
    return listVaultEntries(this.#userId);
  }

  saveVaultEntry(key: string, value: string, description: string): SaveVaultEntryResult {
    return saveVaultEntry(this.#userId, key, value, description);
  }

  deleteVaultEntry(key: string): boolean {
    return deleteVaultEntry(this.#userId, key);
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

function missingControlRoute(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|http 404/i.test(message);
}

function parseLegacyVaultList(output: string | null): VaultEntry[] {
  if (!output || /vault is empty/i.test(output)) return [];
  return output
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const match = line.match(/^- ([A-Z][A-Z0-9_]*)(?:: (.*))?$/);
      return match?.[1] ? [{ key: match[1], description: match[2] ?? "" }] : [];
    });
}

function isSecureControlTransport(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
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
    if (!isSecureControlTransport(this.#baseUrl)) {
      throw new Error("Remote node control requires HTTPS or loopback HTTP");
    }
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

  async listBackgroundSessions(): Promise<BackgroundSessionDto[]> {
    const result = await this.#request(
      `/background-sessions?user=${encodeURIComponent(this.#userId)}`,
    );
    return (result.sessions ?? []) as BackgroundSessionDto[];
  }

  async listMessages(topicId: string): Promise<MessageDto[]> {
    const result = await this.#request(
      `/topics/${encodeURIComponent(topicId)}/messages?user=${encodeURIComponent(this.#userId)}`,
    );
    return (result.messages ?? []) as MessageDto[];
  }

  async listMessagePage(
    topicId: string,
    cursor?: string,
    limit = MESSAGE_HISTORY_PAGE_SIZE,
  ): Promise<MessageHistoryPage> {
    const query = new URLSearchParams({ user: this.#userId, limit: String(limit) });
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

  async deriveTopic(topic: TopicDto, copyHistory: boolean, name?: string): Promise<TopicDto> {
    const result = await this.#request(`/topics/${encodeURIComponent(topic.id)}/derive`, {
      method: "POST",
      body: JSON.stringify({ userId: this.#userId, copyHistory, ...(name ? { name } : {}) }),
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

  async setModel(topic: TopicDto, model: string): Promise<string> {
    const result = await this.#request(`/topics/${encodeURIComponent(topic.id)}/model`, {
      method: "POST",
      body: JSON.stringify({ userId: this.#userId, model }),
    });
    return String(result.result ?? `Model set to '${model}'.`);
  }

  async setEffort(topic: TopicDto, effort: EffortLevel): Promise<string> {
    const result = await this.#request(`/topics/${encodeURIComponent(topic.id)}/effort`, {
      method: "POST",
      body: JSON.stringify({ userId: this.#userId, effort }),
    });
    return String(result.result ?? `Effort set to '${effort}'.`);
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

  async runVaultCommand(commandLine: string): Promise<string | null> {
    const result = await this.#request("/vault/command", {
      method: "POST",
      body: JSON.stringify({ userId: this.#userId, commandLine }),
    });
    return typeof result.result === "string" ? result.result : null;
  }

  async listVaultEntries(): Promise<VaultEntry[]> {
    try {
      const result = await this.#request(`/vault?user=${encodeURIComponent(this.#userId)}`);
      return (result.entries ?? []) as VaultEntry[];
    } catch (error) {
      if (!missingControlRoute(error)) throw error;
      return parseLegacyVaultList(await this.runVaultCommand("/vault list"));
    }
  }

  async saveVaultEntry(
    key: string,
    value: string,
    description: string,
  ): Promise<SaveVaultEntryResult> {
    try {
      const result = await this.#request("/vault", {
        method: "POST",
        body: JSON.stringify({ userId: this.#userId, key, value, description }),
      });
      return result.result as SaveVaultEntryResult;
    } catch (error) {
      if (!missingControlRoute(error)) throw error;
      if (/\s\|\s/.test(value)) {
        throw new Error("Restart the Negotium node before saving a secret containing ' | '.");
      }
      const output = await this.runVaultCommand(
        // Always include the legacy value/description delimiter. Without it,
        // a multi-word value with an empty description is parsed by old nodes
        // as a one-word secret plus a description, silently corrupting it.
        `/vault set ${key} ${value} | ${description}`,
      );
      if (!output) throw new Error("Vault save failed.");
      return { key, updated: output.startsWith("Updated") };
    }
  }

  async deleteVaultEntry(key: string): Promise<boolean> {
    try {
      const result = await this.#request(
        `/vault?user=${encodeURIComponent(this.#userId)}&key=${encodeURIComponent(key)}`,
        { method: "DELETE" },
      );
      return result.deleted === true;
    } catch (error) {
      if (!missingControlRoute(error)) throw error;
      const output = await this.runVaultCommand(`/vault del ${key}`);
      return output?.startsWith("Deleted") === true;
    }
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
