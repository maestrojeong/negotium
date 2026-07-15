import {
  clearPendingAsk,
  deliverAskCallbackToCaller,
  logger,
  type PeerForwardArgs,
  type PeerForwardResult,
  type PeerSessionBridge,
  type RemoteReplyRoute,
} from "@negotium/core";
import {
  listPeerNodes,
  mintPeerToken,
  type PeerNode,
  resolvePeerNodeByCellId,
  selfPeerNode,
} from "@/central";
import { PEER_PROTOCOL_VERSION, type PeerSessionEntry } from "@/protocol";
import {
  createRemoteAsk,
  deletePeerReplyOutbox,
  deleteRemoteAsk,
  getRemoteAsk,
  listPeerReplyOutbox,
  pruneRemoteAsks,
  upsertPeerReplyOutbox,
} from "@/store";

const PEER_TIMEOUT_MS = 15_000;
const PENDING_ASK_TTL_MS = 15 * 60 * 1000;

function prunePendingRemoteAsks(now = Date.now()): void {
  pruneRemoteAsks(now - PENDING_ASK_TTL_MS);
}

async function postPeer<T = Record<string, never>>(
  node: PeerNode,
  path: string,
  body: Record<string, unknown>,
): Promise<
  ({ ok: true } & T) | { ok: false; error: string; ambiguous?: boolean; status?: number }
