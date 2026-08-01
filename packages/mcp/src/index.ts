/**
 * @negotium/mcp — the negotium MCP endpoint as an embeddable module.
 *
 * The runtime host process mounts `handleNegotiumMcpRequest` on its Bun.serve;
 * agents connect back via per-turn signed tokens minted by `buildRuntimeMcpSpec`
 * (re-exported from `@negotium/core` for host convenience).
 */

export {
  buildHostedMcpSpec,
  buildRuntimeMcpSpec,
  HOSTED_MCP_SURFACES,
  type HostedMcpContext,
  type HostedMcpSurface,
  RUNTIME_MCP_BASE_PATH,
  type RuntimeMcpContext,
} from "@negotium/core/mcp-runtime-host";
export { registerNodeTools } from "#node-tools";
export {
  buildNegotiumMcpServer,
  closeNegotiumMcpSessions,
  handleNegotiumMcpRequest,
} from "#server";
export { SseTransport } from "#sse-transport";
