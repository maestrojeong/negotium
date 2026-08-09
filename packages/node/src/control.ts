import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  type AgentKind,
  appendApiMessage,
  type compactTopicSession,
  deleteVaultEntry,
  ensurePersonalGeneral,
  executeVaultCommand,
  getApiMessage,
  getTopic,
  getTopicStats,
  getVisibleTopics,
  isParticipant,
  latestRuntimeEventSeq,
  listApiMessages,
  listBackgroundSessionsForUser,
  listRecentRuntimeEventsForTopic,
  listRunningTopicQueries,
  listRuntimeEventsAfter,
  listVaultEntries,
  logger,
  NEGOTIUM_VERSION,
  NODE_CONTROL_TOKEN,
  NODE_ID,
  RUN_DIR,
  type RuntimeBusEvent,
  RuntimeGatewayIdempotencyConflictError,
  STATE_DIR,
  type StoredRuntimeEvent,
  saveVaultEntry,
  type startAiTurn,
  submitRuntimeGatewayTurn,
  submitUserMessage,
  switchTopicEffort,
  switchTopicModel,
  TopicDeriveBusyError,
  type TopicDto,
  TopicForkCompactionError,
  TopicServiceError,
  type TopicSurface,
  TopicTitleConflictError,
  topicService,
  upsertTopic,
} from "@negotium/core/node-host";
import { nodeFileStore } from "./files";
import { createPollingSseStream } from "./polling-sse";

export const NODE_CONTROL_PROTOCOL_VERSION = 1;
export const NODE_CONTROL_BASE_PATH = "/api/v1/control";
/** Stable gateway contract, intentionally separate from the UI control routes. */
export const NODE_RUNTIME_CONTRACT_VERSION = 1;

/**
 * Which Otium workspace a relayed gateway call speaks for (M-8).
 *
 * The gateway itself is loopback-only and authenticated with the host
 * capability, so it cannot tell one caller from another. The Otium adapter
 * verifies the peer token, resolves the workspace that token was minted in, and
 * states it here before swapping in the host capability.
 *
 * Presence, not truthiness, is the switch: an empty value means "the caller's
 * workspace is not resolved yet", which scopes the request to the unscoped
 * rooms rather than opening it to all of them. A co-located hub calling over
 * loopback sends no header at all and keeps the whole surface, as before.
 */
export const NODE_RUNTIME_SURFACE_SCOPE_HEADER = "x-negotium-surface-scope";
export const NODE_RUNTIME_CONTRACT_BASE_PATH = `${NODE_CONTROL_BASE_PATH}/runtime/v1`;
export const NODE_DAEMON_ROLE = "node-daemon";
export const NODE_DAEMON_INFO_PATH = resolve(RUN_DIR, "node-daemon.json");
const NODE_VERSION = NEGOTIUM_VERSION;

export interface NodeDaemonInfo {
  schemaVersion: 1;
  protocolVersion: number;
  nodeVersion: string;
  pid: number;
  port: number;
  stateDir: string;
  startedAt: string;
}

export interface NodeDaemonConnection {
  baseUrl: string;
  token: string;
  info?: NodeDaemonInfo;
}

export interface NodeDaemonStatus {
  running: boolean;
  info?: NodeDaemonInfo;
  error?: string;
}

interface ControlHandlerOptions {
  port: () => number;
  startedAt: string;
  requestShutdown: () => void;
  startTurn?: typeof startAiTurn;
  compactSession?: typeof compactTopicSession;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status });
}

/**
 * The workspace a gateway request belongs to, if the caller named one.
 *
 * Returns an empty object — not `{ surfaceScope: null }` — when the header is
 * absent, so a loopback hub keeps seeing the whole `otium` surface exactly as
 * it did before multi-join existed.
 */
function requestSurfaceScope(req: Request): { surfaceScope?: string | null } {
  const header = req.headers.get(NODE_RUNTIME_SURFACE_SCOPE_HEADER);
  if (header === null) return {};
  const scope = header.trim();
  return { surfaceScope: scope ? scope : null };
}

