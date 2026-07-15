/**
 * Remote-node forwarding adapter hook.
 *
 * Addressing keeps the `"<node>/<topic>"` shape so cross-node session-comm can
 * plug in later (an otium-hub adapter, a negotium peer protocol, …) without
 * changing tool contracts. On a standalone node every remote call fails
 * gracefully and `peerSessionsForUser` contributes nothing to peek listings.
 */

export interface PeerForwardArgs {
  action: "tell" | "ask" | "abort";
  toNode: string;
  toTopic: string;
  userId: string;
  fromKey?: string;
  fromTitle?: string;
  fromTopicId?: string;
  message?: string;
  requestId?: string;
  depth?: number;
  fromDepth?: number;
  /** Hub turn authorizing a worker-originated peer call. */
  sourceQueryId?: string;
}

export type PeerForwardResult = { ok: true } | { ok: false; error: string };

export interface RemoteReplyRoute {
  nodeName: string;
  nodeCellId: string;
  topicId: string;
  userId: string;
  requestId: string;
}

export interface PeerSessionBridge {
  forward(args: PeerForwardArgs): Promise<PeerForwardResult>;
  sessions(userId: string, sourceQueryId?: string): Promise<PeerSessionsResult>;
  reply(
    route: RemoteReplyRoute,
    sourceTitle: string,
    replyText: string,
    kind: "reply" | "error",
  ): Promise<boolean>;
}

let activeBridge: PeerSessionBridge | null = null;

export function registerPeerSessionBridge(bridge: PeerSessionBridge): () => void {
  activeBridge = bridge;
  return () => {
    if (activeBridge === bridge) activeBridge = null;
  };
}

export async function forwardToPeer(args: PeerForwardArgs): Promise<PeerForwardResult> {
  if (activeBridge) return activeBridge.forward(args);
  return {
    ok: false,
    error: "remote nodes are not connected on this negotium node (standalone mode)",
  };
}

export interface PeerSessionEntry {
  name: string;
  agent: string | null;
  hasSession: boolean;
  description?: string;
}

export interface PeerSessionsResult {
  ok: boolean;
  nodes?: Array<{ node: string; error?: string; sessions?: PeerSessionEntry[] }>;
}

export async function peerSessionsForUser(
  userId: string,
  sourceQueryId?: string,
): Promise<PeerSessionsResult> {
  if (activeBridge) return activeBridge.sessions(userId, sourceQueryId);
  return { ok: true, nodes: [] };
}

export async function deliverPeerReply(
  route: RemoteReplyRoute,
  sourceTitle: string,
  replyText: string,
  kind: "reply" | "error",
): Promise<boolean> {
  return (await activeBridge?.reply(route, sourceTitle, replyText, kind)) ?? false;
}
