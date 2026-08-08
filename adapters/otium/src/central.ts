/**
 * Central peer API client — token mint/verify and node discovery. Port of
 * otium's `apps/runtime-api/src/peer/central.ts` (identical cache policy) with
 * `hostedRuntimeConfig()` replaced by the adapter's join credentials. A cell
 * secret never leaves this process; peers only ever see the short-lived `ptk_…`
 * tokens central mints here.
 *
 * Credentials are held **per attached cell** (M-5), not once for the process. A
 * node may be a member of several workspaces at the same time, and each one is
 * a separate Central account: its own secret, its own node list, its own tokens.
 * Sharing any of those across workspaces would either authenticate a call to
 * the wrong workspace or leak one workspace's topology into another.
 *
 * Every discovered node therefore records `viaCellId` — the local cell that can
 * see it. Callers do not have to know which workspace a peer belongs to; they
 * carry the node they resolved, and the client uses its credentials.
 */

import { logger } from "@negotium/core";
import type { OtiumJoin } from "@/join";

export interface PeerNode {
  cellId: string;
  nodeName: string | null;
  isPrimary: boolean;
  baseUrl: string;
  self: boolean;
  /** The local cell whose workspace this node was discovered in. */
  viaCellId: string;
}

export interface VerifiedPeer {
  workspaceId: string;
  fromCellId: string;
  fromNodeName: string | null;
  fromIsPrimary: boolean;
  expiresAt: string;
  /** Which of this node's cells the caller addressed (M-8). */
  viaCellId: string;
}

const NODES_CACHE_MS = 30_000;
/** Positive verify cache — deliberately short so assignment revocation bites
 *  within seconds, not the token TTL. */
const VERIFY_CACHE_MS = 30_000;

interface CellState {
  join: OtiumJoin;
  nodesCache: { nodes: PeerNode[]; workspaceId: string; at: number } | null;
  verifyCache: Map<string, { verified: VerifiedPeer; at: number }>;
  tokenCache: Map<string, { token: string; expiresAtMs: number }>;
}

/** Attached cells in join order; the first is the one single-join callers mean. */
const cells = new Map<string, CellState>();

function cellState(cellId: string): CellState | null {
  return cells.get(cellId) ?? null;
}

function firstCell(): CellState | null {
  for (const cell of cells.values()) return cell;
  return null;
}

/** Attach one cell's credentials. Re-attaching the same cell replaces them. */
export function attachOtiumCentralCell(join: OtiumJoin): void {
  cells.set(join.cellId, {
    join,
    nodesCache: null,
    verifyCache: new Map(),
    tokenCache: new Map(),
  });
}

/** Detach one cell, dropping its credentials and everything cached for it. */
export function detachOtiumCentralCell(cellId: string): boolean {
  return cells.delete(cellId);
}

export function attachedOtiumCells(): OtiumJoin[] {
  return [...cells.values()].map((cell) => cell.join);
}

/**
 * Single-join entry point: make this the only attached cell, or detach all.
 *
 * Kept because most of the runtime still assumes one workspace; multi-join
 * hosts call {@link attachOtiumCentralCell} per workspace instead.
 */
export function configureOtiumCentral(join: OtiumJoin | null): void {
  cells.clear();
  if (join) attachOtiumCentralCell(join);
}

/** The join of the single attached cell, or null when this node is attached to none. */
export function otiumCentralConfig(): OtiumJoin | null {
  return firstCell()?.join ?? null;
}

/** True when this node speaks for at least one workspace. */
export function isOtiumCentralConfigured(): boolean {
  return cells.size > 0;
}

function centralFetch(cell: CellState, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${cell.join.central}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cell.join.secret}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(5000),
  });
}

async function discover(cell: CellState, fresh: boolean): Promise<PeerNode[]> {
  if (!fresh && cell.nodesCache && Date.now() - cell.nodesCache.at < NODES_CACHE_MS) {
    return cell.nodesCache.nodes;
  }
  const response = await centralFetch(cell, "/peer/nodes", { method: "GET" });
  const body = (await response.json()) as {
    ok: boolean;
    error?: string;
    workspaceId?: string;
    nodes?: Array<Omit<PeerNode, "viaCellId">>;
  };
  if (!response.ok || !body.ok || !Array.isArray(body.nodes)) {
    throw new Error(`otium: node discovery failed: ${body.error ?? response.status}`);
  }
  const nodes = body.nodes.map((node) => ({ ...node, viaCellId: cell.join.cellId }));
  cell.nodesCache = { nodes, workspaceId: body.workspaceId ?? "", at: Date.now() };
  return nodes;
}

/** Active nodes of one cell's workspace (30s cache; pass fresh=true after a
 *  resolution miss so a just-attached node is visible). */
export async function listPeerNodesForCell(
  cellId: string,
  opts: { fresh?: boolean } = {},
): Promise<PeerNode[]> {
  const cell = cellState(cellId);
  if (!cell) throw new Error(`otium: not attached to cell ${cellId}`);
  return discover(cell, opts.fresh === true);
}

