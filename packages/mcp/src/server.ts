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

import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  appendApiMessage,
  appendJsonlEntry,
  canSpawnSubagentsFromTopic,
  createAskUserToolDefinition,
  createPrepareSubagentToolDefinition,
  createPublishHtmlToolDefinitions,
  createSelfConfigToolDefinitions,
  createSpawnSubagentToolDefinition,
  createSubagentManagementToolDefinitions,
  dispatchPeerRuntimeAskUser,
  dispatchPeerRuntimeFile,
  dispatchPeerRuntimeSelfConfig,
  dispatchPeerRuntimeSpawn,
  errorResult,
  FROM_AUTO_CONTINUE,
  findThreadRootsByPrefix,
  getApiTopicConfig,
  getTopic,
  type HostedMcpSurface,
  isHostedMcpSurface,
  isSensitivePath,
  logger,
  type MessageDto,
  prepareDeliveryAck,
  RUNTIME_MCP_BASE_PATH,
  RUNTIME_MCP_KEY,
  type RuntimeMcpContext,
  renderThreadForModel,
  renderTopicThreadList,
  resolveHostedMcpToken,
  resolveRuntimeMcpToken,
  type SelfConfigContext,
  sessionInboxPath,
  showPngTool,
  storeLocalFileAsUpload,
  THREAD_READ_DEFAULT_LIMIT,
  THREAD_READ_MAX_LIMIT,
  textResult,
  visualToolDefinitions,
  WsHub,
} from "@negotium/core/mcp-runtime-host";
import { z } from "zod";
import {
  buildHostedSurfaceServer,
  type HostedMcpServer,
  isActiveHostedMcpSurface,
} from "#hosted-surfaces";
import { registerNodeTools } from "#node-tools";
import { SseTransport } from "#sse-transport";

const SSE_PATH = `${RUNTIME_MCP_BASE_PATH}/sse`;
const SSE_MESSAGE_PATH = `${RUNTIME_MCP_BASE_PATH}/message`;
const STREAMABLE_PATH = `${RUNTIME_MCP_BASE_PATH}/mcp`;

// send_file's own delivery attempt (sendPhoto/sendDocument, no retry-outbox
// hop) settles within one HTTP round trip — generous enough for slow
// networks without stalling the tool call for minutes.
const FILE_DELIVERY_ACK_TIMEOUT_MS = 30_000;
// RuntimeBus peers poll every 100ms by default. This window lets a separate
// adapter process claim the message without imposing the full delivery wait
// on web-only or otherwise unclaimed uploads.
const FILE_DELIVERY_CLAIM_TIMEOUT_MS = 500;
const MCP_SESSION_IDLE_MS = 30 * 60_000;
const MCP_SESSION_MAX_LIFETIME_MS = 6 * 60 * 60_000;
const MAX_MCP_SESSIONS = 256;

interface McpSessionBase {
  tokenFingerprint: string;
  surface: string;
  createdAt: number;
  lastAccessAt: number;
  activeRequests: number;
  server: HostedMcpServer;
}

const sseSessions = new Map<
  string,
  McpSessionBase & {
    transport: SseTransport;
  }
