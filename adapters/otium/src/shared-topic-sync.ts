import {
  appendApiMessage,
  getApiMessage,
  getRegistry,
  getTopic,
  isTopicShared,
  listApiMessages,
  listTopics,
  logger,
  type MessageDto,
  type RuntimeBusEvent,
  runtimeBus,
  WsHub,
} from "@negotium/core";
import { listPeerNodes, mintPeerToken, otiumCentralConfig, type PeerNode } from "@/central";
import { getActiveForwarder } from "@/event-backflow";
import type { OtiumJoin } from "@/join";
import {
  PEER_PROTOCOL_VERSION,
  type SharedTopicMessage,
  type SharedTopicMetadata,
} from "@/protocol";
import {
  deleteSharedMessage,
  deleteSharedTopicState,
  downgradeSharedTopicsLocally,
  enqueueSharedMessage,
  getSharedTopicState,
  isPeerDetached,
  listPeerSessions,
  listSharedMessages,
  listSharedTopicStates,
  setSharedTopicState,
} from "@/store";

const RETRY_MS = 1_000;

function isMirrorTopic(topicId: string): boolean {
  return listPeerSessions().some(
    (row) => row.local_topic_id === topicId && row.binding_mode === "mirror",
  );
}

function metadata(topic: NonNullable<ReturnType<typeof getTopic>>): SharedTopicMetadata {
  if (!topic.agent) throw new Error(`topic ${topic.id} has no executable agent`);
  const registry = getRegistry(topic.agent);
  return {
    localTopicId: topic.id,
    title: topic.title,
    ...(topic.description ? { description: topic.description } : {}),
    agent: topic.agent,
    model: topic.defaultModel || registry.defaultModel,
    effort: topic.defaultEffort ?? "medium",
  };
}

