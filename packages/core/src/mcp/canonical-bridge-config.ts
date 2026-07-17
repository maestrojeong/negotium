import type { PeerRuntimeBridgeContext } from "#types";

export type CanonicalMcpSurface = "task" | "wiki";

export interface CanonicalMcpBridgeScope {
  surface: CanonicalMcpSurface;
  userId: string;
  topicId: string;
  queryId: string;
  peerBridge: PeerRuntimeBridgeContext;
}

export type CanonicalMcpBridgeEnvProvider = (
  scope: CanonicalMcpBridgeScope,
) => Record<string, string> | undefined;

const registrations: Array<{ id: symbol; provider: CanonicalMcpBridgeEnvProvider }> = [];

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
  return registrations.at(-1)?.provider(scope);
}
