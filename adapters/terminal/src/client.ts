import { randomUUID } from "node:crypto";
import {
  type AgentKind,
  abortRoom,
  answerPendingAskUserQuestion,
  appendApiMessage,
  getAllMessagesForTopic,
  getApiMessage,
  getVisibleTopics,
  type MessageDto,
  type RuntimeBusEvent,
  registerTopic,
  runtimeBus,
  startAiTurn,
  type TopicDto,
} from "@negotium/core";
import { type NodeHandle, startDefaultNode } from "@negotium/node";

export interface NegotiumClient {
  start(onEvent: (event: RuntimeBusEvent) => void): Promise<void>;
  stop(): Promise<void>;
  listTopics(): TopicDto[];
  listMessages(topicId: string): MessageDto[];
  createTopic(title: string, agent?: AgentKind): TopicDto;
  sendMessage(topic: TopicDto, text: string): MessageDto;
  answerQuestion(
    topicId: string,
    messageId: string,
    label: string,
  ): { ok: boolean; error?: string };
  abort(topicId: string): boolean;
}

export interface EmbeddedClientOptions {
  userId: string;
  port?: number;
  /** Start and own a node. False attaches to an already-running in-process node. */
  startNode?: boolean;
}

/**
 * In-process host used by the first TUI release. Only this class knows that
 * core is embedded; the app/state/render layers depend on NegotiumClient so a
 * remote REST/WebSocket transport can be introduced without rewriting them.
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

  createTopic(title: string, agent?: AgentKind): TopicDto {
    return registerTopic({
      title,
      userId: this.#userId,
      kind: "agent",
      ...(agent ? { agent } : {}),
    });
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
}