>();
const streamableSessions = new Map<
  string,
  McpSessionBase & {
    transport: WebStandardStreamableHTTPServerTransport;
  }
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
  try {
    const realCwd = realpathSync(cwd);
    const real = realpathSync(normalized);
    return real === realCwd || real.startsWith(`${realCwd}/`);
  } catch (err) {
    // For a missing output, preserve the precise not-found error only when its
    // lexical path is inside the workspace. Existing paths use realpath above
    // so symlink escapes and platform aliases are handled correctly.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return normalized === cwd || normalized.startsWith(`${cwd}/`);
    }
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

  if (ctx.peerBridge) {
    const bridged = await dispatchPeerRuntimeFile({
      bridge: ctx.peerBridge,
      userId: ctx.userId,
      agent: ctx.agent,
      model: ctx.model,
      path: info.normalizedPath,
      source: "runtime.send_file",
    });
    if (!bridged) return errorResult("Error: the peer file bridge is not available on this node.");
    if (!bridged.ok) return errorResult(`Error: Failed to send file on hub: ${bridged.error}`);
    return textResult(
      `File sent to chat: ${info.name} (${info.ext || "no extension"}, ${info.sizeMB} MB)`,
    );
  }

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
    sourceAdapter: "runtime.send_file",
    text: `📎 ${attachment.filename}`,
    agentType: ctx.agent,
    model: ctx.model ?? cfg?.model ?? "unknown",
    attachments: [attachment],
    deliveryAckRequested: true,
    createdAt: new Date().toISOString(),
  };
  // Install before broadcast so an in-process adapter cannot resolve the ack
  // synchronously before the waiter exists. The same signals cross process
  // through the durable RuntimeBus event log.
  const ackWaiter = prepareDeliveryAck(
    msg.id,
    FILE_DELIVERY_CLAIM_TIMEOUT_MS,
    FILE_DELIVERY_ACK_TIMEOUT_MS,
  );
  try {
    appendApiMessage(msg);
    WsHub.get().broadcastMessage(ctx.topicId, msg);
  } catch (err) {
    ackWaiter.cancel();
    throw err;
  }

  const ack = await ackWaiter.promise;
  if (ack && !ack.ok) {
    return errorResult(
      `Error: File was stored but the channel failed to deliver it${ack.error ? ` (${ack.error})` : ""}.`,
    );
  }

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

  if (ctx.visualTools === true) {
    // `show_png` is a pure alias of `show_image`, kept because Otium sessions
    // and prompts persisted before the rename still call it by that name. It
    // rides the same gate as the tools it aliases, so it only ever appears for
    // a host that grants visual tools in the first place.
    for (const def of [...visualToolDefinitions, showPngTool]) {
      const handler =
        ctx.peerBridge && (def.name === "show_html" || def.name === "show_mermaid")
          ? async () => textResult("Visual queued for ordered display on the canonical hub.")
          : def.handler;
      server.tool(def.name, def.description, def.schema as any, handler as any);
    }
    // Publishing is the same capability as show_html — render HTML for the
    // user — with a shareable link instead of an in-app panel, so it rides
    // the same gate. Unlike the show_* tools it does its own work, and it is
    // node-agnostic, so it keeps its real handler even behind a peer bridge.
    const publishTools = createPublishHtmlToolDefinitions({ cwd: ctx.cwd });
    for (const def of publishTools) {
      server.tool(def.name, def.description, def.schema as any, def.handler as any);
    }
    // Unlike the show_* tools, publishing needs a snippet backend, which is the
    // node's own configuration and not something the gateway's capability can
    // supply. So a granted turn can still come up without `publish_html`, and
    // the room's tool surface then depends on where the turn was executed. Say
    // so once per server: the last time these tools disappeared it was from a
    // config change with no log, and the silence is what made it expensive.
    if (publishTools.length === 0) {
      logger.warn(
        { topicId: ctx.topicId },
        "negotium MCP: visual tools granted but publish_html omitted; set NEGOTIUM_SNIPPETS_API_URL on this node to match a hub that has one",
      );
    }
  }

  const selfConfigCtx: SelfConfigContext = {
    topicId: ctx.topicId,
    userId: ctx.userId,
    cwd: ctx.cwd,
    currentUserPrompt: ctx.currentUserPrompt,
    onConfigChanged: (field) => appendAutoContinue(ctx, field),
  };
  for (const def of createSelfConfigToolDefinitions(selfConfigCtx)) {
    const handler = ctx.peerBridge
      ? async (input: Record<string, unknown>) => {
          const dispatched = dispatchPeerRuntimeSelfConfig({
            bridge: ctx.peerBridge!,
            userId: ctx.userId,
            tool: def.name,
            input,
            ...(ctx.currentUserPrompt ? { currentUserPrompt: ctx.currentUserPrompt } : {}),
          });
          if (!dispatched) {
            return errorResult("Error: the peer self-config bridge is not available on this node.");
          }
          return dispatched;
        }
      : def.handler;
    server.tool(def.name, def.description, def.schema as any, handler as any);
  }

  const topic = getTopic(ctx.topicId);
  if (!topic?.isSubagent) {
    const askUserTool = createAskUserToolDefinition({
      userId: ctx.userId,
      topicId: ctx.topicId,
      queryId: ctx.queryId,
      agent: ctx.agent,
      model: ctx.model,
      ...(ctx.threadRootId ? { threadRootId: ctx.threadRootId } : {}),
    });
    const askHandler = ctx.peerBridge
      ? async (input: Record<string, unknown>) => {
          const dispatched = dispatchPeerRuntimeAskUser({
            bridge: ctx.peerBridge!,
            userId: ctx.userId,
            agent: ctx.agent,
            model: ctx.model,
            input,
          });
          if (!dispatched) {
            return errorResult("Error: the peer ask-user bridge is not available on this node.");
          }
          return dispatched;
        }
      : askUserTool.handler;
    server.tool(
      askUserTool.name,
      askUserTool.description,
      askUserTool.schema as any,
      askHandler as any,
    );
  }

  // Local subagents may recurse up to the runtime depth limit.
  const peerBridge = ctx.peerBridge;
  const canSpawnSubagents = peerBridge
    ? peerBridge.canSpawnSubagents
    : canSpawnSubagentsFromTopic(ctx.topicId);
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
    if (!peerBridge) {
      const createTool = createPrepareSubagentToolDefinition({
        userId: ctx.userId,
        topicId: ctx.topicId,
        queryId: ctx.queryId,
        agent: ctx.agent,
        model: ctx.model,
      });
      server.tool(
        createTool.name,
        createTool.description,
        createTool.schema as any,
        createTool.handler as any,
      );
    }
  }
  if (!peerBridge && topic?.kind === "agent" && ctx.topicId) {
    for (const def of createSubagentManagementToolDefinitions({
      userId: ctx.userId,
      topicId: ctx.topicId,
    })) {
      server.tool(def.name, def.description, def.schema as any, def.handler as any);
    }
  }

  if (ctx.fileDeliveryTools === true) {
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
  }

  registerThreadTools(server, ctx);
  registerNodeTools(server, ctx);

  return server;
}

