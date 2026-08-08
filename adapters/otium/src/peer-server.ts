/**
 * Worker peer surface — the inbound HTTP contract from
 * docs/OTIUM-COUPLING.md §2.1, mounted in front of the host's other handlers:
 *
 *   Bun.serve({ fetch: async (req) =>
 *     (await handleOtiumPeerRequest(req)) ?? (await handleNegotiumMcpRequest(req)) ?? … })
 *
 * Auth model (mirrors otium routes.ts `requirePeer`):
 *   ① no join credentials → 403 "multi-node is disabled" (fail-closed)
 *   ② missing Bearer → 401 "missing peer token"
 *   ③ central `POST /peer/verify` failure → 401 "invalid peer token"
 *      (30s positive cache in #central)
 *   ④ body `v` check → 400 on newer protocol
 * Hub-only writes additionally require `verified.fromIsPrimary`.
 *
 * Implements the worker peer protocol: cross-node session messages (tell / ask /
 * sessions / reply / abort, D-7), the device-vault bridge, capability and health
 * snapshots, and the remote Runtime Gateway forward (D-2). The placed-turn
 * receiver — `provision`, `turn`, `input-file` and the exact-requestId abort —
 * has been removed; the Gateway replaced it.
 */

import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import {
  appendJsonlEntry,
  checkAgentModelAuth,
  DATA_DIR,
  flushSessionInbox,
  getRegistry,
  getTopicByNameForUser,
  getTopicSessionId,
  listTopics,
  logger,
  MAX_TELL_DEPTH,
  NEGOTIUM_VERSION,
  normalizeVaultKey,
  OPTIONAL_FORUM_MCP_SERVERS,
  SUPPORTED_AGENTS,
  sessionInboxPath,
  type TopicDto,
  VAULT_DESCRIPTION_MAX_LENGTH,
  VAULT_VALUE_MAX_BYTES,
  VAULT_VALUE_MIN_BYTES,
  validateVaultKey,
  vaultDel,
  vaultList,
  vaultSet,
} from "@negotium/core";
import { otiumCentralConfig, type VerifiedPeer, verifyPeerToken } from "@/central";
import { forwardGatewayRequest, OTIUM_GATEWAY_FORWARD_PREFIX } from "@/gateway-forward";
import { MAX_PEER_MESSAGE_LENGTH, PEER_PROTOCOL_VERSION, type PeerSessionEntry } from "@/protocol";
import { acceptRemoteAskReplyResult } from "@/session-bridge";
import {
  claimPeerInboxRequest,
  type PeerInboxKind,
  peerInboxPayloadHash,
  releasePeerInboxRequest,
} from "@/store";

const RUNTIME_VERSION = NEGOTIUM_VERSION;

function jsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const body = (await req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

function str(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value : null;
}

function checkProtocol(body: Record<string, unknown>): Response | null {
  const v = body.v;
  if (typeof v !== "number" || v > PEER_PROTOCOL_VERSION) {
    return jsonError(`unsupported peer protocol version (mine: ${PEER_PROTOCOL_VERSION})`, 400);
  }
  return null;
}

type PeerAuth = { ok: false; response: Response } | { ok: true; verified: VerifiedPeer };

async function requirePeer(req: Request): Promise<PeerAuth> {
  if (!otiumCentralConfig()) {
    return { ok: false, response: jsonError("multi-node is disabled", 403) };
  }
  const token = bearer(req);
  if (!token) return { ok: false, response: jsonError("missing peer token", 401) };
  const verified = await verifyPeerToken(token);
  if (!verified) return { ok: false, response: jsonError("invalid peer token", 401) };
  return { ok: true, verified };
}

function requirePrimaryOrigin(peer: Extract<PeerAuth, { ok: true }>): Response | null {
  return peer.verified.fromIsPrimary
    ? null
    : jsonError("only the workspace hub may call this endpoint", 403);
}

/**
 * May another node address this topic by name (D-7)?
 *
 * Exactly one thing qualifies: the room lives on the `otium` surface. Peers are
 * an Otium-side concept, so cross-node addressing stays inside that surface and
 * can never reach a terminal or telegram room (S-7).
 */
function peerAddressable(topic: Pick<TopicDto, "surface">): boolean {
  return topic.surface === "otium";
}

// ── Capability / health snapshots ────────────────────────────────────

function localCapabilities() {
  const agents = SUPPORTED_AGENTS.map((kind) => {
    const registry = getRegistry(kind);
    const auth = checkAgentModelAuth(kind, registry.defaultModel);
    return {
      kind,
      available: auth.ok,
      defaultModel: registry.defaultModel,
      validEfforts: registry.validEfforts,
      ...(!auth.ok ? { error: auth.error } : {}),
    };
  });
  return {
    protocolVersion: PEER_PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    features: {
      remoteAsk: true,
      // `/api/v1/peer/input-file` existed to stage attachments for a placed turn.
      inputFiles: false,
      outputFiles: true,
      visualBridge: true,
      askUserBridge: true,
      selfConfigBridge: true,
    },
    agents,
    // These are negotium MCP catalog names, advertised so the hub can validate a
    // room's MCP override against what this worker can actually run.
    optionalMcp: OPTIONAL_FORUM_MCP_SERVERS,
  };
}

function localHealth() {
  const memory = process.memoryUsage();
  let disk: { totalBytes: number; freeBytes: number } | undefined;
  try {
    const stats = statfsSync(DATA_DIR);
    disk = {
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
    };
  } catch {
    disk = undefined;
  }
  return {
    uptimeSeconds: process.uptime(),
    cpu: { cores: cpus().length, loadAverage: loadavg() },
    memory: {
      totalBytes: totalmem(),
      freeBytes: freemem(),
      processRssBytes: memory.rss,
      processHeapUsedBytes: memory.heapUsed,
    },
    ...(disk ? { disk } : {}),
  };
}

// ── Handlers ─────────────────────────────────────────────────────────

async function handleAbort(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;

  const userId = str(body, "userId");
  const toTopic = str(body, "toTopic");
  if (!userId || !toTopic) return jsonError("userId and toTopic are required", 400);
  // A `requestId`, if an older caller still sends one, selects nothing any more:
  // it named one placed turn. Aborting is purely topic-scoped now, which is what
  // session-comm has always used.
  const topic = getTopicByNameForUser(toTopic, userId);
  if (!topic || !peerAddressable(topic)) {
    return jsonError(`shared topic "${toTopic}" not found on this node`, 404);
  }
  appendJsonlEntry(sessionInboxPath(userId, topic.id), {
    type: "abort",
    timestamp: new Date().toISOString(),
  });
  void flushSessionInbox();
  logger.info({ fromNode: peer.verified.fromNodeName, toTopic }, "otium: peer abort accepted");
  return Response.json({ ok: true });
}

async function handleTell(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;

  const requestId = str(body, "requestId");
  const userId = str(body, "userId");
  const toTopic = str(body, "toTopic");
  const fromLabel = str(body, "fromLabel");
  const message = str(body, "message");
  const depth = typeof body.depth === "number" ? body.depth : Number.NaN;
  if (!requestId || !userId || !toTopic || !fromLabel || !message) {
    return jsonError("requestId, userId, toTopic, fromLabel, message are required", 400);
  }
  if (message.length > MAX_PEER_MESSAGE_LENGTH) return jsonError("message too long", 400);
  if (!Number.isInteger(depth) || depth < 0) {
    return jsonError("depth must be a non-negative integer", 400);
  }
  if (depth > MAX_TELL_DEPTH) {
    return jsonError(`tell depth limit exceeded (max ${MAX_TELL_DEPTH})`, 400);
  }

  const topic = getTopicByNameForUser(toTopic, userId);
  if (!topic || !peerAddressable(topic)) {
    return jsonError(`shared topic "${toTopic}" not found on this node`, 404);
  }

  const claim = claimInboundPeerMessage({
    fromCellId: peer.verified.fromCellId,
    requestId,
    kind: "tell",
    topicId: topic.id,
    payload: { userId, toTopic, fromLabel, message, depth },
  });
  if (claim === "conflict") return jsonError("requestId already belongs to another tell", 409);
  if (claim === "replay") return Response.json({ ok: true, replayed: true });
  try {
    appendJsonlEntry(sessionInboxPath(userId, topic.id), {
      type: "tell",
      requestId,
      from: fromLabel,
      fromTitle: fromLabel,
      message,
      depth,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    releasePeerInboxRequest(peer.verified.fromCellId, requestId, "tell");
    throw error;
  }
  void flushSessionInbox();
  logger.info(
    { from: fromLabel, fromNode: peer.verified.fromNodeName, toTopic, requestId },
    "otium: peer tell accepted",
  );
  return Response.json({ ok: true });
}

function claimInboundPeerMessage(args: {
  fromCellId: string;
  requestId: string;
  kind: PeerInboxKind;
  topicId: string;
  payload: unknown;
}): "claimed" | "replay" | "conflict" {
  return claimPeerInboxRequest({
    fromCellId: args.fromCellId,
    requestId: args.requestId,
    kind: args.kind,
    topicId: args.topicId,
    payloadHash: peerInboxPayloadHash(args.payload),
  }).outcome;
}

async function handleSessions(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  const userId = str(body, "userId");
  if (!userId) return jsonError("userId is required", 400);

  const topics = listTopics({ surface: "otium" }).filter(
    (topic) =>
      topic.kind !== "manager" &&
      !topic.isSubagent &&
      peerAddressable(topic) &&
      topic.participants.some((p) => p.userId === userId),
  );
  const titleCounts = new Map<string, number>();
  for (const topic of topics) {
    const normalized = topic.title.toLowerCase();
    titleCounts.set(normalized, (titleCounts.get(normalized) ?? 0) + 1);
  }
  const sessions: PeerSessionEntry[] = topics.map((topic) => {
    const collision = (titleCounts.get(topic.title.toLowerCase()) ?? 0) > 1;
    const kind = topic.kind === "agent" ? "agent" : "channel";
    return {
      topicId: topic.id,
      name: collision ? `${kind}:${topic.title}` : topic.title,
      agent: topic.agent ?? null,
      hasSession: Boolean(getTopicSessionId(topic.id)),
      ...(topic.description ? { description: topic.description } : {}),
    };
  });
  return Response.json({ ok: true, sessions });
}

async function handleAsk(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  const requestId = str(body, "requestId");
  const userId = str(body, "userId");
  const toTopic = str(body, "toTopic");
  const fromLabel = str(body, "fromLabel");
  const message = str(body, "message");
  const fromDepth =
    body.fromDepth === undefined
      ? 0
      : typeof body.fromDepth === "number"
        ? body.fromDepth
        : Number.NaN;
  const replyTo = body.replyTo as { topicId?: unknown } | undefined;
  const replyTopicId = typeof replyTo?.topicId === "string" ? replyTo.topicId : null;
  if (!requestId || !userId || !toTopic || !fromLabel || !message || !replyTopicId) {
    return jsonError(
      "requestId, userId, toTopic, fromLabel, message, replyTo.topicId are required",
      400,
    );
  }
  if (message.length > MAX_PEER_MESSAGE_LENGTH) return jsonError("message too long", 400);
  if (!Number.isInteger(fromDepth) || fromDepth < 0) {
    return jsonError("fromDepth must be a non-negative integer", 400);
  }
  const topic = getTopicByNameForUser(toTopic, userId);
  if (!topic || !peerAddressable(topic)) {
    return jsonError(`shared topic "${toTopic}" not found on this node`, 404);
  }
  if (!topic.agent) return jsonError(`topic "${toTopic}" has no AI invited`, 409);

  const claim = claimInboundPeerMessage({
    fromCellId: peer.verified.fromCellId,
    requestId,
    kind: "ask",
    topicId: topic.id,
    payload: { userId, toTopic, fromLabel, message, fromDepth, replyTopicId },
  });
  if (claim === "conflict") return jsonError("requestId already belongs to another ask", 409);
  if (claim === "replay") return Response.json({ ok: true, replayed: true });
  try {
    appendJsonlEntry(sessionInboxPath(userId, topic.id), {
      type: "ask",
      requestId,
      from: fromLabel,
      fromTitle: fromLabel,
      message,
      fromDepth,
      timestamp: new Date().toISOString(),
      remoteReply: {
        nodeName: peer.verified.fromNodeName ?? "",
        nodeCellId: peer.verified.fromCellId,
        topicId: replyTopicId,
        userId,
        requestId,
      },
    });
  } catch (error) {
    releasePeerInboxRequest(peer.verified.fromCellId, requestId, "ask");
    throw error;
  }
  void flushSessionInbox();
  return Response.json({ ok: true });
}

async function handleReply(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  const requestId = str(body, "requestId");
  const userId = str(body, "userId");
  const replyText = typeof body.replyText === "string" ? body.replyText : null;
  const fromLabel = str(body, "fromLabel") ?? "peer";
  const kind = body.kind === "error" ? "error" : "reply";
  if (!requestId || !userId || replyText === null) {
    return jsonError("requestId, userId and replyText are required", 400);
  }
  const accepted = await acceptRemoteAskReplyResult({
    fromCellId: peer.verified.fromCellId,
    requestId,
    userId,
    fromLabel,
    replyText,
    kind,
  });
  if (accepted === "accepted") return Response.json({ ok: true });
  if (accepted === "retry") return jsonError("ask callback delivery is retryable", 503);
  return jsonError("no pending ask for this requestId", 404);
}

/** Hub-mediated management of this device's encrypted, node-local vault.
 * Secret values are accepted only for `set` and are never returned or logged. */
async function handleDeviceVault(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  const userId = str(body, "userId");
  const operation = str(body, "operation");
  if (!userId || !operation) return jsonError("userId and operation are required", 400);

  if (operation === "list") {
    return Response.json({ ok: true, entries: vaultList(userId) });
  }

  const rawKey = str(body, "key");
  if (!rawKey || !validateVaultKey(rawKey)) return jsonError("invalid vault key", 400);
  const key = normalizeVaultKey(rawKey);
  if (operation === "delete") {
    return vaultDel(userId, key)
      ? Response.json({ ok: true, deleted: key })
      : jsonError(`vault key "${key}" not found`, 404);
  }
  if (operation !== "set") return jsonError("invalid vault operation", 400);

  const value = typeof body.value === "string" ? body.value : "";
  const valueBytes = Buffer.byteLength(value, "utf8");
  if (valueBytes < VAULT_VALUE_MIN_BYTES || valueBytes > VAULT_VALUE_MAX_BYTES) {
    return jsonError(
      `value must be between ${VAULT_VALUE_MIN_BYTES} and ${VAULT_VALUE_MAX_BYTES} bytes`,
      400,
    );
  }
  const description = body.description === undefined ? "" : body.description;
  if (typeof description !== "string" || description.length > VAULT_DESCRIPTION_MAX_LENGTH) {
    return jsonError(`description must be at most ${VAULT_DESCRIPTION_MAX_LENGTH} characters`, 400);
  }
  vaultSet(userId, key, value, description);
  return Response.json({ ok: true, key, ...(description ? { description } : {}) });
}

// ── Router ───────────────────────────────────────────────────────────

/**
 * Handle one inbound request if it belongs to the otium worker surface.
 * Returns null for every other path so the host can chain its own handlers.
 */
export async function handleOtiumPeerRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/ready" && req.method === "GET") {
    // Unauthenticated hub probe (3s timeout hub-side). Only claim readiness
    // when the worker is actually joined; otherwise let the host decide.
    if (!otiumCentralConfig()) return null;
    return Response.json({ ok: true });
  }

  if (!path.startsWith("/api/v1/peer/")) return null;

  /**
   * Remote Runtime Gateway (D-2). Handled before the method switch because it
   * carries both GET (including the SSE event stream) and POST, and because the
   * hub-only check must run before the node control handler ever sees it.
   */
  if (path.startsWith(OTIUM_GATEWAY_FORWARD_PREFIX)) {
    const peer = await requirePeer(req);
    if (!peer.ok) return peer.response;
    const notPrimary = requirePrimaryOrigin(peer);
    if (notPrimary) return notPrimary;
    // Lazily imported: this module is loaded inside the node process, and a
    // static edge back into @negotium/node would import the node graph during
    // the node's own module evaluation.
    const { inspectNodeDaemon } = await import("@negotium/node");
    const node = await inspectNodeDaemon();
    if (!node.running || !node.info) {
      return jsonError("canonical Negotium node is unavailable", 503);
    }
    return forwardGatewayRequest(req, {
      nodeOrigin: `http://127.0.0.1:${node.info.port}`,
    });
  }

  if (req.method === "GET") {
    if (path === "/api/v1/peer/capabilities") {
      const peer = await requirePeer(req);
      if (!peer.ok) return peer.response;
      return Response.json({ ok: true, ...localCapabilities() });
    }
    if (path === "/api/v1/peer/health") {
      const peer = await requirePeer(req);
      if (!peer.ok) return peer.response;
      return Response.json({ ok: true, ...localHealth() });
    }
    return jsonError("not found", 404);
  }

  if (req.method !== "POST") return jsonError("not found", 404);
  switch (path) {
    // `provision` / `turn` / `input-file` were the placed-turn receiver: the hub
    // created a mirror room here and drove it one turn at a time. `bind` /
    // `unbind` / `shared-topic/messages` / `shared-topics/private` were the older
    // message-copying data plane (D-1). All of them 404 now, and the Runtime
    // Gateway at `/api/v1/peer/runtime/*` is the only hub→worker execution
    // transport.
    case "/api/v1/peer/abort":
      return handleAbort(req);
    case "/api/v1/peer/tell":
      return handleTell(req);
    case "/api/v1/peer/ask":
      return handleAsk(req);
    case "/api/v1/peer/sessions":
      return handleSessions(req);
    case "/api/v1/peer/reply":
      return handleReply(req);
    case "/api/v1/peer/device-vault":
      return handleDeviceVault(req);
    default:
      return jsonError("not found", 404);
  }
}
