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

/**
 * Servers that are a TypeScript entry file a host can spawn. `background-bash`
 * is still an MCP server name, but it is served by the bash-rs binary over
 * HTTP, so asking for its file is a mistake the type system should catch.
 */
export type McpServerFileName = Exclude<McpServerName, "background-bash">;

const runtimeFile = (relativePath: string): string =>
  fileURLToPath(new URL(`./runtime/${relativePath}`, import.meta.url));

/** Absolute executable TypeScript entry files for Negotium's STDIO MCP servers. */
export const MCP_SERVER_FILES: Readonly<Record<McpServerFileName, string>> = Object.freeze({
  "agent-health": runtimeFile("src/mcp/agent-health-server.ts"),
  "canonical-proxy": runtimeFile("src/mcp/canonical-proxy-server.ts"),
  "cron-manager": runtimeFile("cron/mcp-server.ts"),
  "session-comm": runtimeFile("src/mcp/session-comm/server.ts"),
  "system-health": runtimeFile("src/mcp/system-health-server.ts"),
  task: runtimeFile("src/mcp/task-server.ts"),
  "token-stats": runtimeFile("src/mcp/token-stats-server.ts"),
  vault: runtimeFile("src/mcp/vault-server.ts"),
  wiki: runtimeFile("src/mcp/wiki-server.ts"),
});

export function resolveMcpServerFile(name: McpServerFileName): string {
  return MCP_SERVER_FILES[name];
}

/** tsconfig used when a host launches the TypeScript server through node + tsx. */
export function resolveMcpServerTsconfig(name: McpServerFileName): string {
  const file = resolveMcpServerFile(name);
  const levels = name === "cron-manager" ? ".." : name === "session-comm" ? "../../.." : "../..";
  return resolve(dirname(file), levels, "tsconfig.json");
}
