import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_SERVER_NAMES = [
  "agent-health",
  "background-bash",
  "canonical-proxy",
  "cron-manager",
  "session-comm",
  "system-health",
  "task",
  "token-stats",
  "vault",
  "wiki",
] as const;

export type McpServerName = (typeof MCP_SERVER_NAMES)[number];

const runtimeFile = (relativePath: string): string =>
  fileURLToPath(new URL(`./runtime/${relativePath}`, import.meta.url));

/** Absolute executable TypeScript entry files for Negotium's STDIO MCP servers. */
export const MCP_SERVER_FILES: Readonly<Record<McpServerName, string>> = Object.freeze({
  "agent-health": runtimeFile("src/mcp/agent-health-server.ts"),
  "background-bash": runtimeFile("src/mcp/background-bash-server.ts"),
  "canonical-proxy": runtimeFile("src/mcp/canonical-proxy-server.ts"),
  "cron-manager": runtimeFile("cron/mcp-server.ts"),
  "session-comm": runtimeFile("src/mcp/session-comm/server.ts"),
  "system-health": runtimeFile("src/mcp/system-health-server.ts"),
  task: runtimeFile("src/mcp/task-server.ts"),
  "token-stats": runtimeFile("src/mcp/token-stats-server.ts"),
  vault: runtimeFile("src/mcp/vault-server.ts"),
  wiki: runtimeFile("src/mcp/wiki-server.ts"),
});

export function resolveMcpServerFile(name: McpServerName): string {
  return MCP_SERVER_FILES[name];
}

/** tsconfig used when a host launches the TypeScript server through node + tsx. */
export function resolveMcpServerTsconfig(name: McpServerName): string {
  const file = resolveMcpServerFile(name);
  const levels = name === "cron-manager" ? ".." : name === "session-comm" ? "../../.." : "../..";
  return resolve(dirname(file), levels, "tsconfig.json");
}
