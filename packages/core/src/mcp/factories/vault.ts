import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { executeVaultHttpRequest, type VaultHttpRequest } from "#mcp/vault-http";
import { executeVaultRun, type VaultRunRequest } from "#mcp/vault-run";
import { mcpError, mcpOk } from "../mcp-helpers";
import type { VaultCredentialHost } from "./vault-host";

export interface VaultMcpContext {
  userId?: string;
  httpOnly?: boolean;
  cwd?: string;
}

export interface VaultMcpExecutors {
  run?(
    userId: string,
    request: VaultRunRequest,
    host: VaultCredentialHost,
  ): ReturnType<typeof executeVaultRun>;
  http?(
    userId: string,
    request: VaultHttpRequest,
    host: VaultCredentialHost,
  ): ReturnType<typeof executeVaultHttpRequest>;
}

export function createVaultMcpServer(
  context: VaultMcpContext,
  host: VaultCredentialHost,
  executors: VaultMcpExecutors = {},
): McpServer {
  const server = new McpServer({ name: "vault", version: "1.0.0" });
  const run = executors.run ?? executeVaultRun;
  const http = executors.http ?? executeVaultHttpRequest;

  server.tool(
    "vault_list",
    context.httpOnly
      ? "List the user's Vault keys and descriptions without exposing values. Use vault_http_request for HTTPS APIs that need a credential."
      : "List the user's Vault keys and descriptions without exposing values. Use vault_http_request for APIs and vault_run for shell/CLI work that needs a credential.",
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

  if (!context.httpOnly) {
    server.tool(
      "vault_run",
      "Run a shell command containing {{KEY}} references inside Otium's credential broker. Expanded command input never reaches the model/provider, and stdout/stderr are redacted before return. Prefer vault_http_request for HTTP APIs.",
      {
        command: z
          .string()
          .min(1)
          .max(64 * 1024),
        timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
        max_output_bytes: z
          .number()
          .int()
          .min(1_024)
          .max(2 * 1024 * 1024)
          .optional(),
      },
      async ({ command, timeout_ms, max_output_bytes }) => {
        if (!context.userId) return mcpError("Vault unavailable: no user context");
        const result = await run(
          context.userId,
          {
            command,
            timeoutMs: timeout_ms,
            maxOutputBytes: max_output_bytes,
            cwd: context.cwd,
          },
          host,
        );
        return result.error && result.exitCode === null
          ? mcpError(result.error)
          : mcpOk(JSON.stringify(result, null, 2));
      },
    );
  }

  server.tool(
    "vault_http_request",
    "Make an HTTPS request with {{KEY}} references resolved inside Otium. Put secrets in headers or body, never in the URL. The expanded request is not returned; the response is redacted before the model sees it.",
    {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      url: z.string().url().describe("Absolute HTTPS URL without Vault placeholders"),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      timeout_ms: z.number().int().min(1_000).max(120_000).optional(),
      max_response_bytes: z
        .number()
        .int()
        .min(1_024)
        .max(1024 * 1024)
        .optional(),
    },
    async ({ method, url, headers, body, timeout_ms, max_response_bytes }) => {
      if (!context.userId) return mcpError("Vault unavailable: no user context");
      const result = await http(
        context.userId,
        {
          method,
          url,
          headers,
          body,
          timeoutMs: timeout_ms,
          maxResponseBytes: max_response_bytes,
        },
        host,
      );
      return result.error ? mcpError(result.error) : mcpOk(JSON.stringify(result, null, 2));
    },
  );

  return server;
}

export type { VaultHttpRequest, VaultHttpResult } from "#mcp/vault-http";
export type { VaultRunRequest, VaultRunResult } from "#mcp/vault-run";
export type { VaultCredentialHost } from "./vault-host";
