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
  type compactTopicSession,
  ensurePersonalGeneral,
  getTopic,
  getVisibleTopics,
  isParticipant,
  latestRuntimeEventSeq,
  listApiMessages,
  listRecentRuntimeEventsForTopic,
  listRuntimeEventsAfter,
  NODE_CONTROL_TOKEN,
  RUN_DIR,
  type RuntimeBusEvent,
  STATE_DIR,
  type StoredRuntimeEvent,
  type startAiTurn,
  submitUserMessage,
  switchTopicModel,
  type TopicDto,
  TopicServiceError,
  topicService,
} from "@negotium/core";

export const NODE_CONTROL_PROTOCOL_VERSION = 1;
export const NODE_CONTROL_BASE_PATH = "/api/v1/control";
export const NODE_DAEMON_ROLE = "node-daemon";
export const NODE_DAEMON_INFO_PATH = resolve(RUN_DIR, "node-daemon.json");
const NODE_VERSION = "0.1.0";

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

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function topicsForUser(userId: string): TopicDto[] {
  return getVisibleTopics().filter((topic) => isParticipant(topic, userId));
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

function createEventStream(req: Request, userId: string, after: number): Response {
  const encoder = new TextEncoder();
  const allowedTopics = new Set(topicsForUser(userId).map((topic) => topic.id));
  let cursor = Math.max(0, after);
  let closed = false;
  let pumping = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown, id?: number) => {
        if (closed) return;
        const lines = [
          id === undefined ? "" : `id: ${id}`,
          `event: ${event}`,
          `data: ${JSON.stringify(data)}`,
        ]
          .filter(Boolean)
          .join("\n");
        controller.enqueue(encoder.encode(`${lines}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // The peer may already have closed the stream.
        }
      };
      const pump = () => {
        if (closed || pumping) return;
        pumping = true;
        try {
          while (!closed) {
            const events = listRuntimeEventsAfter(cursor, 500);
            if (events.length === 0) break;
            for (const event of events) {
              cursor = event.seq;
              if (event.type === "topic-created" || event.type === "topic-updated") {
                const topic = getTopic(event.topicId);
                if (topic && isParticipant(topic, userId)) allowedTopics.add(event.topicId);
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
        } finally {
          pumping = false;
        }
      };

      send("ready", { protocolVersion: NODE_CONTROL_PROTOCOL_VERSION, cursor });
      pump();
      pollTimer = setInterval(pump, 100);
      heartbeatTimer = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, 15_000);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      closed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
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
        ensurePersonalGeneral(userId);
        return Response.json({
          ok: true,
          protocolVersion: NODE_CONTROL_PROTOCOL_VERSION,
          nodeVersion: NODE_VERSION,
          topics: topicsForUser(userId),
          cursor: latestRuntimeEventSeq(),
        });
      }

      if (req.method === "GET" && path === "/topics") {
        const userId = requiredText(url.searchParams.get("user"), "user");
        return Response.json({ ok: true, topics: topicsForUser(userId) });
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
        return createEventStream(req, userId, Number.isFinite(parsed) ? parsed : 0);
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
        const { message } = submitUserMessage({
          topic,
          userId,
          text,
          sourceAdapter: "terminal",
          startTurn: options.startTurn,
        });
        return Response.json({ ok: true, message }, { status: 201 });
      }

      const recentMatch = path.match(/^\/topics\/([^/]+)\/recent-events$/);
      if (recentMatch && req.method === "GET") {
        const topicId = decodeURIComponent(recentMatch[1]);
        const userId = requiredText(url.searchParams.get("user"), "user");
        if (!topicForUser(topicId, userId)) return jsonError(404, "Topic not found");
        const events = listRecentRuntimeEventsForTopic(topicId).map(runtimeEvent);
        return Response.json({ ok: true, events });
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
      if (error instanceof TopicServiceError) return topicServiceError(error);
      return jsonError(400, error instanceof Error ? error.message : String(error));
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
