/**
 * The negotium runtime MCP server — the single HTTP MCP endpoint that makes a
 * machine's negotium runtime usable by any agent host.
 *
 * This is a module, not a standalone process: the runtime host (CLI daemon,
 * Telegram bot, …) imports `handleNegotiumMcpRequest` and mounts it on its
 * Bun.serve. Agents connect back with per-turn signed tokens issued by
 * `@negotium/core`'s `buildRuntimeMcpSpec`, so the MCP layer never trusts the
 * agent to say who it is.
 *
 * Ported from otium runtime-api `mcp/runtime-server.ts`; placement adapters
 * may install peer-bridge handlers for canonical hub mutations (currently
 * spawn_subagent), while token/spec logic lives in `@negotium/core`.
 */

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  appendApiMessage,
  appendJsonlEntry,
  createAskUserToolDefinition,
  createSelfConfigToolDefinitions,
  createSpawnSubagentToolDefinition,
  dispatchPeerRuntimeSpawn,
  errorResult,
  FROM_AUTO_CONTINUE,
  getApiTopicConfig,
  getTopic,
  isSensitivePath,
  logger,
  type MessageDto,
  RUNTIME_MCP_BASE_PATH,
  RUNTIME_MCP_KEY,
  type RuntimeMcpContext,
  resolveRuntimeMcpToken,
  type SelfConfigContext,
  sessionInboxPath,
  storeLocalFileAsUpload,
  textResult,
  visualToolDefinitions,
  WsHub,
} from "@negotium/core";
import { z } from "zod";
import { registerNodeTools } from "#node-tools";
import { SseTransport } from "#sse-transport";

const SSE_PATH = `${RUNTIME_MCP_BASE_PATH}/sse`;
const SSE_MESSAGE_PATH = `${RUNTIME_MCP_BASE_PATH}/message`;
const STREAMABLE_PATH = `${RUNTIME_MCP_BASE_PATH}/mcp`;

const sseSessions = new Map<
  string,
  { token: string; transport: SseTransport; server: McpServer }
>();
const streamableSessions = new Map<
  string,
  { token: string; transport: WebStandardStreamableHTTPServerTransport; server: McpServer }
>();

function requireTopicAccess(
  ctx: RuntimeMcpContext,
): { topic: NonNullable<ReturnType<typeof getTopic>> } | { error: string } {
  const topic = getTopic(ctx.topicId);
  if (!topic) return { error: `Error: topic '${ctx.topicId}' not found.` };
  if (!topic.participants.some((p: { userId: string }) => p.userId === ctx.userId)) {
    return { error: "Error: user is not a member of this topic." };
  }
  return { topic };
}