function topicServiceError(error: TopicServiceError): Response {
  const status =
    error.code === "TOPIC_NOT_FOUND" ? 404 : error.code === "TOPIC_FORBIDDEN" ? 403 : 400;
  return jsonError(status, error.message);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return Boolean(token) && safeEqual(token, NODE_CONTROL_TOKEN);
}

async function bodyRecord(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * A malformed request from the caller, safe to echo back as a 400.
 *
 * Anything that is *not* one of the control plane's typed errors is treated as
 * an internal fault: it gets logged and answered with a generic 500, because an
 * unexpected exception's message can carry filesystem paths or other internals
 * that should not reach a client.
 */
export class ControlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlRequestError";
  }
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ControlRequestError(`${name} is required`);
  }
  return value.trim();
}

function topicsForUser(userId: string, surface?: TopicSurface): TopicDto[] {
  const runningTopics = listRunningTopicQueries();
  return getVisibleTopics(surface ? { surface } : {})
    .filter((topic) => isParticipant(topic, userId))
    .map((topic) => {
      const runningQueryId = runningTopics.get(topic.id);
      return { ...topic, running: Boolean(runningQueryId), runningQueryId };
    });
}

/**
 * Surface a control-protocol client is speaking for. Absent means "no filter",
 * which keeps older adapters working while they are still being updated.
 */
function requestedSurface(url: URL): TopicSurface | undefined {
  const raw = url.searchParams.get("surface")?.trim();
  if (!raw) return undefined;
  return raw === "terminal" || raw === "telegram" || raw === "otium" ? raw : undefined;
}

function topicForUser(topicId: string, userId: string): TopicDto | null {
  const topic = getTopic(topicId);
  return topic && isParticipant(topic, userId) ? topic : null;
}

function runtimeEvent(event: StoredRuntimeEvent): RuntimeBusEvent {
  return {
    type: event.type,
    topicId: event.topicId,
    payload: event.payload,
    seq: event.seq,
    createdAt: event.createdAt,
  };
}

function createRuntimeContractEventStream(req: Request, after: number, topicId?: string): Response {
  let cursor = Math.max(0, after);
  return createPollingSseStream(req, {
    ready: { v: NODE_RUNTIME_CONTRACT_VERSION, cursor },
    pump(send) {
      while (true) {
        const events = listRuntimeEventsAfter(cursor, 500);
        if (events.length === 0) break;
        for (const event of events) {
          cursor = event.seq;
          if (!topicId || event.topicId === topicId) {
            send("runtime", runtimeEvent(event), event.seq);
          }
        }
        // A cursor is global because RuntimeBus ordering is global. This
        // lets a topic-filtered subscriber resume without rescanning it.
        send("cursor", { cursor }, cursor);
        if (events.length < 500) break;
      }
    },
  });
}

function createEventStream(
  req: Request,
  userId: string,
  after: number,
  surface?: TopicSurface,
): Response {
  const allowedTopics = new Set(topicsForUser(userId, surface).map((topic) => topic.id));
  let cursor = Math.max(0, after);
  return createPollingSseStream(req, {
    ready: { protocolVersion: NODE_CONTROL_PROTOCOL_VERSION, cursor },
    pump(send) {
      while (true) {
        const events = listRuntimeEventsAfter(cursor, 500);
        if (events.length === 0) break;
        for (const event of events) {
          cursor = event.seq;
          if (event.type === "topic-created" || event.type === "topic-updated") {
            const topic = getTopic(event.topicId);
            // Re-check the surface, not just membership: a room created on
            // another surface while this stream is open must never be admitted,
            // or the initial filtered list is undone by the first event.
            const admissible =
              topic && isParticipant(topic, userId) && (!surface || topic.surface === surface);
            if (admissible) allowedTopics.add(event.topicId);
            else allowedTopics.delete(event.topicId);
          }
          const visible = allowedTopics.has(event.topicId);
          if (visible) send("runtime", runtimeEvent(event), event.seq);
          if (event.type === "topic-deleted") allowedTopics.delete(event.topicId);
        }
        // Advance reconnect cursors even when a batch only contained topics
        // that are not visible to this user.
        send("cursor", { cursor }, cursor);
        if (events.length < 500) break;
      }
    },
  });
}

