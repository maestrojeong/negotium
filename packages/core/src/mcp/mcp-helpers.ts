/** Shared MCP tool response helpers — reduce boilerplate for the common text response shape. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export type McpContent = { type: "text"; text: string };
export type McpResponse = { content: McpContent[] };
export type McpErrorResponse = { content: McpContent[]; isError: true };

export function mcpOk(text: string): McpResponse {
  return { content: [{ type: "text", text }] };
}

export function mcpError(text: string): McpErrorResponse {
  return { content: [{ type: "text", text }], isError: true };
}

/** Wire up an McpServer to stdio and start the listener. Standard entrypoint for stdio-based MCP servers. */
export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Parse the `--user-id=<N>` CLI flag from argv and return the raw decimal
 * string. Returns empty string on missing/invalid values so callers can
 * retain their existing "userId || default" guards.
 *
 * Rejects unsafe values so the id stays usable as a storage key / process arg
 * if spawn args ever come from an untrusted source.
 */
export function parseUserIdArg(args: string[]): string {
  const raw = args.find((a) => a.startsWith("--user-id="))?.split("=")[1];
  if (!raw) return "";
  // REST API user ids can contain letters, dashes, underscores, and dots.
  // Restrict to a safe charset and reject path-traversal so the value stays
  // safe as a storage key / process arg.
  if (!/^[A-Za-z0-9._-]+$/.test(raw) || raw.includes("..")) return "";
  return raw;
}
