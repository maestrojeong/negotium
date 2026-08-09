export const OTIUM_ADAPTER_CONTROL_PREFIX = "/api/v1/adapter/otium";
export const OTIUM_ADAPTER_CONTROL_HEADER = "x-negotium-adapter-token";
/**
 * Local administration of the node's workspace attachments (M-7).
 *
 * Deliberately outside `/api/v1/peer/`: it is reachable only over the
 * authenticated loopback control prefix, never from a peer, because it changes
 * which workspaces this node serves.
 */
export const OTIUM_WORKSPACES_CONTROL_PATH = "/_workspaces";

/**
 * Marks a request that arrived from the public relay through the sidecar.
 *
 * The sidecar authenticates to the node with the host capability, so the node
 * cannot otherwise tell a relayed caller from a local one. Routes that
 * administer this node refuse anything carrying it.
 */
export const OTIUM_RELAYED_HEADER = "x-negotium-otium-relayed";
