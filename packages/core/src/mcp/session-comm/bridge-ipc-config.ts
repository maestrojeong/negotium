export interface PeerSessionBridgeIpcConfig {
  url: string;
  token: string;
}

const registrations: Array<{ id: symbol; config: PeerSessionBridgeIpcConfig }> = [];

export function registerPeerSessionBridgeIpcConfig(config: PeerSessionBridgeIpcConfig): () => void {
  const registration = { id: Symbol("peer-session-bridge-ipc"), config: { ...config } };
  registrations.push(registration);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const index = registrations.findIndex((entry) => entry.id === registration.id);
    if (index >= 0) registrations.splice(index, 1);
  };
}

export function peerSessionBridgeIpcEnv(): Record<string, string> | undefined {
  const active = registrations.at(-1)?.config;
  if (!active) return undefined;
  return {
    NEGOTIUM_PEER_SESSION_BRIDGE_URL: active.url,
    NEGOTIUM_PEER_SESSION_BRIDGE_TOKEN: active.token,
  };
}