async function peerRequest(
  node: PeerNode,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const token = await mintPeerToken(node.cellId);
  const response = await fetch(`${node.baseUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body?.ok)
    throw new Error(String(body?.error ?? `peer request failed (${response.status})`));
  return body;
}

function messageEnvelope(message: MessageDto): SharedTopicMessage {
  const author: SharedTopicMessage["author"] = message.agentType
    ? "ai"
    : message.kind === "system" || message.kind === "tool"
      ? "system"
      : "user";
  return {
    sourceMessageId: message.sourceMessageId ?? message.id,
    author,
    text: message.text,
    createdAt: message.createdAt,
    ...(message.agentType ? { agent: message.agentType } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.kind ? { kind: message.kind } : {}),
  };
}

async function publishTopic(join: OtiumJoin, topicId: string, node: PeerNode): Promise<void> {
  const topic = getTopic(topicId);
  if (
    !topic ||
    topic.kind !== "agent" ||
    !topic.agent ||
    !isTopicShared(topic) ||
    !topic.visibility ||
    topic.visibility === "hidden" ||
    isMirrorTopic(topicId)
  )
    return;
  const state = getSharedTopicState(topicId);
  setSharedTopicState({
    localTopicId: topicId,
    hostTopicId: state?.host_topic_id,
    status: "publishing",
  });
  try {
    const body = await peerRequest(node, "/api/v1/peer/shared-topic", {
      method: "POST",
      body: JSON.stringify({
        v: PEER_PROTOCOL_VERSION,
        ...metadata(topic),
      }),
    });
    const hostTopicId =
      typeof body.hostTopicId === "string" ? body.hostTopicId : state?.host_topic_id;
    if (!hostTopicId) throw new Error("shared-topic response omitted hostTopicId");
    setSharedTopicState({ localTopicId: topicId, hostTopicId, status: "published" });
    const messages = listApiMessages(topicId, { limit: 200 })
      .page.filter((message) => !message.sourceNode)
      .map(messageEnvelope);
    if (messages.length) {
      await peerRequest(node, "/api/v1/peer/shared-topic/messages", {
        method: "POST",
        body: JSON.stringify({
          v: PEER_PROTOCOL_VERSION,
          localTopicId: topicId,
          hostTopicId,
          messages,
        }),
      });
    }
    for (const row of listSharedMessages(topicId)) {
      await peerRequest(node, "/api/v1/peer/shared-topic/messages", {
        method: "POST",
        body: JSON.stringify({
          v: PEER_PROTOCOL_VERSION,
          localTopicId: topicId,
          hostTopicId,
          messages: [JSON.parse(row.message_json)],
        }),
      });
      deleteSharedMessage(topicId, row.source_message_id);
    }
  } catch (error) {
    logger.warn({ error, topicId }, "otium: shared topic publish deferred");
    setTimeout(() => void reconcileTopic(join, topicId), RETRY_MS).unref?.();
  }
}

async function unpublishTopic(join: OtiumJoin, topicId: string, node: PeerNode): Promise<void> {
  const state = getSharedTopicState(topicId);
  if (!state) return;
  setSharedTopicState({
    localTopicId: topicId,
    hostTopicId: state.host_topic_id,
    status: "unpublishing",
  });
  try {
    await peerRequest(node, `/api/v1/peer/shared-topic/${encodeURIComponent(topicId)}`, {
      method: "DELETE",
    });
    deleteSharedTopicState(topicId);
  } catch (error) {
    logger.warn({ error, topicId }, "otium: shared topic unpublish deferred");
    setTimeout(() => void reconcileTopic(join, topicId), RETRY_MS).unref?.();
  }
}

async function reconcileTopic(join: OtiumJoin, topicId: string, explicit = false): Promise<void> {
  if (!otiumCentralConfig()) return;
  if (!explicit && isPeerDetached(join.cellId)) return;
  const target = (await listPeerNodes()).find((node) => node.isPrimary) ?? null;
  if (!target) return;
  const topic = getTopic(topicId);
  if (
    topic?.kind === "agent" &&
    topic.agent &&
    isTopicShared(topic) &&
    topic.visibility !== "hidden" &&
    !isMirrorTopic(topicId)
  )
    return publishTopic(join, topicId, target);
  return unpublishTopic(join, topicId, target);
}

/** Enforce the privacy boundary before attempting best-effort Hub cleanup. */
export function disconnectSharedTopics(join: OtiumJoin): Promise<void> {
  const states = listSharedTopicStates();
  const hubPromise = listPeerNodes({ fresh: true }).then(
    (nodes) => nodes.find((node) => node.isPrimary) ?? null,
    () => null,
  );
  const updated = downgradeSharedTopicsLocally(join.cellId);
  for (const topicId of updated) WsHub.get().broadcastTopicUpdated(topicId);
  const deletions = states.map(async (state) => {
    const hub = await hubPromise;
    if (!hub) return;
    try {
      await peerRequest(
        hub,
        `/api/v1/peer/shared-topic/${encodeURIComponent(state.local_topic_id)}`,
        {
          method: "DELETE",
        },
      );
    } catch {
      // Local privacy must not depend on Hub availability.
    }
  });

  return Promise.all(deletions).then(() => undefined);
}

export function downgradeSharedTopicsForHub(hubNodeId: string): number {
  const updated = downgradeSharedTopicsLocally(hubNodeId);
  for (const topicId of updated) WsHub.get().broadcastTopicUpdated(topicId);
  return updated.length;
}

/** Detect a central-side revoke without treating a temporary outage as one. */
export async function checkPeerAttachment(join: OtiumJoin): Promise<boolean> {
  const nodes = await listPeerNodes({ fresh: true });
  if (nodes.some((node) => node.cellId === join.cellId)) return true;
  downgradeSharedTopicsForHub(join.cellId);
  return false;
}

export function startSharedTopicSync(join: OtiumJoin): () => void {
  let stopped = false;
  let detached = isPeerDetached(join.cellId);
  const queue = new Set<string>();
  const schedule = (topicId: string, explicit = false) => {
    if (stopped || queue.has(topicId)) return;
    queue.add(topicId);
    queueMicrotask(async () => {
      queue.delete(topicId);
      try {
        await reconcileTopic(join, topicId, explicit);
      } catch (error) {
        logger.warn({ error, topicId }, "otium: shared topic reconciliation failed");
      }
    });
  };
  for (const topic of listTopics()) schedule(topic.id, false);
  for (const state of listSharedTopicStates()) schedule(state.local_topic_id);
  const attachmentCheck = setInterval(async () => {
    if (stopped || detached) return;
    try {
      if (!(await checkPeerAttachment(join))) detached = true;
    } catch {
      // A central outage is not proof of revocation.
    }
  }, 30_000);
  attachmentCheck.unref?.();
  const unsubscribe = runtimeBus().subscribe((event: RuntimeBusEvent) => {
    if (
      event.type === "topic-created" ||
      event.type === "topic-updated" ||
      event.type === "topic-deleted"
    )
      schedule(event.topicId, true);
    if (event.type === "message") {
      const message = event.payload as MessageDto;
      if (!message.sourceNode) {
        schedule(event.topicId);
        void forwardSharedTopicMessage(join, message).catch((error) =>
          logger.warn({ error, topicId: event.topicId }, "otium: shared message deferred"),
        );
      }
    }
  });
  return () => {
    stopped = true;
    clearInterval(attachmentCheck);
    unsubscribe();
  };
}

export async function forwardSharedTopicMessage(
  _join: OtiumJoin,
  message: MessageDto,
): Promise<void> {
  if (message.sourceNode || isMirrorTopic(message.topicId)) return;
  if (getActiveForwarder(message.topicId)) return;
  const state = getSharedTopicState(message.topicId);
  if (!state?.host_topic_id || state.status !== "published") return;
  const hub = (await listPeerNodes()).find((node) => node.isPrimary) ?? null;
  if (!hub) return;
  const envelope = messageEnvelope(message);
  try {
    await peerRequest(hub, "/api/v1/peer/shared-topic/messages", {
      method: "POST",
      body: JSON.stringify({
        v: PEER_PROTOCOL_VERSION,
        localTopicId: message.topicId,
        hostTopicId: state.host_topic_id,
        messages: [envelope],
      }),
    });
  } catch (error) {
    enqueueSharedMessage({
      localTopicId: message.topicId,
      sourceMessageId: envelope.sourceMessageId,
      message: envelope,
    });
    throw error;
  }
}

export function acceptSharedTopicMessages(
  messages: SharedTopicMessage[],
  localTopicId: string,
  sourceNode: string,
): number {
  let inserted = 0;
  for (const incoming of messages) {
    if (!incoming.sourceMessageId || typeof incoming.text !== "string") continue;
    if (getApiMessage(localTopicId, incoming.sourceMessageId)) continue;
    const message: MessageDto = {
      id: incoming.sourceMessageId,
      topicId: localTopicId,
      authorId: sourceNode,
      text: incoming.text,
      createdAt: incoming.createdAt,
      ...(incoming.agent ? { agentType: incoming.agent as MessageDto["agentType"] } : {}),
      ...(incoming.model ? { model: incoming.model } : {}),
      ...(incoming.kind ? { kind: incoming.kind as MessageDto["kind"] } : {}),
      sourceNode,
      sourceMessageId: incoming.sourceMessageId,
    };
    appendApiMessage(message);
    inserted++;
  }
  return inserted;
}
