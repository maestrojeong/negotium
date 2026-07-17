import type { McpToolResult } from "#agents/mcp-tools/common";
import type { AgentKind, PeerRuntimeBridgeContext } from "#types";

export interface PeerRuntimeSpawnRequest {
  bridge: PeerRuntimeBridgeContext;
  userId: string;
  agent: AgentKind;
  model?: string;
  input: Record<string, unknown>;
}

export interface PeerRuntimeVisualRequest {
  bridge: PeerRuntimeBridgeContext;
  userId: string;
  agent: AgentKind;
  model?: string;
  kind: "html" | "mermaid" | "image" | "video";
  title?: string;
  html?: string;
  code?: string;
  theme?: string;
  fileId?: string;
  mimeType?: string;
  source?: string;
}

export type PeerRuntimeVisualResult =
  | { ok: true; id: number; url: string; title: string | null }
  | { ok: false; error: string };

export interface PeerRuntimeFileRequest {
  bridge: PeerRuntimeBridgeContext;
  userId: string;
  agent: AgentKind;
  model?: string;
  path: string;
  source: string;
}

export interface PeerRuntimeAskUserRequest {
  bridge: PeerRuntimeBridgeContext;
  userId: string;
  agent: AgentKind;
  model?: string;
  input: Record<string, unknown>;
}

export interface PeerRuntimeSelfConfigRequest {
  bridge: PeerRuntimeBridgeContext;
  userId: string;
  tool: string;
  input: Record<string, unknown>;
  currentUserPrompt?: string;
}

export interface PeerRuntimeBridge {
  spawnSubagent(request: PeerRuntimeSpawnRequest): Promise<McpToolResult>;
  /** Wait until already-broadcast runtime events for this local turn have
   *  reached the canonical host before an out-of-band bridge mutation. */
  flushEvents?(localTopicId: string): Promise<boolean>;
  showVisual?(request: PeerRuntimeVisualRequest): Promise<PeerRuntimeVisualResult>;
  sendFile?(request: PeerRuntimeFileRequest): Promise<{ ok: true } | { ok: false; error: string }>;
  askUser?(request: PeerRuntimeAskUserRequest): Promise<McpToolResult>;
  selfConfig?(request: PeerRuntimeSelfConfigRequest): Promise<McpToolResult>;
}

export function flushPeerRuntimeEvents(localTopicId: string): Promise<boolean> {
  return activeBridge?.flushEvents?.(localTopicId) ?? Promise.resolve(true);
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

export function dispatchPeerRuntimeVisual(
  request: PeerRuntimeVisualRequest,
): Promise<PeerRuntimeVisualResult> | null {
  return activeBridge?.showVisual?.(request) ?? null;
}

export function dispatchPeerRuntimeFile(
  request: PeerRuntimeFileRequest,
): Promise<{ ok: true } | { ok: false; error: string }> | null {
  return activeBridge?.sendFile?.(request) ?? null;
}

export function dispatchPeerRuntimeAskUser(
  request: PeerRuntimeAskUserRequest,
): Promise<McpToolResult> | null {
  return activeBridge?.askUser?.(request) ?? null;
}

export function dispatchPeerRuntimeSelfConfig(
  request: PeerRuntimeSelfConfigRequest,
): Promise<McpToolResult> | null {
  return activeBridge?.selfConfig?.(request) ?? null;
}