/** Authenticated loopback REST/SSE surface used by short-lived UI clients. */
export function createNodeControlHandler(
  options: ControlHandlerOptions,
): (req: Request) => Promise<Response | null> {
  return async (req) => {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(NODE_CONTROL_BASE_PATH)) return null;
    if (!authorized(req)) return jsonError(401, "Unauthorized");

    const path = url.pathname.slice(NODE_CONTROL_BASE_PATH.length) || "/";
    try {
      const runtimePath = url.pathname.startsWith(NODE_RUNTIME_CONTRACT_BASE_PATH)
        ? url.pathname.slice(NODE_RUNTIME_CONTRACT_BASE_PATH.length) || "/"
        : null;
      if (runtimePath !== null) {
        if (req.method === "GET" && runtimePath === "/health") {
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            nodeVersion: NODE_VERSION,
            // Which node this is, so a host can tell a re-pointed base URL from
            // a topic whose owner withdrew it.
            nodeId: NODE_ID,
            capabilities: [
              "turn-submit-idempotent",
              "turn-events-sse-resume",
              "canonical-topic-read",
              "canonical-message-read",
              "canonical-topic-list",
              "canonical-topic-create",
              "canonical-history-import",
            ],
            cursor: latestRuntimeEventSeq(),
          });
        }

        if (req.method === "POST" && runtimePath === "/turns") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = requiredText(body.topicId, "topicId");
          const userId = requiredText(body.userId, "userId");
          const actorUserId =
            body.actorUserId === undefined
              ? undefined
              : requiredText(body.actorUserId, "actorUserId");
          const actorLabel =
            body.actorLabel === undefined ? undefined : requiredText(body.actorLabel, "actorLabel");
          const vaultUserId =
            body.vaultUserId === undefined
              ? undefined
              : requiredText(body.vaultUserId, "vaultUserId");
          const text = requiredText(body.text, "text");
          const clientMessageId = requiredText(body.clientMessageId, "clientMessageId");
          const requestId =
            body.requestId === undefined ? undefined : requiredText(body.requestId, "requestId");
          const threadRootId =
            body.threadRootId === undefined
              ? undefined
              : requiredText(body.threadRootId, "threadRootId");
          const topic = getTopic(topicId);
          if (!topic) return jsonError(404, "Topic not found");
          if (!topic.participants.some((participant) => participant.userId === userId)) {
            return jsonError(404, "Topic not found");
          }
          if (threadRootId) {
            // The root must be a real, undeleted message of this room that is
            // not itself a reply — threads are flat, and answering into a
            // thread nobody can open is worse than refusing.
            const root = getApiMessage(topicId, threadRootId);
            if (!root || root.deleted || root.threadRootId) {
              return jsonError(400, "threadRootId does not identify a thread root in this topic");
            }
          }
          const submission = submitRuntimeGatewayTurn({
            topic,
            userId,
            actorUserId,
            actorLabel,
            vaultUserId,
            text,
            clientMessageId,
            requestId,
            allowAutoContinue: body.allowAutoContinue !== false,
            ...(threadRootId ? { threadRootId } : {}),
          });
          return Response.json(
            {
              ok: true,
              v: NODE_RUNTIME_CONTRACT_VERSION,
              accepted: true,
              deduplicated: submission.deduplicated,
              requestId: submission.requestId,
              clientMessageId: submission.clientMessageId,
              topicId: submission.topicId,
              messageId: submission.messageId,
              cursor: submission.ackCursor,
            },
            { status: 202 },
          );
        }

        if (req.method === "GET" && runtimePath === "/events") {
          const parsed = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
          const topicId = url.searchParams.get("topicId")?.trim() || undefined;
          return createRuntimeContractEventStream(
            req,
            Number.isFinite(parsed) ? parsed : 0,
            topicId,
          );
        }

        const runtimeMessagesMatch = runtimePath.match(/^\/topics\/([^/]+)\/messages$/);
        if (runtimeMessagesMatch && req.method === "GET") {
          const topicId = decodeURIComponent(runtimeMessagesMatch[1]);
          if (!getTopic(topicId)) return jsonError(404, "Topic not found");
          const cursor = url.searchParams.get("cursor");
          const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
          const result = listApiMessages(topicId, {
            cursor,
            limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
          });
          return Response.json({ ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, ...result });
        }

        /**
         * Topic discovery for the gateway.
         *
         * The gateway only ever sees the `otium` surface (S-6). Membership of
         * a surface *is* the consent that `accessMode=shared` used to encode,
         * so there is no per-topic flag left to filter on and no way for a host
         * to enumerate the owner's terminal or telegram rooms.
         */
        if (req.method === "GET" && runtimePath === "/topics") {
          const topics = getVisibleTopics({ surface: "otium", ...requestSurfaceScope(req) });
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            topics,
            cursor: latestRuntimeEventSeq(),
          });
        }

        /**
         * Let a host create a canonical topic for a room it is about to show.
         *
         * Without this, a room created in Otium existed only in Otium's store,
         * so Terminal and Telegram could not see it and its turns ran on the
         * host instead of the node — two canonical stores, which is the failure
         * D-1 exists to prevent. The room is born on the `otium` surface: a
         * host only asks for one when it is already surfacing it.
         */
        if (req.method === "POST" && runtimePath === "/topics") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const userId = requiredText(body.userId, "userId");
          const title = requiredText(body.title, "title");
          const agent = body.agent;
          if (agent !== undefined && !["claude", "codex", "maestro"].includes(String(agent))) {
            return jsonError(400, "Invalid agent");
          }
          const topic = topicService.create({
            title,
            userId,
            kind: "agent",
            surface: "otium",
            // Born in the workspace that asked for it, not in whichever one
            // this process happens to have resolved last (M-1).
            ...requestSurfaceScope(req),
            ...(agent ? { agent: agent as AgentKind } : {}),
          });
          return Response.json(
            { ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, topic },
            { status: 201 },
          );
        }

        /**
         * One-time history import, for adopting a room that predates the node.
         *
         * A host that mapped an existing room would otherwise hide its own
         * transcript: the room reads from the node, and the node has nothing.
         * This writes the messages verbatim — author, id and timestamp — and
         * deliberately does NOT start a turn, unlike the message-post route.
         *
         * Two guards, because this is the strongest write in the contract:
         *  - it refuses a topic that already holds messages, so it can only
         *    seed, never rewrite or interleave history;
         *  - it is not exposed through the remote forward, so a host may only
         *    import into a node on its own machine.
         */
        const importMatch = runtimePath.match(/^\/topics\/([^/]+)\/import$/);
        if (importMatch && req.method === "POST") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(importMatch[1]);
          const topic = getTopic(topicId);
          if (!topic) return jsonError(404, "Topic not found");
          if (!Array.isArray(body.messages)) {
            return jsonError(400, "messages must be an array");
          }
          if (listApiMessages(topicId, { limit: 1 }).page.length > 0) {
            return jsonError(409, "topic already has messages");
          }
          const messages = body.messages as Record<string, unknown>[];
          for (const [index, message] of messages.entries()) {
            if (
              typeof message?.id !== "string" ||
              typeof message?.authorId !== "string" ||
              typeof message?.text !== "string" ||
              typeof message?.createdAt !== "string"
            ) {
              return jsonError(400, `messages[${index}] needs id, authorId, text and createdAt`);
            }
          }
          let imported = 0;
          for (const message of messages) {
            appendApiMessage(
              {
                id: message.id as string,
                topicId,
                authorId: message.authorId as string,
                text: message.text as string,
                createdAt: message.createdAt as string,
                deleted: false,
                ...(typeof message.agentType === "string"
                  ? { agentType: message.agentType as AgentKind }
                  : {}),
                ...(typeof message.model === "string" ? { model: message.model as string } : {}),
              },
              // Imported history is not news: notifying would replay months of
              // messages to every open client. The topic's timestamps are set
              // once below, because `appendApiMessage` only ever moves
              // `lastMessageAt` *forward* — the topic was created seconds ago, so
              // per-message updates would all be ignored and the room would sort
              // as if it had just been written to.
              { notify: false, updateTopicLastMessageAt: false },
            );
            imported += 1;
          }
          if (imported > 0) {
            const stamps = messages.map((message) => message.createdAt as string).sort();
            upsertTopic({
              ...topic,
              // A room cannot honestly be newer than the history it now holds.
              createdAt: stamps[0] < topic.createdAt ? stamps[0] : topic.createdAt,
              lastMessageAt: stamps[stamps.length - 1],
            });
          }
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            imported,
          });
        }

        const runtimeTopicMatch = runtimePath.match(/^\/topics\/([^/]+)$/);
        if (runtimeTopicMatch && req.method === "GET") {
          const topic = getTopic(decodeURIComponent(runtimeTopicMatch[1]));
          if (!topic) return jsonError(404, "Topic not found");
          return Response.json({ ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, topic });
        }

        return jsonError(404, "Runtime contract route not found");
      }

      if (req.method === "GET" && path === "/status") {
        return Response.json({
          ok: true,
          protocolVersion: NODE_CONTROL_PROTOCOL_VERSION,
          nodeVersion: NODE_VERSION,
          pid: process.pid,
          port: options.port(),
          stateDir: STATE_DIR,
          startedAt: options.startedAt,
        });
      }

      if (req.method === "POST" && path === "/shutdown") {
        setTimeout(options.requestShutdown, 10);
        return Response.json({ ok: true });
      }

      if (req.method === "GET" && path === "/session") {
        const userId = requiredText(url.searchParams.get("user"), "user");
        ensurePersonalGeneral(userId, requestedSurface(url));
        return Response.json({
          ok: true,
          protocolVersion: NODE_CONTROL_PROTOCOL_VERSION,
          nodeVersion: NODE_VERSION,
          topics: topicsForUser(userId, requestedSurface(url)),
          cursor: latestRuntimeEventSeq(),
        });
      }

      if (req.method === "GET" && path === "/topics") {
        const userId = requiredText(url.searchParams.get("user"), "user");
        return Response.json({ ok: true, topics: topicsForUser(userId, requestedSurface(url)) });
      }

      if (req.method === "GET" && path === "/background-sessions") {
        const userId = requiredText(url.searchParams.get("user"), "user");
        return Response.json({ ok: true, sessions: listBackgroundSessionsForUser(userId) });
      }

      const fileMatch = path.match(/^\/files\/([0-9a-f-]+)$/i);
      if (fileMatch && req.method === "GET") {
        const userId = requiredText(url.searchParams.get("user"), "user");
        return nodeFileStore.response(fileMatch[1], userId) ?? jsonError(404, "File not found");
      }

      if (req.method === "POST" && path === "/vault/command") {
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const commandLine = requiredText(body.commandLine, "commandLine");
        const result = executeVaultCommand(userId, commandLine);
        if (result === null) return jsonError(400, "Invalid Vault command");
        return Response.json({ ok: true, result });
      }

      if (req.method === "GET" && path === "/vault") {
        const userId = requiredText(url.searchParams.get("user"), "user");
        return Response.json({ ok: true, entries: listVaultEntries(userId) });
      }

      if (req.method === "POST" && path === "/vault") {
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const key = requiredText(body.key, "key");
        if (typeof body.value !== "string") throw new ControlRequestError("value is required");
        const description = body.description === undefined ? "" : String(body.description);
        return Response.json({
          ok: true,
          result: saveVaultEntry(userId, key, body.value, description),
        });
      }

      if (req.method === "DELETE" && path === "/vault") {
        const userId = requiredText(url.searchParams.get("user"), "user");
        const key = requiredText(url.searchParams.get("key"), "key");
        return Response.json({ ok: true, deleted: deleteVaultEntry(userId, key) });
      }

      if (req.method === "POST" && path === "/topics") {
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const title = requiredText(body.title, "title");
        const agent = body.agent;
        if (agent !== undefined && !["claude", "codex", "maestro"].includes(String(agent))) {
          return jsonError(400, "Invalid agent");
        }
        const topic = topicService.create({
          title,
          userId,
          kind: "agent",
          ...(agent ? { agent: agent as AgentKind } : {}),
        });
        return Response.json({ ok: true, topic }, { status: 201 });
      }

      if (req.method === "GET" && path === "/events") {
        const userId = requiredText(url.searchParams.get("user"), "user");
        const parsed = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
        return createEventStream(
          req,
          userId,
          Number.isFinite(parsed) ? parsed : 0,
          requestedSurface(url),
        );
      }

      const messagesMatch = path.match(/^\/topics\/([^/]+)\/messages$/);
      if (messagesMatch && req.method === "GET") {
        const topicId = decodeURIComponent(messagesMatch[1]);
        const userId = requiredText(url.searchParams.get("user"), "user");
        if (!topicForUser(topicId, userId)) return jsonError(404, "Topic not found");
        const cursor = url.searchParams.get("cursor");
        const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
        const result = listApiMessages(topicId, {
          cursor,
          limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
        });
        return Response.json({
          ok: true,
          messages: result.page,
          cursor: result.cursor,
          hasMore: result.hasMore,
        });
      }
      if (messagesMatch && req.method === "POST") {
        const topicId = decodeURIComponent(messagesMatch[1]);
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const text = requiredText(body.text, "text");
        const topic = topicForUser(topicId, userId);
        if (!topic) return jsonError(404, "Topic not found");
        const sourceAdapter =
          body.sourceAdapter === "telegram" || body.sourceAdapter === "otium"
            ? body.sourceAdapter
            : "terminal";
        const { message, queryId } = submitUserMessage({
          topic,
          userId,
          text,
          sourceAdapter,
          visualTools: body.visualTools === true,
          fileDeliveryTools: body.fileDeliveryTools === true,
          startTurn: options.startTurn,
        });
        return Response.json({ ok: true, message, queryId }, { status: 201 });
      }

      const recentMatch = path.match(/^\/topics\/([^/]+)\/recent-events$/);
      if (recentMatch && req.method === "GET") {
        const topicId = decodeURIComponent(recentMatch[1]);
        const userId = requiredText(url.searchParams.get("user"), "user");
        if (!topicForUser(topicId, userId)) return jsonError(404, "Topic not found");
        const events = listRecentRuntimeEventsForTopic(topicId).map(runtimeEvent);
        return Response.json({ ok: true, events });
      }

      const usageMatch = path.match(/^\/topics\/([^/]+)\/usage$/);
      if (usageMatch && req.method === "GET") {
        const topicId = decodeURIComponent(usageMatch[1]);
        const userId = requiredText(url.searchParams.get("user"), "user");
        if (!topicForUser(topicId, userId)) return jsonError(404, "Topic not found");
        return Response.json({ ok: true, usage: getTopicStats(userId, topicId) });
      }

      const modelMatch = path.match(/^\/topics\/([^/]+)\/model$/);
      if (modelMatch && req.method === "POST") {
        const topicId = decodeURIComponent(modelMatch[1]);
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const model = requiredText(body.model, "model");
        if (!topicForUser(topicId, userId)) return jsonError(404, "Topic not found");
        const result = switchTopicModel({ topicId, userId, model });
        if (!result.ok) return jsonError(400, result.error);
        return Response.json({ ok: true, model: result.model, result: result.text });
      }

      const effortMatch = path.match(/^\/topics\/([^/]+)\/effort$/);
      if (effortMatch && req.method === "POST") {
        const topicId = decodeURIComponent(effortMatch[1]);
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const effort = requiredText(body.effort, "effort");
        if (!topicForUser(topicId, userId)) return jsonError(404, "Topic not found");
        const result = switchTopicEffort({ topicId, userId, effort });
        if (!result.ok) return jsonError(400, result.error);
        return Response.json({ ok: true, effort: result.effort, result: result.text });
      }

      const deleteMatch = path.match(/^\/topics\/([^/]+)$/);
      if (deleteMatch && req.method === "DELETE") {
        const topicId = decodeURIComponent(deleteMatch[1]);
        const userId = requiredText(url.searchParams.get("user"), "user");
        await topicService.delete({ topicId, userId });
        return Response.json({ ok: true });
      }

      const abortMatch = path.match(/^\/topics\/([^/]+)\/abort$/);
      if (abortMatch && req.method === "POST") {
        const topicId = decodeURIComponent(abortMatch[1]);
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        return Response.json({ ok: true, aborted: topicService.abortTurn(topicId, userId) });
      }

      const resetMatch = path.match(/^\/topics\/([^/]+)\/session\/reset$/);
      if (resetMatch && req.method === "POST") {
        const topicId = decodeURIComponent(resetMatch[1]);
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const result = await topicService.reset({
          topicId,
          userId,
          reason: "node-control-session-reset",
        });
        if (result.isError) return jsonError(409, result.text);
        return Response.json({ ok: true, result: result.text });
      }

      const compactMatch = path.match(/^\/topics\/([^/]+)\/session\/compact$/);
      if (compactMatch && req.method === "POST") {
        const topicId = decodeURIComponent(compactMatch[1]);
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const result = await topicService.compact({
          topicId,
          userId,
          reason: "node-control-session-compact",
          compactSession: options.compactSession,
        });
        if (result.isError) return jsonError(409, result.text);
        return Response.json({ ok: true, result: result.text });
      }

      const deriveMatch = path.match(/^\/topics\/([^/]+)\/derive$/);
      if (deriveMatch && req.method === "POST") {
        const topicId = decodeURIComponent(deriveMatch[1]);
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        if (typeof body.copyHistory !== "boolean") {
          return jsonError(400, "copyHistory must be a boolean");
        }
        const copyHistory = body.copyHistory;
        const source = topicForUser(topicId, userId);
        if (!source || source.kind === "manager") return jsonError(404, "Topic not found");
        if (body.name !== undefined && typeof body.name !== "string") {
          return jsonError(400, "name must be a string");
        }
        const name =
          typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
        const derived = await topicService.derive({
          sourceTopicId: topicId,
          userId,
          copyHistory,
          ...(name ? { name } : {}),
        });
        if (!derived) return jsonError(500, "Failed to derive topic");
        return Response.json({ ok: true, topic: derived }, { status: 201 });
      }

      const answerMatch = path.match(/^\/questions\/([^/]+)\/answer$/);
      if (answerMatch && req.method === "POST") {
        const messageId = decodeURIComponent(answerMatch[1]);
        const body = await bodyRecord(req);
        const topicId = requiredText(body.topicId, "topicId");
        const userId = requiredText(body.userId, "userId");
        const label = requiredText(body.label, "label");
        const result = topicService.answerQuestion(topicId, messageId, label, userId);
        return Response.json(result, { status: result.ok ? 200 : 409 });
      }

      return jsonError(404, "Control route not found");
    } catch (error) {
      if (error instanceof RuntimeGatewayIdempotencyConflictError) {
        return jsonError(409, error.message);
      }
      if (error instanceof TopicServiceError) return topicServiceError(error);
      if (error instanceof TopicDeriveBusyError) return jsonError(409, error.message);
      if (error instanceof TopicForkCompactionError) return jsonError(503, error.message);
      if (error instanceof TopicTitleConflictError) return jsonError(409, error.message);
      if (error instanceof ControlRequestError) return jsonError(400, error.message);
      // `decodeURIComponent` on a malformed path segment (e.g. `/topics/%/…`)
      // throws URIError. That is bad input from the caller, not a node fault.
      if (error instanceof URIError) return jsonError(400, "Malformed URL encoding");
      // Unclassified: a bug or an unavailable dependency, not a client mistake.
      // Log the detail locally and return nothing that could leak internals.
      logger.error({ err: error, method: req.method, path }, "control: unhandled request error");
      return jsonError(500, "Internal control-plane error");
    }
  };
}

