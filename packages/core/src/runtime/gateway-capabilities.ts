/**
 * Extra `GET /health` capability strings contributed by whatever is loaded
 * alongside the node — an adapter that forwards a new gateway route over its
 * relay, for instance. The core route list is fixed in `control.ts`; this
 * registry lets a host advertise a capability only when the piece that makes
 * it true is actually present, so a hub can tell "the node supports it" from
 * "the node *and* its relay support it".
 */
const registered = new Set<string>();

export function registerRuntimeGatewayCapability(name: string): () => void {
  const capability = name.trim();
  if (!capability) throw new Error("capability name is required");
  registered.add(capability);
  return () => {
    registered.delete(capability);
  };
}

export function listRuntimeGatewayCapabilities(): string[] {
  return [...registered].sort();
}