/**
 * Reading a thread back, for the case the prompt's thread tag cannot cover.
 *
 * Earlier replies in a thread were already sent to this session, so they are
 * above in the context and are not re-sent on every turn. What survives a
 * `/compact` or a session reset is the tag alone, and that is when a model
 * needs to fetch the text behind it.
 *
 * Scoped to `ctx.topicId` with no topic argument on purpose: reading another
 * room is `session-comm`'s job, and it has a permission model for it.
 */
function registerThreadTools(server: McpServer, ctx: RuntimeMcpContext): void {
  if (!ctx.topicId) return;
  const topicId = ctx.topicId;

  server.tool(
    "thread_read",
    "Read one thread of this room in full, oldest message first. Call it with no arguments to get the thread the current message was sent in — useful when a message is tagged (in thread #id) but the conversation behind that tag is no longer in your context.",
    {
      thread_id: z
        .string()
        .optional()
        .describe(
          "Thread tag (#a3f1c8) or full root message id. Omit to read the thread this turn is answering in.",
        ),
      limit: z
        .number()
        .int()
        .optional()
        .describe(
          `Most recent replies to include (default ${THREAD_READ_DEFAULT_LIMIT}, max ${THREAD_READ_MAX_LIMIT}).`,
        ),
    },
    async ({ thread_id, limit }) => {
      const requested = thread_id?.trim();
      if (!requested && !ctx.threadRootId) {
        return errorResult(
          "Error: this turn is not inside a thread. Pass thread_id, or call thread_list to see this room's threads.",
        );
      }
      let rootId = ctx.threadRootId ?? "";
      if (requested) {
        const resolved = resolveThreadRootId(topicId, requested);
        if (resolved.kind === "ambiguous") {
          return errorResult(
            `Error: '${requested}' matches ${resolved.matches.length} threads in this room (${resolved.matches
              .slice(0, 5)
              .join(", ")}). Pass the full root message id.`,
          );
        }
        rootId = resolved.rootId;
      }
      const rendered = renderThreadForModel(topicId, rootId, limit ?? THREAD_READ_DEFAULT_LIMIT);
      if (!rendered) {
        return errorResult(
          `Error: no thread '${requested ?? rootId}' in this room. Call thread_list to see which threads exist.`,
        );
      }
      return textResult(rendered);
    },
  );

  server.tool(
    "thread_list",
    "List the threads in this room with their tag, reply count and root message, most recently active first. Use it to find a thread the user refers to by subject rather than by tag.",
    {
      limit: z.number().int().optional().describe("Threads to list (default 20)."),
    },
    async ({ limit }) => textResult(renderTopicThreadList(topicId, limit ?? 20)),
  );
}

/**
 * Accept the short tag the model sees in transcripts as well as a full id.
 *
 * `threadTag` is a prefix of the root id, so a bare tag is resolved by prefix.
 * Six hex characters is 24 bits, which collides inside a long-lived room, and
 * picking one silently would answer about the wrong conversation — so an
 * ambiguous prefix is reported rather than guessed. An exact id always wins,
 * because a caller that supplied the whole id has said which thread it means.
 */