> {
  try {
    const token = await mintPeerToken(node.cellId);
    const response = await fetch(`${node.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    const parsed = (await response.json().catch(() => null)) as
      | ({ ok?: boolean; error?: string } & T)
      | null;
    if (!response.ok || !parsed?.ok) {
      return {
        ok: false,
        error: parsed?.error ?? `peer call failed (${response.status})`,
        status: response.status,
        ...(response.status >= 500 ? { ambiguous: true } : {}),
      };
    }
    return parsed as { ok: true } & T;
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message || "peer node unreachable",
      ambiguous: true,
    };
  }
}

async function postPeerIdempotent<T = Record<string, never>>(
  node: PeerNode,
  path: string,
  body: Record<string, unknown>,
): ReturnType<typeof postPeer<T>> {
  let result = await postPeer<T>(node, path, body);
  for (const delayMs of [50, 150]) {
    if (result.ok || !result.ambiguous) return result;
    await Bun.sleep(delayMs);
    result = await postPeer<T>(node, path, body);
  }
  return result;
}

async function peerSupportsRemoteAsk(node: PeerNode): Promise<boolean> {
  try {
    const token = await mintPeerToken(node.cellId);
    const response = await fetch(`${node.baseUrl.replace(/\/+$/, "")}/api/v1/peer/capabilities`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      features?: { remoteAsk?: boolean };
    } | null;
    return response.ok && body?.ok === true && body.features?.remoteAsk === true;
  } catch {
    return false;
  }
}

async function findNode(nodeName: string): Promise<PeerNode | null> {
  const find = (nodes: PeerNode[]) => nodes.find((node) => node.nodeName === nodeName) ?? null;
  return find(await listPeerNodes()) ?? find(await listPeerNodes({ fresh: true }));
}

async function originLabel(args: PeerForwardArgs): Promise<string> {
  const self = await selfPeerNode();
  const local = args.fromTitle?.trim() || args.fromKey?.trim() || "peer";
  return self?.nodeName ? `${self.nodeName}/${local}` : local;
}

async function forward(args: PeerForwardArgs): Promise<PeerForwardResult> {
  const node = await findNode(args.toNode).catch(() => null);
  if (!node || node.self) return { ok: false, error: `unknown remote node "${args.toNode}"` };
  const self = await selfPeerNode().catch(() => null);
  if (!self) return { ok: false, error: "local peer node is not attached" };
  if (!self.isPrimary && !node.isPrimary) {
    return { ok: false, error: "worker peer calls must target the primary hub" };
  }
  const fromLabel = await originLabel(args);
  const requestId = args.requestId;

  if (args.action === "ask") {
    if (!requestId || !args.fromTopicId || !args.fromKey || !args.message) {
      return { ok: false, error: "remote ask is missing caller metadata" };
    }
    if (!(await peerSupportsRemoteAsk(node))) {
      return { ok: false, error: `node "${args.toNode}" does not support remote ask` };
    }
    prunePendingRemoteAsks();
    const created = createRemoteAsk({
      requestId,
      expectedCellId: node.cellId,
      userId: args.userId,
      callerTopicId: args.fromTopicId,
      from: args.fromKey,
      to: `${args.toNode}/${args.toTopic}`,
      ...(node.isPrimary && args.sourceQueryId ? { sourceQueryId: args.sourceQueryId } : {}),
    });
    if (!created) {
      return { ok: false, error: `remote ask requestId "${requestId}" is already pending` };
    }
    const result = await postPeerIdempotent(node, "/api/v1/peer/ask", {
      v: PEER_PROTOCOL_VERSION,
      requestId,
      userId: args.userId,
      toTopic: args.toTopic,
      fromLabel,
      message: args.message,
      fromDepth: args.fromDepth ?? 0,
      replyTo: { topicId: args.fromTopicId },
      ...(args.sourceQueryId ? { sourceQueryId: args.sourceQueryId } : {}),
    });
    if (!result.ok) {
      if (!result.ambiguous) {
        deleteRemoteAsk(requestId);
        return result;
      }
      // The peer may have accepted the idempotent request before its response
      // was lost. Keep the durable route so a late reply remains deliverable.
      logger.warn(
        { requestId, node: node.nodeName, error: result.error },
        "otium: remote ask acceptance is uncertain; preserving durable reply route",
      );
      return { ok: true };
    }
    return result;
  }

  if (args.action === "tell") {
    if (!requestId || !args.message) return { ok: false, error: "remote tell is incomplete" };
    const result = await postPeerIdempotent(node, "/api/v1/peer/tell", {
      v: PEER_PROTOCOL_VERSION,
      requestId,
      userId: args.userId,
      toTopic: args.toTopic,
      fromLabel,
      message: args.message,
      depth: args.depth ?? 0,
      ...(args.sourceQueryId ? { sourceQueryId: args.sourceQueryId } : {}),
    });
    if (!result.ok && result.ambiguous) {
      // tell is idempotently claimed by requestId at the receiver. Reporting a
      // hard failure here encourages callers to retry with a fresh requestId,
      // which can duplicate a tell that was accepted before its response was
      // lost. Same-id retries above are the safe retry boundary.
      logger.warn(
        { requestId, node: node.nodeName, error: result.error },
        "otium: remote tell delivery is uncertain after idempotent retries",
      );
      return { ok: true };
    }
    return result;
  }

  return postPeer(node, "/api/v1/peer/abort", {
    v: PEER_PROTOCOL_VERSION,
    userId: args.userId,
    toTopic: args.toTopic,
    ...(requestId ? { requestId } : {}),
    ...(args.sourceQueryId ? { sourceQueryId: args.sourceQueryId } : {}),
  });
}

async function sessions(userId: string, sourceQueryId?: string) {
  const nodes = await listPeerNodes().catch(() => []);
  const self = nodes.find((node) => node.self);
  if (!self) return { ok: false, nodes: [] };
  return {
    ok: true,
    nodes: await Promise.all(
      nodes
        .filter((node) => !node.self && node.nodeName && (self.isPrimary || node.isPrimary))
        .map(async (node) => {
          const result = await postPeer<{ sessions: PeerSessionEntry[] }>(
            node,
            "/api/v1/peer/sessions",
            {
              v: PEER_PROTOCOL_VERSION,
              userId,
              ...(sourceQueryId ? { sourceQueryId } : {}),
            },
          );
          return result.ok
            ? { node: node.nodeName as string, sessions: result.sessions }
            : { node: node.nodeName as string, error: result.error };
        }),
    ),
  };
}

async function reply(
  route: RemoteReplyRoute,
  sourceTitle: string,
  replyText: string,
  kind: "reply" | "error",
): Promise<boolean> {
  upsertPeerReplyOutbox({
    nodeCellId: route.nodeCellId,
    requestId: route.requestId,
    nodeName: route.nodeName,
    topicId: route.topicId,
    userId: route.userId,
    sourceTitle,
    replyText,
    kind,
  });
  await flushPeerReplyOutbox();
  return true;
}

let peerReplyFlush: Promise<void> | null = null;

export function flushPeerReplyOutbox(): Promise<void> {
  if (peerReplyFlush) return peerReplyFlush;
  peerReplyFlush = (async () => {
    for (const pending of listPeerReplyOutbox()) {
      const node = await resolvePeerNodeByCellId(pending.node_cell_id).catch(() => null);
      if (!node) continue;
      const fromLabel = await originLabel({
        action: "ask",
        toNode: pending.node_name,
        toTopic: "",
        userId: pending.user_id,
        fromTitle: pending.source_title,
      });
      const result = await postPeer(node, "/api/v1/peer/reply", {
        v: PEER_PROTOCOL_VERSION,
        requestId: pending.request_id,
        userId: pending.user_id,
        kind: pending.kind,
        replyText: pending.reply_text,
        fromLabel,
      });
      if (result.ok || !result.ambiguous) {
        deletePeerReplyOutbox(pending.node_cell_id, pending.request_id);
        if (!result.ok && result.status !== 404) {
          logger.warn(
            { requestId: pending.request_id, status: result.status, error: result.error },
            "otium: dropping definitively rejected peer reply",
          );
        }
        continue;
      }
      logger.warn(
        { requestId: pending.request_id, error: result.error },
        "otium: peer reply delivery failed; retained for retry",
      );
    }
  })().finally(() => {
    peerReplyFlush = null;
  });
  return peerReplyFlush;
}

export function startPeerReplyOutboxWorker(): () => void {
  void flushPeerReplyOutbox();
  const timer = setInterval(() => void flushPeerReplyOutbox(), 5_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

export async function acceptRemoteAskReply(args: {
  fromCellId: string;
  requestId: string;
  userId: string;
  fromLabel: string;
  replyText: string;
  kind: "reply" | "error";
}): Promise<boolean> {
  prunePendingRemoteAsks();
  const pending = getRemoteAsk(args.requestId);
  if (!pending || pending.expected_cell_id !== args.fromCellId || pending.user_id !== args.userId) {
    return false;
  }
  if (pending.source_query_id) {
    const node = await resolvePeerNodeByCellId(pending.expected_cell_id).catch(() => null);
    if (!node?.isPrimary) return false;
    const delivered = await postPeer(node, "/api/v1/peer/ask-callback", {
      v: PEER_PROTOCOL_VERSION,
      requestId: args.requestId,
      sourceQueryId: pending.source_query_id,
      userId: pending.user_id,
      fromLabel: args.fromLabel,
      replyText: args.replyText,
      kind: args.kind,
    });
    if (!delivered.ok) {
      logger.warn(
        { requestId: args.requestId, error: delivered.error },
        "otium: canonical remote ask callback failed",
      );
      return false;
    }
    deleteRemoteAsk(args.requestId);
    clearPendingAsk({
      userId: pending.user_id,
      from: pending.from_key,
      to: pending.to_key,
      requestId: args.requestId,
    });
    return true;
  }

  const delivered = await deliverAskCallbackToCaller(
    {
      requestId: args.requestId,
      callerTopicId: pending.caller_topic_id,
      callerUserId: pending.user_id,
      pendingAsk: {
        userId: pending.user_id,
        from: pending.from_key,
        to: pending.to_key,
        requestId: args.requestId,
      },
    },
    args.fromLabel,
    args.replyText,
    args.kind,
  );
  if (!delivered) return false;
  deleteRemoteAsk(args.requestId);
  return true;
}

export const otiumPeerSessionBridge: PeerSessionBridge = { forward, sessions, reply };
