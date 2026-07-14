/**
 * Remote-node forwarding stub.
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
}

export type PeerForwardResult = { ok: true } | { ok: false; error: string };

export async function forwardToPeer(_args: PeerForwardArgs): Promise<PeerForwardResult> {
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

export async function peerSessionsForUser(_userId: string): Promise<PeerSessionsResult> {
  return { ok: true, nodes: [] };
}
