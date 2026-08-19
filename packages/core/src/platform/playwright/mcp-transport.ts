import type { AgentKind } from "#types";

import { browserOwnerCapability } from "./capability";

export const CODEX_BROWSER_CAPABILITY_ENV = "NEGOTIUM_BROWSER_CAPABILITY";

/** Build the authenticated Browser.rs transport for one agent turn. */
export function buildPlaywrightMcpTransport(
  port: number,
  owner: string,
  capability: string,
  agent?: AgentKind,
): Record<string, unknown> {
  const query = new URLSearchParams({ owner });
  const ownerCapability = browserOwnerCapability(capability, owner);

  if (agent === "codex") {
    return {
      url: `http://127.0.0.1:${port}/mcp?${query}`,
      env_http_headers: { "X-Browser-Capability": CODEX_BROWSER_CAPABILITY_ENV },
    };
  }
  if (agent === "maestro") {
    return {
      type: "http" as const,
      url: `http://127.0.0.1:${port}/mcp?${query}`,
      headers: { "X-Browser-Capability": ownerCapability },
    };
  }
  return {
    type: "sse" as const,
    url: `http://127.0.0.1:${port}/sse?${query}`,
    headers: { "X-Browser-Capability": ownerCapability },
  };
}
