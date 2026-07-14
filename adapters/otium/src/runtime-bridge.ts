/** Worker-side runtime MCP mutations that must execute on Otium's canonical hub. */

import { errorResult, logger, type McpToolResult, type PeerRuntimeBridge } from "@negotium/core";
import { mintPeerToken, resolvePeerNodeByCellId } from "@/central";

const PEER_BRIDGE_TIMEOUT_MS = 15_000;

function isMcpToolResult(value: unknown): value is McpToolResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Partial<McpToolResult>;
  return (
    Array.isArray(result.content) &&
    result.content.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        (entry as { type?: unknown }).type === "text" &&
        typeof (entry as { text?: unknown }).text === "string",
    ) &&
    (result.isError === undefined || result.isError === true)
  );
}

export const otiumPeerRuntimeBridge: PeerRuntimeBridge = {
  async spawnSubagent(request) {
    const hubNode = await resolvePeerNodeByCellId(request.bridge.hubCellId).catch(() => null);
    if (!hubNode) return errorResult("Error: Hub node is no longer attached.");

    let token: string;
    try {
      token = await mintPeerToken(hubNode.cellId);
    } catch (err) {
      return errorResult(`Error: Failed to spawn on hub: ${(err as Error).message}`);
    }

    let response: Response;
    try {
      response = await fetch(`${hubNode.baseUrl.replace(/\/+$/, "")}/api/v1/peer/bridge/spawn`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostQueryId: request.bridge.hostQueryId,
          userId: request.userId,
          agent: request.agent,
          ...(request.model ? { model: request.model } : {}),
          input: request.input,
        }),
        signal: AbortSignal.timeout(PEER_BRIDGE_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ err, node: hubNode.nodeName }, "otium: spawn bridge hub unreachable");
      return errorResult(
        `Error: Failed to spawn on hub: node "${hubNode.nodeName ?? hubNode.cellId}" unreachable`,
      );
    }

    const parsed = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      result?: unknown;
    } | null;
    if (!response.ok || !parsed?.ok) {
      return errorResult(
        `Error: Failed to spawn on hub: ${parsed?.error ?? `peer call failed (${response.status})`}`,
      );
    }
    if (!isMcpToolResult(parsed.result)) {
      return errorResult("Error: Failed to spawn on hub: invalid tool result");
    }
    return parsed.result;
  },
};
