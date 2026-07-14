import type { McpToolResult } from "#agents/mcp-tools/common";
import type { AgentKind, PeerRuntimeBridgeContext } from "#types";

export interface PeerRuntimeSpawnRequest {
  bridge: PeerRuntimeBridgeContext;
  userId: string;
  agent: AgentKind;
  model?: string;
  input: Record<string, unknown>;
}

export interface PeerRuntimeBridge {
  spawnSubagent(request: PeerRuntimeSpawnRequest): Promise<McpToolResult>;
}

let activeBridge: PeerRuntimeBridge | null = null;

/**
 * Install the channel/placement adapter that owns remote runtime mutations.
 * Core carries the per-turn bridge identity, but deliberately does not know
 * how a workspace hub is discovered or authenticated.
 */
export function registerPeerRuntimeBridge(bridge: PeerRuntimeBridge): () => void {
  activeBridge = bridge;
  return () => {
    if (activeBridge === bridge) activeBridge = null;
  };
}

/** Returns null when no placement adapter is active. */
export function dispatchPeerRuntimeSpawn(
  request: PeerRuntimeSpawnRequest,
): Promise<McpToolResult> | null {
  return activeBridge?.spawnSubagent(request) ?? null;
}