function resolveThreadRootId(
  topicId: string,
  requested: string,
): { kind: "resolved"; rootId: string } | { kind: "ambiguous"; matches: string[] } {
  const bare = requested.replace(/^#/, "");
  const matches = findThreadRootsByPrefix(topicId, bare);
  const exact = matches.find((rootId) => rootId === requested || rootId === bare);
  if (exact) return { kind: "resolved", rootId: exact };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  // No match falls through to the requested value: `renderThreadForModel` then
  // reports "no such thread", which is the same answer with a better message.
  return { kind: "resolved", rootId: matches[0] ?? requested };
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

function unauthorized(): Response {
  return jsonRpcError(401, -32001, "Unauthorized");
}

// McpServer.close() closes its transport, whose onclose hook comes back here.
// Keep the teardown idempotent so that callback cannot recursively close the
// same server until the stack overflows.
const closingServers = new WeakSet<HostedMcpServer>();

async function closeServer(server: HostedMcpServer): Promise<void> {
  if (closingServers.has(server)) return;
  closingServers.add(server);
  try {
    await server.close();
  } catch (err) {
    logger.warn({ err }, "negotium MCP: server close failed");
  }
}

/** Close every context-bound MCP session before the embedding runtime tears down its hosts. */
export async function closeNegotiumMcpSessions(): Promise<void> {
  const servers = new Set<HostedMcpServer>();
  for (const session of sseSessions.values()) servers.add(session.server);
  for (const session of streamableSessions.values()) servers.add(session.server);
  sseSessions.clear();
  streamableSessions.clear();
  await Promise.all([...servers].map((server) => closeServer(server)));
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function enforceSessionBounds(reserve = 0): Promise<boolean> {
  const now = Date.now();
  const sessions = [
    ...[...sseSessions].map(([id, session]) => ({ id, kind: "sse" as const, session })),
    ...[...streamableSessions].map(([id, session]) => ({
      id,
      kind: "streamable" as const,
      session,
    })),
  ].sort((a, b) => a.session.lastAccessAt - b.session.lastAccessAt);

  let remaining = sessions.length;
  for (const entry of sessions) {
    const expired =
      entry.session.activeRequests === 0 &&
      (now - entry.session.lastAccessAt >= MCP_SESSION_IDLE_MS ||
        now - entry.session.createdAt >= MCP_SESSION_MAX_LIFETIME_MS);
    if (!expired) continue;
    if (entry.kind === "sse") sseSessions.delete(entry.id);
    else streamableSessions.delete(entry.id);
    remaining -= 1;
    await closeServer(entry.session.server);
  }
  return remaining + reserve <= MAX_MCP_SESSIONS;
}

async function handleSse(
  req: Request,
  token: string,
  surface: string,
  messagePath: string,
  server: HostedMcpServer,
): Promise<Response> {
  if (req.method !== "GET") {
    await closeServer(server);
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!(await enforceSessionBounds(1))) {
    await closeServer(server);
    return new Response("MCP session capacity reached", { status: 503 });
  }

  const endpoint = `${messagePath}?token=${encodeURIComponent(token)}`;
  const transport = new SseTransport(endpoint, req);
  const response = transport.response();

  sseSessions.set(transport.sessionId, {
    tokenFingerprint: tokenFingerprint(token),
    surface,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    activeRequests: 0,
    transport,
    server,
  });
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

async function handleSseMessage(
  req: Request,
  url: URL,
  token: string,
  surface: string,
): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return new Response("Missing sessionId", { status: 400 });
  const session = sseSessions.get(sessionId);
  if (
    !session ||
    session.surface !== surface ||
    session.tokenFingerprint !== tokenFingerprint(token)
  )
    return new Response("SSE session not found", { status: 404 });
  session.lastAccessAt = Date.now();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  session.activeRequests += 1;
  try {
    await session.transport.handleMessage(body, req);
  } catch (err) {
    logger.warn({ err, sessionId }, "negotium MCP: invalid SSE message");
    return new Response("Invalid JSON-RPC message", { status: 400 });
  } finally {
    session.activeRequests -= 1;
    session.lastAccessAt = Date.now();
  }

  return new Response("Accepted", { status: 202 });
}

async function createStreamableSession(token: string, surface: string, server: HostedMcpServer) {
  let transport!: WebStandardStreamableHTTPServerTransport;
  transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      streamableSessions.set(sessionId, {
        tokenFingerprint: tokenFingerprint(token),
        surface,
        createdAt: Date.now(),
        lastAccessAt: Date.now(),
        activeRequests: 0,
        transport,
        server,
      });
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
  return {
    tokenFingerprint: tokenFingerprint(token),
    surface,
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    activeRequests: 0,
    transport,
    server,
  };
}

async function handleStreamable(
  req: Request,
  token: string,
  surface: string,
  server: HostedMcpServer | null,
): Promise<Response> {
  const sessionId = req.headers.get("mcp-session-id");
  let session = sessionId ? streamableSessions.get(sessionId) : undefined;
  let createdForRequest = false;
  if (
    session &&
    (session.surface !== surface || session.tokenFingerprint !== tokenFingerprint(token))
  ) {
    return unauthorized();
  }

  if (!session) {
    if (sessionId) return jsonRpcError(404, -32001, "Session not found");
    if (req.method !== "POST") {
      return jsonRpcError(400, -32000, "Mcp-Session-Id header is required");
    }
    // New streamable session requires a valid (non-expired) token.
    if (!server) return unauthorized();
    if (!(await enforceSessionBounds(1))) {
      await closeServer(server);
      return new Response("MCP session capacity reached", { status: 503 });
    }
    session = await createStreamableSession(token, surface, server);
    createdForRequest = true;
  }

  session.lastAccessAt = Date.now();
  session.activeRequests += 1;
  try {
    return await session.transport.handleRequest(req);
  } finally {
    session.activeRequests -= 1;
    session.lastAccessAt = Date.now();
    // Invalid initial requests never receive a session id and therefore never
    // enter streamableSessions. Close their server here so malformed traffic
    // cannot bypass the global session bound and accumulate transports.
    if (createdForRequest && !session.transport.sessionId) {
      await closeServer(session.server);
    }
  }
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
    const hostedMatch = url.pathname.match(
      new RegExp(`^${RUNTIME_MCP_BASE_PATH}/([^/]+)/(sse|message|mcp)$`),
    );
    if (hostedMatch) {
      const surfaceName = hostedMatch[1] ?? "";
      const endpoint = hostedMatch[2];
      if (!isHostedMcpSurface(surfaceName) || !isActiveHostedMcpSurface(surfaceName)) {
        return jsonRpcError(404, -32001, `Hosted MCP surface not found: ${surfaceName}`);
      }
      const surface: HostedMcpSurface = surfaceName;
      if (endpoint === "sse") {
        const ctx = resolveHostedMcpToken(token, surface);
        if (!ctx) return unauthorized();
        return handleSse(
          req,
          token,
          surface,
          `${RUNTIME_MCP_BASE_PATH}/${surface}/message`,
          await buildHostedSurfaceServer(surface, ctx),
        );
      }
      if (endpoint === "message") return handleSseMessage(req, url, token, surface);
      const ctx = resolveHostedMcpToken(token, surface);
      const isNewSession = !req.headers.get("mcp-session-id");
      return handleStreamable(
        req,
        token,
        surface,
        isNewSession && ctx ? await buildHostedSurfaceServer(surface, ctx) : null,
      );
    }

    // SSE init: resolve context from token (required to build the per-session server).
    if (url.pathname === SSE_PATH) {
      const ctx = resolveRuntimeMcpToken(token);
      if (!ctx) return unauthorized();
      return handleSse(req, token, RUNTIME_MCP_KEY, SSE_MESSAGE_PATH, buildNegotiumMcpServer(ctx));
    }
    // Established SSE messages: the session-level token check in handleSseMessage
    // is sufficient — skip the short-lived top-level token so 4h+ turns keep working.
    if (url.pathname === SSE_MESSAGE_PATH)
      return handleSseMessage(req, url, token, RUNTIME_MCP_KEY);
    // Streamable: existing sessions don't need a fresh token lookup either.
    if (url.pathname === STREAMABLE_PATH) {
      const ctx = resolveRuntimeMcpToken(token);
      const isNewSession = !req.headers.get("mcp-session-id");
      return handleStreamable(
        req,
        token,
        RUNTIME_MCP_KEY,
        isNewSession && ctx ? buildNegotiumMcpServer(ctx) : null,
      );
    }
    return jsonRpcError(404, -32001, `${RUNTIME_MCP_KEY} endpoint not found`);
  } catch (err) {
    logger.error({ err, path: url.pathname }, "negotium MCP: request failed");
    return jsonRpcError(500, -32603, "Internal MCP server error");
  }
}
