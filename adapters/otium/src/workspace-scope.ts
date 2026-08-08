/**
 * Which Otium workspace a room belongs to (M-2).
 *
 * Rooms are namespaced per workspace, not per seat: `cellId` and `secret` are
 * reissued every time the owner re-invites this node, so keying rooms on them
 * would orphan the whole store on a routine re-join. The workspace id survives
 * that, and the Central origin is mixed in because two independent Otium
 * deployments may hand out the same workspace id.
 *
 * The hash exists only to keep the column short and opaque; both source values
 * stay in the cache file next to it, so the mapping is always reversible by a
 * human reading the disk.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DATA_DIR, logger } from "@negotium/core";
import { peerWorkspaceId } from "@/central";
import type { OtiumJoin } from "@/join";

export interface WorkspaceScopeRecord {
  central: string;
  workspaceId: string;
  scope: string;
}

export function surfaceScopeFor(central: string, workspaceId: string): string {
  const digest = createHash("sha256")
    .update(`${central.trim().replace(/\/+$/, "")}\n${workspaceId.trim()}`)
    .digest("hex");
  return `ws_${digest.slice(0, 24)}`;
}

function scopeCachePath(): string {
  return resolve(DATA_DIR, "otium-workspace.json");
}

function readCache(): Record<string, WorkspaceScopeRecord> {
  try {
    const parsed = JSON.parse(readFileSync(scopeCachePath(), "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, WorkspaceScopeRecord>;
  } catch {
    return {};
  }
}

/**
 * The scope resolved on an earlier run, if any.
 *
 * Without this a node would start every boot with no scope and file rooms
 * unscoped until Central answered — turning a transient outage into permanent
 * mis-filing. The cache is derived data: deleting it costs one discovery call.
 */
export function cachedSurfaceScope(join: OtiumJoin): string | null {
  const record = readCache()[join.cellId];
  if (!record || record.central !== join.central || !record.workspaceId) return null;
  return surfaceScopeFor(record.central, record.workspaceId);
}

function cacheSurfaceScope(join: OtiumJoin, workspaceId: string): string {
  const scope = surfaceScopeFor(join.central, workspaceId);
  const path = scopeCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const cache = readCache();
    cache[join.cellId] = { central: join.central, workspaceId, scope };
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    // A write failure only costs a discovery call on the next boot, so it must
    // not take the mount down with it.
    logger.warn({ err, path }, "otium: could not cache the workspace scope");
  }
  return scope;
}

/**
 * Resolve this join's scope, contacting Central only when it is not yet known.
 *
 * Returns null when Central is unreachable and nothing was cached — joining
 * stays an offline operation (M-3), so an unresolved scope is a normal state,
 * not an error.
 */
export async function resolveSurfaceScope(join: OtiumJoin): Promise<string | null> {
  const cached = cachedSurfaceScope(join);
  if (cached) return cached;
  try {
    const workspaceId = await peerWorkspaceId();
    if (!workspaceId) return null;
    return cacheSurfaceScope(join, workspaceId);
  } catch (err) {
    logger.warn({ err }, "otium: workspace scope unresolved (will retry on the next contact)");
    return null;
  }
}
