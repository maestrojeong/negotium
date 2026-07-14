/**
 * otium peer protocol — payload shapes exchanged between workspace runtime
 * nodes. Field-for-field copy of otium's
 * `apps/runtime-api/src/peer/protocol.ts` (PEER_PROTOCOL_VERSION 1): the hub
 * trusts these shapes without schema validation, so this file must track the
 * otium side exactly.
 */

export const PEER_PROTOCOL_VERSION = 1;

export const MAX_PEER_MESSAGE_LENGTH = 10_000;

export interface PeerSessionEntry {
  topicId: string;
  name: string;
  agent: string | null;
  hasSession: boolean;
  description?: string;
}

/** Fully-resolved room configuration pinned by the hub for one worker turn.
 *  The worker must not re-resolve these values from its hidden mirror topic. */
export interface PlacedTopicExecutionSpec {
  agent: string;
  model: string;
  effort: string;
  description?: string;
  /** Optional MCP whitelist after hub-side topic override resolution. */
  mcp: string[];
  /** Preserves the host room's real top-level delegation capability. */
  canSpawnSubagents: boolean;
}

/** Hub → worker: run one turn of a hub-hosted agent room. */
export interface PeerTurnRequest {
  v: number;
  requestId: string;
  userId: string;
  /** The hub's canonical topic id — the worker keys its hidden topic on it. */
  hostTopicId: string;
  /** Room title, mirrored onto the hidden topic so tell/ask by title works. */
  topicTitle: string;
  execution?: PlacedTopicExecutionSpec;
  /** Legacy additive fields accepted during rolling upgrades. */
  agent?: string;
  model?: string;
  effort?: string;
  /** File ids already copied into the worker hidden topic's upload store. */
  attachments?: string[];
  message: string;
}

/** Hub → worker: create/update the hidden mirror before the first turn. */
export interface PeerProvisionRequest {
  v: number;
  userId: string;
  hostTopicId: string;
  topicTitle: string;
  execution: PlacedTopicExecutionSpec;
}

/** Worker → hub: one coarse turn event, ordered by seq per requestId. */
export interface PeerEventRequest {
  v: number;
  requestId: string;
  seq: number;
  event: Record<string, unknown>;
}

function str(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Parse and normalize an inbound execution spec (mirrors otium routes.ts). */
export function parseExecutionSpec(value: unknown): PlacedTopicExecutionSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const agent = str(raw, "agent");
  const model = str(raw, "model");
  const effort = str(raw, "effort");
  const rawMcp = raw.mcp;
  if (
    !agent ||
    !model ||
    !effort ||
    !Array.isArray(rawMcp) ||
    !rawMcp.every((entry) => typeof entry === "string" && entry.trim().length > 0) ||
    typeof raw.canSpawnSubagents !== "boolean"
  ) {
    return null;
  }
  return {
    agent,
    model,
    effort,
    ...(str(raw, "description") ? { description: str(raw, "description") as string } : {}),
    mcp: [...new Set(rawMcp.map((entry) => entry.trim()))],
    canSpawnSubagents: raw.canSpawnSubagents,
  };
}