/**
 * Every node this process can reach, across every attached workspace.
 *
 * One unreachable Central must not blank out the other workspaces, so a failing
 * cell is logged and skipped rather than rejecting the whole list — except when
 * *every* cell fails, which is indistinguishable from the single-join outage
 * callers already handle by rejecting.
 */
export async function listPeerNodes(opts: { fresh?: boolean } = {}): Promise<PeerNode[]> {
  if (cells.size === 0) throw new Error("otium: join credentials missing");
  const results = await Promise.allSettled(
    [...cells.values()].map((cell) => discover(cell, opts.fresh === true)),
  );
  const nodes = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length === results.length) {
    throw (failures[0] as PromiseRejectedResult).reason;
  }
  for (const failure of failures) {
    logger.warn({ err: (failure as PromiseRejectedResult).reason }, "otium: discovery failed");
  }
  return nodes;
}

/** This node's own entry in one workspace. Node identity is per workspace, so
 *  a caller acting on a peer must ask about the cell that peer was found through. */
export async function selfPeerNodeForCell(cellId: string): Promise<PeerNode | null> {
  const nodes = await listPeerNodesForCell(cellId);
  return nodes.find((node) => node.self) ?? null;
}

export async function selfPeerNode(): Promise<PeerNode | null> {
  const cell = firstCell();
  if (!cell) throw new Error("otium: join credentials missing");
  return selfPeerNodeForCell(cell.join.cellId);
}

/**
 * The workspace one cell belongs to, as Central reports it.
 *
 * The invite code carries a seat (`cellId`), never the workspace, so this is
 * the only way a node can learn which workspace it is attached to (M-3). It
 * rides on the discovery call the node already makes rather than adding a
 * round-trip of its own.
 */
export async function peerWorkspaceIdForCell(cellId: string): Promise<string | null> {
  const cell = cellState(cellId);
  if (!cell) return null;
  if (!cell.nodesCache) await discover(cell, false);
  return cell.nodesCache?.workspaceId || null;
}

export async function peerWorkspaceId(): Promise<string | null> {
  const cell = firstCell();
  return cell ? peerWorkspaceIdForCell(cell.join.cellId) : null;
}

/** Find a peer by cell id in whichever attached workspace can see it. */
export async function resolvePeerNodeByCellId(cellId: string): Promise<PeerNode | null> {
  const find = (nodes: PeerNode[]) => nodes.find((node) => node.cellId === cellId) ?? null;
  const cached = find(await listPeerNodes());
  if (cached) return cached;
  return find(await listPeerNodes({ fresh: true }));
}

/**
 * Mint (or reuse a still-fresh) peer token for one target node.
 *
 * Takes the resolved node rather than a bare cell id: the token must be minted
 * by the local cell that shares a workspace with the target, and only the node
 * record knows which one that was.
 */
export async function mintPeerToken(target: PeerNode): Promise<string> {
  const cell = cellState(target.viaCellId);
  if (!cell) throw new Error("otium: join credentials missing");
  const cached = cell.tokenCache.get(target.cellId);
  if (cached && cached.expiresAtMs - Date.now() > 30_000) return cached.token;
  const response = await centralFetch(cell, "/peer/token", {
    method: "POST",
    body: JSON.stringify({ toCellId: target.cellId }),
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
  cell.tokenCache.set(target.cellId, {
    token: body.token,
    expiresAtMs: Date.parse(body.expiresAt ?? "") || Date.now() + 60_000,
  });
  return body.token;
}

async function verifyAgainstCell(cell: CellState, token: string): Promise<VerifiedPeer | null> {
  const cached = cell.verifyCache.get(token);
  if (cached && Date.now() - cached.at < VERIFY_CACHE_MS) return cached.verified;
  let response: Response;
  try {
    response = await centralFetch(cell, "/peer/verify", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    logger.warn({ err, cellId: cell.join.cellId }, "otium: central verify unreachable");
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
    viaCellId: cell.join.cellId,
  };
  cell.verifyCache.set(token, { verified, at: Date.now() });
  // Opportunistic sweep — the cache only ever holds a handful of live tokens.
  for (const [key, entry] of cell.verifyCache) {
    if (Date.now() - entry.at > VERIFY_CACHE_MS) cell.verifyCache.delete(key);
  }
  return verified;
}

/**
 * Verify an inbound peer token (fail-closed on outages).
 *
 * A token is addressed to one of this node's cells, and only that cell's
 * Central will accept it, so trying each attached cell in turn both identifies
 * the addressed workspace and authenticates the caller in a single step (M-8).
 * The result names that cell, and callers must refuse to touch a room outside
 * its workspace.
 */
export async function verifyPeerToken(token: string): Promise<VerifiedPeer | null> {
  for (const cell of cells.values()) {
    const verified = await verifyAgainstCell(cell, token);
    if (verified) return verified;
  }
  return null;
}

/** Test hook — cell state is a module singleton. */
export function resetPeerCentralCaches(): void {
  for (const cell of cells.values()) {
    cell.nodesCache = null;
    cell.verifyCache.clear();
    cell.tokenCache.clear();
  }
}
