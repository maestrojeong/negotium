import type { PeerRuntimeBridgeContext } from "#types";

export type CanonicalMcpSurface = "task" | "wiki";

export interface CanonicalMcpBridgeScope {
  surface: CanonicalMcpSurface;
  userId: string;
  topicId: string;
  queryId: string;
  peerBridge: PeerRuntimeBridgeContext;
}

export interface CanonicalMcpBridgeEnvLease {
  env: Record<string, string>;
  /** Revoke the capability immediately. Must be safe to call more than once. */
  revoke(): void;
}

export type CanonicalMcpBridgeEnvProvider = (
  scope: CanonicalMcpBridgeScope,
) => CanonicalMcpBridgeEnvLease | undefined;

const registrations: Array<{ id: symbol; provider: CanonicalMcpBridgeEnvProvider }> = [];
const turnLeases = new Map<string, Set<() => void>>();

function turnKey(
  scope: Pick<CanonicalMcpBridgeScope, "userId" | "topicId" | "queryId" | "peerBridge">,
): string {
  return JSON.stringify([
    scope.userId,
    scope.topicId,
    scope.queryId,
    scope.peerBridge.hubCellId,
    scope.peerBridge.hostTopicId,
    scope.peerBridge.hostQueryId,
  ]);
}

/** Placement adapters install a scoped capability issuer without exposing
 * their hub discovery or authentication model to generic core. */
export function registerCanonicalMcpBridgeEnvProvider(
  provider: CanonicalMcpBridgeEnvProvider,
): () => void {
  const registration = { id: Symbol("canonical-mcp-bridge"), provider };
  registrations.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = registrations.findIndex((entry) => entry.id === registration.id);
    if (index >= 0) registrations.splice(index, 1);
  };
}

export function canonicalMcpBridgeEnv(
  scope: CanonicalMcpBridgeScope,
): Record<string, string> | undefined {
  const lease = registrations.at(-1)?.provider(scope);
  if (!lease) return undefined;
  const key = turnKey(scope);
  const leases = turnLeases.get(key) ?? new Set<() => void>();
  leases.add(lease.revoke);
  turnLeases.set(key, leases);
  return lease.env;
}

/** Revoke every canonical MCP capability issued while building one placed turn. */
export function revokeCanonicalMcpBridgeTurn(
  scope: Pick<CanonicalMcpBridgeScope, "userId" | "topicId" | "queryId" | "peerBridge">,
): number {
  const key = turnKey(scope);
  const leases = turnLeases.get(key);
  if (!leases) return 0;
  turnLeases.delete(key);
  for (const revoke of leases) {
    try {
      revoke();
    } catch {
      // Revocation is best-effort across independently owned bridge adapters;
      // continue so one broken disposer cannot preserve sibling capabilities.
    }
  }
  return leases.size;
}
