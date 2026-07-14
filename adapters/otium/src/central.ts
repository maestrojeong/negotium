/**
 * Central peer API client — token mint/verify and node discovery for this
 * cell. Port of otium's `apps/runtime-api/src/peer/central.ts` (identical
 * cache policy) with `hostedRuntimeConfig()` replaced by the adapter's join
 * credentials. The cell secret never leaves this process; peers only ever see
 * the short-lived `ptk_…` tokens central mints here.
 */

import { logger } from "@negotium/core";
import type { OtiumJoin } from "@/join";

export interface PeerNode {
  cellId: string;
  nodeName: string | null;
  isPrimary: boolean;
  baseUrl: string;
  self: boolean;
}

export interface VerifiedPeer {
  workspaceId: string;
  fromCellId: string;
  fromNodeName: string | null;
  fromIsPrimary: boolean;
  expiresAt: string;
}

const NODES_CACHE_MS = 30_000;
/** Positive verify cache — deliberately short so assignment revocation bites
 *  within seconds, not the token TTL. */
const VERIFY_CACHE_MS = 30_000;

let joinConfig: OtiumJoin | null = null;
let nodesCache: { nodes: PeerNode[]; workspaceId: string; at: number } | null = null;
const verifyCache = new Map<string, { verified: VerifiedPeer; at: number }>();
const tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

/** Install (or clear) the join credentials every central call authenticates with. */
export function configureOtiumCentral(join: OtiumJoin | null): void {
  joinConfig = join;
  resetPeerCentralCaches();
}

export function otiumCentralConfig(): OtiumJoin | null {
  return joinConfig;
}

function centralFetch(path: string, init: RequestInit): Promise<Response> {
  if (!joinConfig) throw new Error("otium: join credentials missing");
  return fetch(`${joinConfig.central}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${joinConfig.secret}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(5000),
  });
}

/** Active nodes of this cell's workspace (30s cache; pass fresh=true after a
 *  resolution miss so a just-attached node is visible). */
export async function listPeerNodes(opts: { fresh?: boolean } = {}): Promise<PeerNode[]> {
  if (!opts.fresh && nodesCache && Date.now() - nodesCache.at < NODES_CACHE_MS) {
    return nodesCache.nodes;
  }
  const response = await centralFetch("/peer/nodes", { method: "GET" });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    workspaceId?: string;
    nodes?: PeerNode[];
  };
  if (!response.ok || !body.ok || !Array.isArray(body.nodes)) {
    throw new Error(`otium: node discovery failed: ${body.error ?? response.status}`);
  }
  nodesCache = { nodes: body.nodes, workspaceId: body.workspaceId ?? "", at: Date.now() };
  return body.nodes;
}

export async function selfPeerNode(): Promise<PeerNode | null> {
  const nodes = await listPeerNodes();
  return nodes.find((node) => node.self) ?? null;
}

export async function resolvePeerNodeByCellId(cellId: string): Promise<PeerNode | null> {
  const find = (nodes: PeerNode[]) => nodes.find((node) => node.cellId === cellId) ?? null;
  const cached = find(await listPeerNodes());
  if (cached) return cached;
  return find(await listPeerNodes({ fresh: true }));
}

/** Mint (or reuse a still-fresh) peer token for one target cell. Tokens are
 *  reusable within their TTL, so cache until shortly before expiry. */
export async function mintPeerToken(toCellId: string): Promise<string> {
  const cached = tokenCache.get(toCellId);
  if (cached && cached.expiresAtMs - Date.now() > 30_000) return cached.token;
  const response = await centralFetch("/peer/token", {
    method: "POST",
    body: JSON.stringify({ toCellId }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    token?: string;
    expiresAt?: string;
  };
  if (!response.ok || !body.ok || !body.token) {
    throw new Error(`otium: peer token mint failed: ${body.error ?? response.status}`);
  }
  tokenCache.set(toCellId, {
    token: body.token,
    expiresAtMs: Date.parse(body.expiresAt ?? "") || Date.now() + 60_000,
  });
  return body.token;
}

/** Verify an inbound peer token against central (fail-closed on outages). */
export async function verifyPeerToken(token: string): Promise<VerifiedPeer | null> {
  const cached = verifyCache.get(token);
  if (cached && Date.now() - cached.at < VERIFY_CACHE_MS) return cached.verified;
  let response: Response;
  try {
    response = await centralFetch("/peer/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    logger.warn({ err }, "otium: central verify unreachable");
    return null;
  }
  const body = (await response.json().catch(() => null)) as (VerifiedPeer & { ok: boolean }) | null;
  if (!response.ok || !body?.ok) return null;
  const verified: VerifiedPeer = {
    workspaceId: body.workspaceId,
    fromCellId: body.fromCellId,
    fromNodeName: body.fromNodeName,
    fromIsPrimary: body.fromIsPrimary,
    expiresAt: body.expiresAt,
  };
  verifyCache.set(token, { verified, at: Date.now() });
  // Opportunistic sweep — the cache only ever holds a handful of live tokens.
  for (const [key, entry] of verifyCache) {
    if (Date.now() - entry.at > VERIFY_CACHE_MS) verifyCache.delete(key);
  }
  return verified;
}

/** Test hook — caches are module singletons. */
export function resetPeerCentralCaches(): void {
  nodesCache = null;
  verifyCache.clear();
  tokenCache.clear();
}
