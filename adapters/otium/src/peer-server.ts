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
 * Implemented: /ready, capabilities, health, provision, turn, abort, tell,
 * sessions. Honest stubs (remaining gaps, see doc §4): ask (no remote reply
 * path), reply (worker never sends cross-node asks), input-file (no
 * upload store / FileHooks yet).
 */

import { statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import {
  appendJsonlEntry,
  checkAgentAuth,
  DATA_DIR,
  flushSessionInbox,
  getRegistry,
  getTopicByNameForUser,
  getTopicSessionId,
  isTopicShared,
  listTopics,
  logger,
  MAX_TELL_DEPTH,
  OPTIONAL_FORUM_MCP_SERVERS,
  SUPPORTED_AGENTS,
  sessionInboxPath,
} from "@negotium/core";
import { bindOtiumTopic, unbindOtiumTopic } from "@/bindings";
import {
  otiumCentralConfig,
  resolvePeerNodeByCellId,
  type VerifiedPeer,
  verifyPeerToken,
} from "@/central";
import {
  MAX_PEER_MESSAGE_LENGTH,
  PEER_PROTOCOL_VERSION,
  type PeerSessionEntry,
  type PeerTurnRequest,
  parseExecutionSpec,
} from "@/protocol";
import {
  claimPeerInboxRequest,
  type PeerInboxKind,
  peerInboxPayloadHash,
  releasePeerInboxRequest,
} from "@/store";
import { abortHostedPeerTurn, provisionMirrorTopic, runPeerTurn } from "@/turn-bridge";

const RUNTIME_VERSION = "0.1.0";

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

// ── Capability / health snapshots ────────────────────────────────────

function localCapabilities() {
  const agents = SUPPORTED_AGENTS.map((kind) => {
    const auth = checkAgentAuth(kind);
    const registry = getRegistry(kind);
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
    agents,
    // These are negotium MCP catalog names — a hub room whose MCP
    // override uses otium-only names will fail placement with 409.
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

async function handleProvision(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  const userId = str(body, "userId");
  const hostTopicId = str(body, "hostTopicId");
  const topicTitle = str(body, "topicTitle");
  const execution = parseExecutionSpec(body.execution);
  if (!userId || !hostTopicId || !topicTitle || !execution) {
    return jsonError("invalid peer provision request", 400);
  }
  const result = provisionMirrorTopic(peer.verified.fromCellId, {
    userId,
    hostTopicId,
    topicTitle,
    execution,
  });
  if (!result.ok) return jsonError(result.error, result.status);
  logger.info(
    { hostTopicId, localTopicId: result.localTopicId, fromNode: peer.verified.fromNodeName },
    "otium: hidden mirror room provisioned",
  );
  return Response.json({ ok: true });
}

async function handleBind(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  const userId = str(body, "userId");
  const hostTopicId = str(body, "hostTopicId");
  const localTopicId = str(body, "localTopicId");
  if (!userId || !hostTopicId || !localTopicId) {
    return jsonError("invalid peer bind request", 400);
  }
  const result = bindOtiumTopic({
    hostNodeId: peer.verified.fromCellId,
    hostTopicId,
    localTopicId,
    userId,
  });
  if (!result.ok) return jsonError(result.error, result.status);
  return Response.json({ ok: true, localTopicId: result.localTopicId, replaced: result.replaced });
}

async function handleUnbind(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  const hostTopicId = str(body, "hostTopicId");
  if (!hostTopicId) return jsonError("hostTopicId is required", 400);
  const removed = unbindOtiumTopic(peer.verified.fromCellId, hostTopicId);
  return Response.json({ ok: true, removed });
}

async function handleTurn(req: Request): Promise<Response> {
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
  const hostTopicId = str(body, "hostTopicId");
  const topicTitle = str(body, "topicTitle");
  const execution = parseExecutionSpec(body.execution);
  if (body.execution !== undefined && !execution) {
    return jsonError("invalid placed-topic execution spec", 400);
  }
  const agent = execution?.agent ?? str(body, "agent");
  const message = str(body, "message");
  if (!requestId || !userId || !hostTopicId || !topicTitle || !agent || !message) {
    return jsonError(
      "requestId, userId, hostTopicId, topicTitle, agent, message are required",
      400,
    );
  }
  if (message.length > MAX_PEER_MESSAGE_LENGTH) return jsonError("message too long", 400);

  const hubNode = await resolvePeerNodeByCellId(peer.verified.fromCellId).catch(() => null);
  if (!hubNode) return jsonError("calling node is not in this workspace", 403);

  const payload: PeerTurnRequest = {
    v: PEER_PROTOCOL_VERSION,
    requestId,
    userId,
    hostTopicId,
    topicTitle,
    ...(execution ? { execution } : {}),
    ...(agent ? { agent } : {}),
    ...(str(body, "model") ? { model: str(body, "model") as string } : {}),
    ...(str(body, "effort") ? { effort: str(body, "effort") as string } : {}),
    ...(Array.isArray(body.attachments) &&
    body.attachments.every((entry) => typeof entry === "string")
      ? { attachments: body.attachments as string[] }
      : {}),
    message,
  };
  const result = runPeerTurn(hubNode, peer.verified.fromCellId, payload);
  if (!result.ok) return jsonError(result.error, result.status);
  logger.info(
    { requestId, hostTopicId, fromNode: peer.verified.fromNodeName },
    "otium: peer turn accepted",
  );
  return Response.json({ ok: true });
}

async function handleAbort(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;

  const userId = str(body, "userId");
  const toTopic = str(body, "toTopic");
  if (!userId || !toTopic) return jsonError("userId and toTopic are required", 400);
  const requestId = str(body, "requestId");
  if (requestId) {
    const aborted = abortHostedPeerTurn(peer.verified.fromCellId, requestId, userId, toTopic);
    if (!aborted) return jsonError("turn not found or already completed", 404);
    logger.info(
      { fromNode: peer.verified.fromNodeName, toTopic, requestId },
      "otium: exact peer turn abort accepted",
    );
    return Response.json({ ok: true });
  }
  const topic = getTopicByNameForUser(toTopic, userId);
  if (!topic || !isTopicShared(topic)) {
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
  if (!topic || !isTopicShared(topic)) {
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
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  const userId = str(body, "userId");
  if (!userId) return jsonError("userId is required", 400);

  const sessions: PeerSessionEntry[] = listTopics()
    .filter(
      (topic) =>
        topic.kind !== "manager" &&
        !topic.isSubagent &&
        isTopicShared(topic) &&
        topic.participants.some((p) => p.userId === userId),
    )
    .map((topic) => ({
      topicId: topic.id,
      name: topic.title,
      agent: topic.agent ?? null,
      hasSession: Boolean(getTopicSessionId(topic.id)),
      ...(topic.description ? { description: topic.description } : {}),
    }));
  return Response.json({ ok: true, sessions });
}

async function handleAsk(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  // Negotium's inbox ask path has no remoteReply route, so this
  // worker cannot honor the "/peer/reply on completion" obligation yet.
  // Failing visibly is contract-safe — the sender times out and reports.
  return jsonError(
    "remote ask is not supported by this negotium worker yet (no /peer/reply route back)",
    501,
  );
}

async function handleReply(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const body = await readBody(req);
  if (!body) return jsonError("invalid JSON body", 400);
  const protocolError = checkProtocol(body);
  if (protocolError) return protocolError;
  // This worker never sends cross-node asks (session-comm forward is a
  // stub), so there is never a pending ask to settle. 404 is the
  // contract-compliant answer (doc §2.1 #11) — the sender times out.
  return jsonError("no pending ask for this requestId", 404);
}

async function handleInputFile(req: Request): Promise<Response> {
  const peer = await requirePeer(req);
  if (!peer.ok) return peer.response;
  const originError = requirePrimaryOrigin(peer);
  if (originError) return originError;
  // No upload store / FileHooks exists on this worker yet. The hub surfaces
  // this as "attachment transfer failed" and the turn is not dispatched.
  return jsonError("attachment transfer is not supported by this negotium worker yet", 501);
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
    case "/api/v1/peer/provision":
      return handleProvision(req);
    case "/api/v1/peer/bind":
      return handleBind(req);
    case "/api/v1/peer/unbind":
      return handleUnbind(req);
    case "/api/v1/peer/turn":
      return handleTurn(req);
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
    case "/api/v1/peer/input-file":
      return handleInputFile(req);
    default:
      return jsonError("not found", 404);
  }
}
