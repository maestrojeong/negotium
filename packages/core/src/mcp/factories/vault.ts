import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VaultEntry } from "#storage/vault";
import { mcpOk } from "../mcp-helpers";

export interface VaultMcpContext {
  userId?: string;
}

export interface VaultMcpHost {
  list(userId: string): readonly VaultEntry[];
}

export function createVaultMcpServer(context: VaultMcpContext, host: VaultMcpHost): McpServer {
  const server = new McpServer({ name: "vault", version: "1.0.0" });

  server.tool(
    "vault_list",
    "List the user's Vault keys and descriptions without exposing values. Use {{KEY}} placeholders directly in supported transient tool inputs.",
    {},
    () => {
      if (!context.userId) return mcpOk("(vault unavailable: no user context)");
      const entries = host.list(context.userId);
      if (entries.length === 0) return mcpOk("Vault is empty. No keys stored yet.");
      const lines = entries.map((entry) =>
        entry.description ? `• ${entry.key} — ${entry.description}` : `• ${entry.key}`,
      );
      return mcpOk(`Vault keys (${entries.length}):\n${lines.join("\n")}`);
    },
  );

  return server;
}
