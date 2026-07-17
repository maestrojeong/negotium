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

const PEER_BRIDGE_URL_ENV = "NEGOTIUM_PEER_SESSION_BRIDGE_URL";
const PEER_BRIDGE_TOKEN_ENV = "NEGOTIUM_PEER_SESSION_BRIDGE_TOKEN";
const PEER_BRIDGE_TIMEOUT_MS = 5_000;

type IpcRequest =
  | { action: "forward"; args: PeerForwardArgs }
  | { action: "sessions"; userId: string; sourceQueryId?: string }
  | {
      action: "reply";
      route: RemoteReplyRoute;
      sourceTitle: string;
      replyText: string;
      kind: "reply" | "error";
    };

function loopbackBridgeConfig(): { url: string; token: string } | null {
  const rawUrl = process.env[PEER_BRIDGE_URL_ENV]?.trim();
  const token = process.env[PEER_BRIDGE_TOKEN_ENV]?.trim();
  if (!rawUrl || !token) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) {
      return null;
    }
    return { url: url.toString(), token };
  } catch {
    return null;
  }
}

async function callLoopbackBridge<T>(
  request: IpcRequest,
): Promise<{ configured: boolean; result: T | null }> {
  const config = loopbackBridgeConfig();
  if (!config) return { configured: false, result: null };
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(PEER_BRIDGE_TIMEOUT_MS),
    });
    if (!response.ok) return { configured: true, result: null };
    return { configured: true, result: (await response.json()) as T };
  } catch {
    return { configured: true, result: null };
  }
}

export function registerPeerSessionBridge(bridge: PeerSessionBridge): () => void {
  activeBridge = bridge;
  return () => {
    if (activeBridge === bridge) activeBridge = null;
  };
}

export async function forwardToPeer(args: PeerForwardArgs): Promise<PeerForwardResult> {
  if (activeBridge) return activeBridge.forward(args);
  const forwarded = await callLoopbackBridge<PeerForwardResult>({ action: "forward", args });
  if (forwarded.result) return forwarded.result;
  return {
    ok: false,
    error: forwarded.configured
      ? "remote session bridge is configured but unavailable"
      : "remote nodes are not connected on this negotium node (standalone mode)",
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
  const sessions = await callLoopbackBridge<PeerSessionsResult>({
    action: "sessions",
    userId,
    sourceQueryId,
  });
  if (sessions.result) return sessions.result;
  if (sessions.configured) return { ok: false, nodes: [] };
  return { ok: true, nodes: [] };
}

export async function deliverPeerReply(
  route: RemoteReplyRoute,
  sourceTitle: string,
  replyText: string,
  kind: "reply" | "error",
): Promise<boolean> {
  if (activeBridge) return activeBridge.reply(route, sourceTitle, replyText, kind);
  return (
    (
      await callLoopbackBridge<boolean>({
        action: "reply",
        route,
        sourceTitle,
        replyText,
        kind,
      })
    ).result ?? false
  );
}