function isPathInside(baseDir: string, filePath: string): boolean {
  const cwd = resolve(baseDir);
  const normalized = resolve(filePath);
  if (normalized !== cwd && !normalized.startsWith(`${cwd}/`)) return false;
  try {
    const real = realpathSync(normalized);
    return real === cwd || real.startsWith(`${cwd}/`);
  } catch (err) {
    // ENOENT: file doesn't exist yet — the path-level check already passed,
    // so this is an in-workspace path. Let localFileInfo's statSync surface
    // the precise "File not found" error instead of a misleading access denial.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function localFileInfo(ctx: RuntimeMcpContext, filePath: string) {
  if (!isPathInside(ctx.cwd, filePath)) {
    return { error: "Access denied. File must be within the topic workspace." };
  }
  const normalizedPath = resolve(filePath);
  if (isSensitivePath(normalizedPath)) {
    return { error: "Access denied. Path matches the sensitive-file blacklist." };
  }
  try {
    const stats = statSync(normalizedPath);
    if (!stats.isFile()) return { error: `${filePath} is not a file` };
    return {
      normalizedPath,
      name: basename(filePath),
      ext: extname(filePath).toLowerCase(),
      sizeBytes: stats.size,
      sizeMB: (stats.size / (1024 * 1024)).toFixed(2),
    };
  } catch {
    return { error: `File not found at ${filePath}` };
  }
}

async function deliverFile(ctx: RuntimeMcpContext, filePath: string) {
  const access = requireTopicAccess(ctx);
  if ("error" in access) return errorResult(access.error);

  const info = localFileInfo(ctx, filePath);
  if ("error" in info) return errorResult(`Error: ${info.error}`);

  const attachment = storeLocalFileAsUpload(info.normalizedPath, {
    ownerUserId: ctx.userId,
    topicId: ctx.topicId,
  });
  if (!attachment) return errorResult("Error: Failed to store file for delivery.");

  const cfg = getApiTopicConfig(ctx.topicId);
  const msg: MessageDto = {
    id: randomUUID(),
    topicId: ctx.topicId,
    authorId: "ai",
    text: `📎 ${attachment.filename}`,
    agentType: ctx.agent,
    model: ctx.model ?? cfg?.model ?? "unknown",
    attachments: [attachment],
    createdAt: new Date().toISOString(),
  };
  appendApiMessage(msg);
  WsHub.get().broadcastMessage(ctx.topicId, msg);

  return textResult(
    [
      `File sent to chat: ${info.name} (${info.ext || "no extension"}, ${info.sizeMB} MB)`,
      `Path: ${info.normalizedPath}`,
    ].join("\n"),
  );
}

function appendAutoContinue(ctx: RuntimeMcpContext, field: "agent" | "model" | "effort") {
  if (!ctx.autoContinue) return;
  appendJsonlEntry(sessionInboxPath(ctx.userId, ctx.topicId), {
    type: "tell",
    from: FROM_AUTO_CONTINUE,
    message: `The topic ${field} setting changed. Continue the user's previous work with the new configuration.`,
    depth: 0,
    silent: false,
    timestamp: new Date().toISOString(),
  });
}

export function buildNegotiumMcpServer(ctx: RuntimeMcpContext): McpServer {
  const server = new McpServer({ name: RUNTIME_MCP_KEY, version: "1.0.0" });

  for (const def of visualToolDefinitions) {
    server.tool(def.name, def.description, def.schema as any, def.handler as any);
  }

  const selfConfigCtx: SelfConfigContext = {
    topicId: ctx.topicId,
    userId: ctx.userId,
    cwd: ctx.cwd,
    currentUserPrompt: ctx.currentUserPrompt,
    onConfigChanged: (field) => appendAutoContinue(ctx, field),
  };
  for (const def of createSelfConfigToolDefinitions(selfConfigCtx)) {
    // A placed room is canonical on the hub. Until these mutations have a
    // peer bridge, creating worker-local topics would leak mirror state into
    // local pickers and diverge from the hub transcript.
    if (ctx.peerBridge && (def.name === "spawn_topic" || def.name === "fork_topic")) continue;
    server.tool(def.name, def.description, def.schema as any, def.handler as any);
  }

  const askUserTool = createAskUserToolDefinition({
    userId: ctx.userId,
    topicId: ctx.topicId,
    queryId: ctx.queryId,
    agent: ctx.agent,
    model: ctx.model,
  });
  server.tool(
    askUserTool.name,
    askUserTool.description,
    askUserTool.schema as any,
    askUserTool.handler as any,
  );

  // Delegation is for top-level agent rooms only: subagent rooms never get the
  // tool (recursion guard by construction), nor do channels/manager rooms.
  const topic = getTopic(ctx.topicId);
  const peerBridge = ctx.peerBridge;
  const canSpawnSubagents = peerBridge
    ? peerBridge.canSpawnSubagents
    : topic?.kind === "agent" && !topic.isSubagent;
  if (canSpawnSubagents) {
    const spawnTool = createSpawnSubagentToolDefinition({
      userId: ctx.userId,
      topicId: ctx.topicId,
      queryId: ctx.queryId,
      agent: ctx.agent,
      model: ctx.model,
    });
    const spawnHandler = peerBridge
      ? async (input: Record<string, unknown>) => {
          const dispatched = dispatchPeerRuntimeSpawn({
            bridge: peerBridge,
            userId: ctx.userId,
            agent: ctx.agent,
            model: ctx.model,
            input,
          });
          if (!dispatched) {
            return errorResult("Error: the peer runtime bridge is not available on this node.");
          }
          return dispatched;
        }
      : spawnTool.handler;
    server.tool(
      spawnTool.name,
      spawnTool.description,
      spawnTool.schema as any,
      spawnHandler as any,
    );
  }

  server.tool(
    "send_file",
    "Send a local file to the user in the chat. Use this when you want to share a file (image, document, PDF, code, etc.) with the user. The file will appear as a downloadable item in the chat.",
    { file_path: z.string().describe("Absolute path to the file to send") },
    async ({ file_path }) => deliverFile(ctx, file_path),
  );

  server.tool(
    "send_files",
    "Send multiple local files to the user in the chat at once.",
    { file_paths: z.array(z.string()).describe("Array of absolute file paths to send") },
    async ({ file_paths }) => {
      const results = await Promise.all(file_paths.map((filePath) => deliverFile(ctx, filePath)));
      const hasError = results.some((result) => "isError" in result && result.isError);
      return {
        content: [
          {
            type: "text" as const,
            text: results
              .map((result) => result.content.map((c) => c.text).join("\n"))
              .join("\n\n"),
          },
        ],
        ...(hasError ? { isError: true as const } : {}),
      };
    },
  );

  registerNodeTools(server, ctx);

  return server;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

function unauthorized(): Response {
  return jsonRpcError(401, -32001, "Unauthorized");
}

async function closeServer(server: McpServer): Promise<void> {
  try {
    await server.close();
  } catch (err) {
    logger.warn({ err }, "negotium MCP: server close failed");
  }
}

async function handleSse(req: Request, token: string, ctx: RuntimeMcpContext): Promise<Response> {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const endpoint = `${SSE_MESSAGE_PATH}?token=${encodeURIComponent(token)}`;
  const server = buildNegotiumMcpServer(ctx);
  const transport = new SseTransport(endpoint, req);
  const response = transport.response();

  sseSessions.set(transport.sessionId, { token, transport, server });
  transport.onclose = () => {
    sseSessions.delete(transport.sessionId);
    void closeServer(server);
  };
  transport.onerror = (err) => {
    logger.warn({ err }, "negotium MCP: SSE transport error");
  };

  try {
    await server.connect(transport);
  } catch (err) {
    sseSessions.delete(transport.sessionId);
    await transport.close();
    await closeServer(server);
    throw err;
  }

  return response;
}

async function handleSseMessage(req: Request, url: URL, token: string): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return new Response("Missing sessionId", { status: 400 });
  const session = sseSessions.get(sessionId);
  if (!session || session.token !== token)
    return new Response("SSE session not found", { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  try {
    await session.transport.handleMessage(body, req);
  } catch (err) {
    logger.warn({ err, sessionId }, "negotium MCP: invalid SSE message");
    return new Response("Invalid JSON-RPC message", { status: 400 });
  }

  return new Response("Accepted", { status: 202 });
}

async function createStreamableSession(token: string, ctx: RuntimeMcpContext) {
  const server = buildNegotiumMcpServer(ctx);
  let transport!: WebStandardStreamableHTTPServerTransport;
  transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      streamableSessions.set(sessionId, { token, transport, server });
    },
    onsessionclosed: (sessionId) => {
      streamableSessions.delete(sessionId);
      void closeServer(server);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) streamableSessions.delete(transport.sessionId);
    void closeServer(server);
  };
  transport.onerror = (err) => {
    logger.warn({ err }, "negotium MCP: streamable HTTP transport error");
  };
  await server.connect(transport);
  return { token, transport, server };
}

async function handleStreamable(
  req: Request,
  token: string,
  ctx: RuntimeMcpContext | null,
): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id");
  let session = sessionId ? streamableSessions.get(sessionId) : undefined;
  if (session && session.token !== token) return unauthorized();

  if (!session) {
    if (sessionId) return jsonRpcError(404, -32001, "Session not found");
    if (req.method !== "POST") {
      return jsonRpcError(400, -32000, "Mcp-Session-Id header is required");
    }
    // New streamable session requires a valid (non-expired) token.
    if (!ctx) return unauthorized();
    session = await createStreamableSession(token, ctx);
  }

  return session.transport.handleRequest(req);
}

