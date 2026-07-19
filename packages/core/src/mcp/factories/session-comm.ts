import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpErrorResponse, McpResponse } from "#mcp/mcp-helpers";
import type { SessionCommContext } from "#mcp/session-comm/context";

type MaybePromise<T> = T | Promise<T>;
export type SessionCommMcpResult = McpResponse | McpErrorResponse;

export interface SessionCommMcpHost {
  listSessions(context: SessionCommContext): MaybePromise<SessionCommMcpResult>;
  configureMcp(
    context: SessionCommContext,
    enabled: readonly string[] | null | undefined,
  ): MaybePromise<SessionCommMcpResult>;
  getMcpConfig(context: SessionCommContext): MaybePromise<SessionCommMcpResult>;
  getBrowserProfile?(context: SessionCommContext): MaybePromise<SessionCommMcpResult>;
  setBrowserProfile?(
    context: SessionCommContext,
    profile: string,
  ): MaybePromise<SessionCommMcpResult>;
  peekSession(context: SessionCommContext): MaybePromise<SessionCommMcpResult>;
  setDescription(
    context: SessionCommContext,
    description: string,
  ): MaybePromise<SessionCommMcpResult>;
  askSession(
    context: SessionCommContext,
    input: { to: string; message: string },
  ): MaybePromise<SessionCommMcpResult>;
  abortSession(context: SessionCommContext, to: string): MaybePromise<SessionCommMcpResult>;
  tellSession(
    context: SessionCommContext,
    input: { to: string; message: string },
  ): MaybePromise<SessionCommMcpResult>;
}

export interface SessionCommMcpOptions {
  requiredMcpServers?: readonly string[];
  optionalMcpServers?: readonly string[];
}

/** Register the shared session communication tool surface without reading process or storage state. */
export function createSessionCommMcpServer(
  context: SessionCommContext,
  host: SessionCommMcpHost,
  options: SessionCommMcpOptions = {},
): McpServer {
  const server = new McpServer({ name: "session-comm", version: "2.0.0" });
  const required = options.requiredMcpServers?.join(", ") || "none";
  const optional = options.optionalMcpServers?.join(", ") || "none";

  server.tool(
    "list_sessions",
    "List available sessions and remote peer sessions for inter-session communication.",
    {},
    async () => host.listSessions(context),
  );
  server.tool(
    "configure_mcp",
    `Configure optional MCP servers for the current topic. Required: ${required}. Optional: ${optional}.`,
    {
      enabled: z.array(z.string()).nullable().optional(),
    },
    async ({ enabled }) => host.configureMcp(context, enabled),
  );
  server.tool("get_mcp_config", "Get the current topic MCP configuration.", {}, async () =>
    host.getMcpConfig(context),
  );
  if (host.getBrowserProfile) {
    server.tool(
      "get_browser_profile",
      "Get this topic's browser profile and the profiles owned by the same user.",
      {},
      async () => host.getBrowserProfile!(context),
    );
  }
  if (host.setBrowserProfile) {
    server.tool(
      "set_browser_profile",
      "Assign this topic to a named shared browser profile. Takes effect next turn.",
      { profile: z.string() },
      async ({ profile }) => host.setBrowserProfile!(context, profile),
    );
  }
  server.tool(
    "peek_session",
    "Inspect running and idle sessions, including pending ask_session calls.",
    {},
    async () => host.peekSession(context),
  );
  server.tool(
    "set_description",
    "Set the current session description used as a routing hint.",
    { description: z.string() },
    async ({ description }) => host.setDescription(context, description),
  );

  if (!context.replyOnly) {
    server.tool(
      "ask_session",
      "Ask another local or remote session a question and wait for its answer.",
      { to: z.string(), message: z.string() },
      async (input) => host.askSession(context, input),
    );
    server.tool(
      "abort_session",
      "Abort the active query in another session.",
      { to: z.string() },
      async ({ to }) => host.abortSession(context, to),
    );
    server.tool(
      "tell_session",
      "Send a one-way message to another local or remote session.",
      { to: z.string(), message: z.string() },
      async (input) => host.tellSession(context, input),
    );
  }

  return server;
}