export function writeNodeDaemonInfo(port: number, startedAt: string): NodeDaemonInfo {
  const info: NodeDaemonInfo = {
    schemaVersion: 1,
    protocolVersion: NODE_CONTROL_PROTOCOL_VERSION,
    nodeVersion: NODE_VERSION,
    pid: process.pid,
    port,
    stateDir: STATE_DIR,
    startedAt,
  };
  mkdirSync(dirname(NODE_DAEMON_INFO_PATH), { recursive: true });
  const temporary = `${NODE_DAEMON_INFO_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, NODE_DAEMON_INFO_PATH);
  chmodSync(NODE_DAEMON_INFO_PATH, 0o600);
  return info;
}

export function readNodeDaemonInfo(): NodeDaemonInfo | null {
  if (!existsSync(NODE_DAEMON_INFO_PATH)) return null;
  try {
    const value = JSON.parse(readFileSync(NODE_DAEMON_INFO_PATH, "utf8")) as NodeDaemonInfo;
    if (
      value?.schemaVersion !== 1 ||
      value.stateDir !== STATE_DIR ||
      !Number.isInteger(value.protocolVersion) ||
      !Number.isInteger(value.pid) ||
      !Number.isInteger(value.port) ||
      value.port <= 0
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function removeNodeDaemonInfo(expected: { pid: number; port: number }): void {
  const current = readNodeDaemonInfo();
  if (!current || current.pid !== expected.pid || current.port !== expected.port) return;
  try {
    unlinkSync(NODE_DAEMON_INFO_PATH);
  } catch {
    // A competing replacement may already have removed it.
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectNodeDaemon(timeoutMs = 750): Promise<NodeDaemonStatus> {
  const info = readNodeDaemonInfo();
  if (!info) return { running: false };
  try {
    const response = await fetchWithTimeout(
      `http://127.0.0.1:${info.port}${NODE_CONTROL_BASE_PATH}/status`,
      { headers: { authorization: `Bearer ${NODE_CONTROL_TOKEN}` } },
      timeoutMs,
    );
    if (!response.ok) throw new Error(`status returned HTTP ${response.status}`);
    const status = (await response.json()) as Record<string, unknown>;
    if (
      status.protocolVersion !== NODE_CONTROL_PROTOCOL_VERSION ||
      status.stateDir !== STATE_DIR ||
      status.pid !== info.pid
    ) {
      throw new Error("node identity does not match the local state directory");
    }
    return { running: true, info };
  } catch (error) {
    return {
      running: false,
      info,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function waitForNodeDaemon(timeoutMs = 10_000): Promise<NodeDaemonConnection> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "node did not publish connection information";
  while (Date.now() < deadline) {
    const status = await inspectNodeDaemon();
    if (status.running && status.info) {
      return {
        baseUrl: `http://127.0.0.1:${status.info.port}`,
        token: NODE_CONTROL_TOKEN,
        info: status.info,
      };
    }
    if (status.error) lastError = status.error;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Negotium node failed to start: ${lastError}`);
}

export async function stopNodeDaemon(timeoutMs = 3_000): Promise<boolean> {
  const status = await inspectNodeDaemon();
  if (!status.running || !status.info) return false;
  const response = await fetchWithTimeout(
    `http://127.0.0.1:${status.info.port}${NODE_CONTROL_BASE_PATH}/shutdown`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${NODE_CONTROL_TOKEN}` },
    },
    timeoutMs,
  );
  if (!response.ok) throw new Error(`node shutdown returned HTTP ${response.status}`);
  return true;
}