/**
 * Route an incoming request to the negotium MCP endpoint. Returns null when
 * the path is not under `/mcp/runtime` so the host can fall through to its
 * own routes.
 */
export async function handleNegotiumMcpRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (
    url.pathname !== RUNTIME_MCP_BASE_PATH &&
    !url.pathname.startsWith(`${RUNTIME_MCP_BASE_PATH}/`)
  ) {
    return null;
  }

  const token = url.searchParams.get("token") ?? "";

  try {
    // SSE init: resolve context from token (required to build the per-session server).
    if (url.pathname === SSE_PATH) {
      const ctx = resolveRuntimeMcpToken(token);
      if (!ctx) return unauthorized();
      return handleSse(req, token, ctx);
    }
    // Established SSE messages: the session-level token check in handleSseMessage
    // is sufficient — skip the short-lived top-level token so 4h+ turns keep working.
    if (url.pathname === SSE_MESSAGE_PATH) return handleSseMessage(req, url, token);
    // Streamable: existing sessions don't need a fresh token lookup either.
    if (url.pathname === STREAMABLE_PATH) {
      return handleStreamable(req, token, resolveRuntimeMcpToken(token));
    }
    return jsonRpcError(404, -32001, `${RUNTIME_MCP_KEY} endpoint not found`);
  } catch (err) {
    logger.error({ err, path: url.pathname }, "negotium MCP: request failed");
    return jsonRpcError(500, -32603, "Internal MCP server error");
  }
}
