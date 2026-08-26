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
  type AiMode,
  appendApiMessage,
  type compactTopicSession,
  deleteVaultEntry,
  earliestRuntimeEventSeq,
  ensurePersonalGeneral,
  executeVaultCommand,
  getApiMessage,
  getApiTopicConfig,
  getGlobalAiName,
  getLastMessagePreviews,
  getPortableTopicVisual,
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
  listThreadMessages,
  listVaultEntries,
  logger,
  NEGOTIUM_VERSION,
  NODE_CONTROL_TOKEN,
  NODE_ID,
  RUN_DIR,
  type RuntimeBusEvent,
  RuntimeGatewayIdempotencyConflictError,
  readDecisions,
  STATE_DIR,
  type StoredRuntimeEvent,
  saveVaultEntry,
  setApiMessageReactions,
  setApiTopicConfig,
  setGlobalAiName,
  softDeleteApiMessage,
  type startAiTurn,
  submitRuntimeGatewayTurn,
  submitUserMessage,
  switchTopicEffort,
  switchTopicModel,
  type TopicConfig,
  type TopicDeletedMeta,
  TopicDeriveBusyError,
  type TopicDto,
  TopicForkCompactionError,
  TopicServiceError,
  type TopicSurface,
  TopicTitleConflictError,
  TopicUpdateConflictError,
  TopicValidationError,
  topicService,
  updateApiMessageText,
  updateTopicSettings,
  upsertTopic,
  WsHub,
  writeDecisionGraphSvg,
} from "@negotium/core/node-host";
import {
  RUNTIME_GATEWAY_CONTROL_PATH,
  RUNTIME_GATEWAY_VERSION,
} from "@negotium/core/runtime-gateway";
import {
  type CronJobPatch,
  type CronJobRecord,
  countCronRuns,
  createCronJob,
  cronActorOwnerUserId,
  deleteCronJob,
  getCronJob,
  getLastCronRun,
  listCronJobs,
  listCronJobsForActorOwner,
  listCronScriptsForScope,
  updateCronJobWithContextReset,
} from "@negotium/module-cron";
import { MAX_NODE_UPLOAD_BYTES, nodeFileStore } from "./files";
import { createPollingSseStream } from "./polling-sse";

export const NODE_CONTROL_PROTOCOL_VERSION = 1;
export const NODE_CONTROL_BASE_PATH = "/api/v1/control";
/** Stable gateway contract, intentionally separate from the UI control routes. */
export const NODE_RUNTIME_CONTRACT_VERSION = RUNTIME_GATEWAY_VERSION;

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

/**
 * Set when the node serves more than one workspace, so a room filed under none
 * is ambiguous rather than legacy.
 *
 * With a single attachment an unscoped room must stay reachable — that is every
 * room that predates the column. With several, granting it to every attached
 * hub would undo the isolation, so the adapter says which situation this is.
 */
export const NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER = "x-negotium-surface-scope-strict";
export const NODE_RUNTIME_CONTRACT_BASE_PATH = RUNTIME_GATEWAY_CONTROL_PATH;
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

/**
 * May a gateway request reach this room?
 *
 * The workspace check has to live on every topic-scoped route, not just on
 * discovery: a caller that already knows a room id would otherwise read its
 * transcript and run turns in it (M-8). A room with no workspace is filed under
 * none and stays reachable, exactly as `peerAddressable` treats it, so rooms
 * that predate the column are not stranded.
 */
function topicInRequestScope(req: Request, topic: Pick<TopicDto, "surfaceScope">): boolean {
  const scope = requestSurfaceScope(req);
  if (!("surfaceScope" in scope)) return true;
  const roomScope = topic.surfaceScope ?? null;
  if (roomScope === null) return req.headers.get(NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER) !== "1";
  return roomScope === (scope.surfaceScope ?? null);
}

/**
 * The rooms a gateway caller may enumerate.
 *
 * Mirrors {@link topicInRequestScope} exactly, so discovery and direct access
 * can never disagree: no header is a loopback hub and sees the whole surface;
 * a named workspace sees its own rooms, plus the unscoped ones only while this
 * node serves a single workspace and they are therefore legacy rather than
 * ambiguous.
 */
function gatewayVisibleTopics(req: Request): TopicDto[] {
  const scope = requestSurfaceScope(req);
  if (!("surfaceScope" in scope)) return getVisibleTopics({ surface: "otium" });
  const own = getVisibleTopics({ surface: "otium", surfaceScope: scope.surfaceScope ?? null });
  const strict = req.headers.get(NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER) === "1";
  if (strict || scope.surfaceScope === null) return own;
  return own.concat(getVisibleTopics({ surface: "otium", surfaceScope: null }));
}

function topicServiceError(error: TopicServiceError): Response {
  const status =
    error.code === "TOPIC_NOT_FOUND" ? 404 : error.code === "TOPIC_FORBIDDEN" ? 403 : 400;
  return jsonError(status, error.message);
}

function cronScope(req: Request): string | null | undefined {
  return requestSurfaceScope(req).surfaceScope;
}

function cronJobInScope(req: Request, job: CronJobRecord): boolean {
  const topic = getTopic(job.topicId);
  return Boolean(topic && topicInRequestScope(req, topic));
}

function cronJobDto(
  job: CronJobRecord,
  actorUserId: string,
  actorIsAdmin: boolean,
  allowedScripts: ReadonlySet<string>,
) {
  const actorOwnerUserId = cronActorOwnerUserId(job);
  const canMutate = actorIsAdmin || actorOwnerUserId === actorUserId;
  const prompt = job.prompt?.trim() ?? "";
  return {
    id: job.id,
    name: job.name,
    executionPrincipalUserId: job.ownerUserId,
    actorOwnerUserId,
    topicId: job.topicId,
    source: prompt ? "prompt" : "script",
    script: job.script ?? null,
    scriptExists: job.script ? allowedScripts.has(job.script) : true,
    prompt: canMutate ? prompt || null : null,
    promptPreview: prompt ? prompt.replace(/\s+/g, " ").slice(0, 180) : null,
    summary: job.summary ?? null,
    schedule: job.schedule,
    timezone: job.timezone ?? null,
    enabled: job.enabled,
    agent: job.agent ?? null,
    model: job.model ?? null,
    effort: job.effort ?? null,
    nextRunAt: job.nextRunAt,
    runCount: countCronRuns(job.id),
    lastRun: getLastCronRun(job.id),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    canMutate,
  };
}

function cronJobForMutation(
  req: Request,
  jobId: string,
  userId: string,
  actorUserId: string,
  actorIsAdmin: boolean,
): CronJobRecord | Response {
  const job = getCronJob(jobId);
  if (!job || job.ownerUserId !== userId || !cronJobInScope(req, job)) {
    return jsonError(404, "Cron job not found");
  }
  if (!actorIsAdmin && cronActorOwnerUserId(job) !== actorUserId) {
    return jsonError(403, "Only the Cron job owner can mutate it");
  }
  return job;
}

function booleanParam(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
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

function isTopicDeletedMeta(payload: unknown): payload is TopicDeletedMeta {
  if (!payload || typeof payload !== "object") return false;
  const { surface, surfaceScope } = payload as Record<string, unknown>;
  return (
    (surface === undefined ||
      surface === "terminal" ||
      surface === "telegram" ||
      surface === "otium") &&
    (surfaceScope === undefined || typeof surfaceScope === "string" || surfaceScope === null)
  );
}

function createRuntimeContractEventStream(
  req: Request,
  after: number,
  topicId?: string,
  scope: { surfaceScope?: string | null } = {},
): Response {
  // A workspace-scoped subscriber without a topic filter would otherwise be fed
  // every other workspace's events. Resolving each event's room is a cache hit
  // in the common case and the stream is already per-event work.
  const scoped = "surfaceScope" in scope;
  const visible = new Map<string, boolean>();
  const scopeAllows = (topic: Pick<TopicDto, "surface" | "surfaceScope">): boolean =>
    // Unlike the topic list, this stream has no `surface` query parameter.
    // Keep it on the gateway's Otium-only contract here so an unfiltered
    // subscriber cannot discover terminal or Telegram rooms through events.
    Boolean(
      // A filtered stream is an existing per-topic contract and remains
      // usable by non-Otium adapters. Only global discovery is Otium-only,
      // matching the gateway's unfiltered `/topics` contract.
      (topicId || topic.surface === "otium") && (!scoped || topicInRequestScope(req, topic)),
    );
  const eventInScope = (event: StoredRuntimeEvent): boolean => {
    const eventTopicId = event.topicId;
    // Topic lifecycle events may change the fields used for this decision.
    // Re-evaluate them so a previously visible room cannot remain visible after
    // being moved to another surface or workspace scope.
    if (event.type === "topic-created" || event.type === "topic-updated") {
      visible.delete(eventTopicId);
    }
    // A deleted row cannot be re-checked. Do not let an earlier cached result
    // bypass the pre-delete scope recorded on the event.
    if (event.type === "topic-deleted") visible.delete(eventTopicId);
    const cached = visible.get(eventTopicId);
    if (cached !== undefined) return cached;
    const topic = getTopic(eventTopicId);
    if (topic) {
      const allowed = scopeAllows(topic);
      visible.set(eventTopicId, allowed);
      return allowed;
    }
    // The row is gone by the time a `topic-deleted` event reaches this
    // stream (delete order is: drop the row, then broadcast). Re-querying
    // `getTopic` above therefore always misses for this one event type,
    // which used to drop every deletion notice on the floor — including the
    // one a mirroring host needs to remove its own copy of the room. The
    // event carries the room's pre-delete scope for exactly this case, so
    // fall back to that instead of caching a false negative.
    if (event.type === "topic-deleted") {
      if (
        isTopicDeletedMeta(event.payload) &&
        (event.payload.surface !== undefined || event.payload.surfaceScope !== undefined)
      ) {
        // Not cached: a topic id is only ever deleted once, so there is no
        // repeat lookup to save, and caching `true` here would also make
        // later, unrelated events for a reused-in-tests id visible.
        return scopeAllows(event.payload);
      }
    }
    visible.set(eventTopicId, false);
    return false;
  };
  let cursor = Math.max(0, after);
  let reportedCursor = cursor;
  const oldestCursor = earliestRuntimeEventSeq();
  return createPollingSseStream(req, {
    ready: {
      v: NODE_RUNTIME_CONTRACT_VERSION,
      cursor,
      oldestCursor,
      truncated: oldestCursor > 0 && cursor < oldestCursor - 1,
    },
    pump(send) {
      for (let batch = 0; batch < 5; batch += 1) {
        const events = listRuntimeEventsAfter(cursor, 500);
        if (events.length === 0) {
          if (reportedCursor < cursor && send("cursor", { cursor }, cursor))
            reportedCursor = cursor;
          break;
        }
        for (const event of events) {
          if ((!topicId || event.topicId === topicId) && eventInScope(event)) {
            if (!send("runtime", runtimeEvent(event), event.seq)) return;
          }
          cursor = event.seq;
        }
        // A cursor is global because RuntimeBus ordering is global. This
        // lets a topic-filtered subscriber resume without rescanning it.
        if (!send("cursor", { cursor }, cursor)) return;
        reportedCursor = cursor;
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
  let reportedCursor = cursor;
  const oldestCursor = earliestRuntimeEventSeq();
  return createPollingSseStream(req, {
    ready: {
      protocolVersion: NODE_CONTROL_PROTOCOL_VERSION,
      cursor,
      oldestCursor,
      truncated: oldestCursor > 0 && cursor < oldestCursor - 1,
    },
    pump(send) {
      for (let batch = 0; batch < 5; batch += 1) {
        const events = listRuntimeEventsAfter(cursor, 500);
        if (events.length === 0) {
          if (reportedCursor < cursor && send("cursor", { cursor }, cursor))
            reportedCursor = cursor;
          break;
        }
        for (const event of events) {
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
          if (visible && !send("runtime", runtimeEvent(event), event.seq)) return;
          cursor = event.seq;
          if (event.type === "topic-deleted") allowedTopics.delete(event.topicId);
        }
        // Advance reconnect cursors even when a batch only contained topics
        // that are not visible to this user.
        if (!send("cursor", { cursor }, cursor)) return;
        reportedCursor = cursor;
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
            // This node's own AI persona name (node-local, see `/ai-name`). Read
            // here rather than only through the dedicated control route because
            // `/health` is the one GET the gateway forward already relays to a
            // worker (D-2) — exposing it here means a host can show which AI is
            // actually running a room without adding a new forwarded route.
            aiName: getGlobalAiName(),
            capabilities: [
              "turn-submit-idempotent",
              "turn-events-sse-resume",
              "canonical-topic-read",
              "canonical-message-read",
              "canonical-message-delete",
              "canonical-topic-usage",
              "canonical-file-read",
              "canonical-visual-read",
              "canonical-topic-list",
              "canonical-topic-create",
              "canonical-topic-create-config",
              "canonical-topic-config",
              "canonical-topic-derive",
              "canonical-manager-topic",
              ...(process.env.NEGOTIUM_CRON === "0" ? [] : ["scheduler.cron.gateway.v1"]),
              "canonical-topic-update",
              "canonical-topic-delete",
              "turn-submit-silent",
              "turn-submit-hidden",
              "canonical-history-import",
              "canonical-topic-abort",
              "canonical-session-reset",
              "canonical-session-compact",
              "canonical-input-files",
              // Lets a host tell "this node can settle an ask_user_question
              // card" from a node that predates the route and answers 404. The
              // host renders the card either way, so without the flag its only
              // signal is a failed click that looks identical to the bug this
              // route fixes.
              "canonical-ask-answer",
            ],
            cursor: latestRuntimeEventSeq(),
          });
        }

        if (req.method === "POST" && runtimePath === "/input-files") {
          const form = await req.formData();
          const topicId = requiredText(form.get("topicId"), "topicId");
          const userId = requiredText(form.get("userId"), "userId");
          const fileId = requiredText(form.get("fileId"), "fileId");
          const file = form.get("file");
          if (!(file instanceof File)) throw new ControlRequestError("file is required");
          if (file.size > MAX_NODE_UPLOAD_BYTES) return jsonError(413, "File too large");
          const topic = getTopic(topicId);
          if (
            !topic ||
            !topicInRequestScope(req, topic) ||
            !topic.participants.some((participant) => participant.userId === userId)
          ) {
            return jsonError(404, "Topic not found");
          }
          const attachment = await nodeFileStore.storeUploadedFile(fileId, file, {
            topicId,
            ownerUserId: userId,
          });
          if (!attachment) return jsonError(409, "File id is already bound to another upload");
          return Response.json(
            { ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, attachment },
            { status: 201 },
          );
        }

        if (req.method === "POST" && runtimePath === "/manager-topic") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const userId = requiredText(body.userId, "userId");
          const topic = ensurePersonalGeneral(userId, "otium", requestSurfaceScope(req));
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            topic,
          });
        }

        if (req.method === "GET" && runtimePath === "/cron/scripts") {
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            scripts: listCronScriptsForScope(cronScope(req)),
          });
        }

        if (req.method === "GET" && runtimePath === "/cron/jobs") {
          const userId = requiredText(url.searchParams.get("user"), "user");
          const actorUserId = requiredText(url.searchParams.get("actorUserId"), "actorUserId");
          const actorIsAdmin = booleanParam(url.searchParams.get("actorIsAdmin"));
          const jobs = (
            actorIsAdmin ? listCronJobs(userId) : listCronJobsForActorOwner(actorUserId)
          ).filter((job) => job.ownerUserId === userId && cronJobInScope(req, job));
          const scripts = new Set(listCronScriptsForScope(cronScope(req)));
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            jobs: jobs.map((job) => cronJobDto(job, actorUserId, actorIsAdmin, scripts)),
          });
        }

        if (req.method === "POST" && runtimePath === "/cron/jobs") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const userId = requiredText(body.userId, "userId");
          const actorUserId = requiredText(body.actorUserId, "actorUserId");
          const topicId = requiredText(body.topicId, "topicId");
          const script = requiredText(body.script, "script");
          const topic = getTopic(topicId);
          if (
            !topic ||
            !topicInRequestScope(req, topic) ||
            !topic.agent ||
            !topic.participants.some((participant) => participant.userId === userId)
          ) {
            return jsonError(404, "Topic not found");
          }
          const allowedScripts = new Set(listCronScriptsForScope(cronScope(req)));
          if (!allowedScripts.has(script)) return jsonError(404, "Cron script not found");
          const agent = body.agent === undefined ? undefined : requiredText(body.agent, "agent");
          if (agent && !["claude", "codex", "maestro"].includes(agent)) {
            return jsonError(400, "Invalid agent");
          }
          try {
            const job = createCronJob({
              name: requiredText(body.name, "name"),
              ownerUserId: userId,
              actorOwnerUserId: actorUserId,
              topicId,
              script,
              schedule: requiredText(body.schedule, "schedule"),
              timezone:
                body.timezone === undefined ? undefined : requiredText(body.timezone, "timezone"),
              agent: agent as AgentKind | undefined,
              model: body.model === undefined ? undefined : requiredText(body.model, "model"),
              effort: body.effort as "low" | "medium" | "high" | "xhigh" | "max" | undefined,
            });
            return Response.json(
              {
                ok: true,
                v: NODE_RUNTIME_CONTRACT_VERSION,
                job: cronJobDto(job, actorUserId, false, allowedScripts),
              },
              { status: 201 },
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : "Cron job creation failed";
            return jsonError(/unique/i.test(message) ? 409 : 400, message);
          }
        }

        const cronJobMatch = runtimePath.match(/^\/cron\/jobs\/([^/]+)$/);
        if (cronJobMatch && req.method === "PATCH") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const userId = requiredText(body.userId, "userId");
          const actorUserId = requiredText(body.actorUserId, "actorUserId");
          const actorIsAdmin = booleanParam(body.actorIsAdmin);
          const jobId = decodeURIComponent(cronJobMatch[1]);
          const current = cronJobForMutation(req, jobId, userId, actorUserId, actorIsAdmin);
          if (current instanceof Response) return current;
          if (!body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
            return jsonError(400, "patch must be an object");
          }
          const raw = body.patch as Record<string, unknown>;
          const patch: CronJobPatch = {};
          for (const key of ["name", "topicId", "script", "schedule"] as const) {
            if (raw[key] !== undefined) patch[key] = requiredText(raw[key], key);
          }
          if (raw.timezone !== undefined) {
            patch.timezone = raw.timezone === null ? null : requiredText(raw.timezone, "timezone");
          }
          if (raw.enabled !== undefined) {
            if (typeof raw.enabled !== "boolean") return jsonError(400, "enabled must be boolean");
            patch.enabled = raw.enabled;
          }
          if (raw.agent !== undefined) {
            patch.agent =
              raw.agent === null ? null : (requiredText(raw.agent, "agent") as AgentKind);
          }
          if (raw.model !== undefined) {
            patch.model = raw.model === null ? null : requiredText(raw.model, "model");
          }
          if (raw.effort !== undefined) {
            patch.effort = raw.effort as CronJobPatch["effort"];
          }
          const nextTopicId = patch.topicId ?? current.topicId;
          const nextTopic = getTopic(nextTopicId);
          if (
            !nextTopic ||
            !topicInRequestScope(req, nextTopic) ||
            !nextTopic.agent ||
            !nextTopic.participants.some((participant) => participant.userId === userId)
          ) {
            return jsonError(404, "Topic not found");
          }
          const scripts = new Set(listCronScriptsForScope(cronScope(req)));
          if (typeof patch.script === "string" && !scripts.has(patch.script)) {
            return jsonError(404, "Cron script not found");
          }
          if (typeof patch.script === "string") patch.prompt = null;
          try {
            const job = await updateCronJobWithContextReset(jobId, patch);
            if (!job) return jsonError(404, "Cron job not found");
            return Response.json({
              ok: true,
              v: NODE_RUNTIME_CONTRACT_VERSION,
              job: cronJobDto(job, actorUserId, actorIsAdmin, scripts),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Cron job update failed";
            return jsonError(/unique|active/i.test(message) ? 409 : 400, message);
          }
        }
        if (cronJobMatch && req.method === "DELETE") {
          const userId = requiredText(url.searchParams.get("user"), "user");
          const actorUserId = requiredText(url.searchParams.get("actorUserId"), "actorUserId");
          const actorIsAdmin = booleanParam(url.searchParams.get("actorIsAdmin"));
          const jobId = decodeURIComponent(cronJobMatch[1]);
          const current = cronJobForMutation(req, jobId, userId, actorUserId, actorIsAdmin);
          if (current instanceof Response) return current;
          deleteCronJob(jobId);
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            deleted: jobId,
          });
        }

        if (req.method === "POST" && runtimePath === "/turns") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = requiredText(body.topicId, "topicId");
          // Running a turn is the strongest thing a hub can do to a room, so it
          // gets the same workspace check as reading one (M-8).
          const turnTopic = getTopic(topicId);
          if (turnTopic && !topicInRequestScope(req, turnTopic)) {
            return jsonError(404, "Topic not found");
          }
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
          if (typeof body.text !== "string") throw new ControlRequestError("text is required");
          const text = body.text;
          const clientMessageId = requiredText(body.clientMessageId, "clientMessageId");
          const requestId =
            body.requestId === undefined ? undefined : requiredText(body.requestId, "requestId");
          const threadRootId =
            body.threadRootId === undefined
              ? undefined
              : requiredText(body.threadRootId, "threadRootId");
          const attachments =
            body.attachments === undefined
              ? []
              : Array.isArray(body.attachments) &&
                  body.attachments.every((value) => typeof value === "string" && value.trim())
                ? body.attachments
                : (() => {
                    throw new ControlRequestError("attachments must be an array of file ids");
                  })();
          if (!text.trim() && attachments.length === 0) {
            throw new ControlRequestError("text or attachments required");
          }
          const topic = getTopic(topicId);
          if (!topic) return jsonError(404, "Topic not found");
          if (!topic.participants.some((participant) => participant.userId === userId)) {
            return jsonError(404, "Topic not found");
          }
          if (
            attachments.some(
              (fileId) => !nodeFileStore.allows(fileId, { topicId, ownerUserId: userId }),
            )
          ) {
            return jsonError(404, "Attachment not found");
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
            // A room whose AI was removed, or set to mention-only, still owns
            // its transcript here (D-1). The host decides whether this message
            // deserves an answer; omitting the flag keeps the old behaviour.
            respond: body.respond !== false,
            silent: body.silent === true,
            // Default-deny, unlike `allowAutoContinue`/`respond` above: a host
            // that renders no visual panel and has no chat file surface must
            // not be handed tools whose output it would silently drop.
            visualTools: body.visualTools === true,
            fileDeliveryTools: body.fileDeliveryTools === true,
            ...(attachments.length ? { attachments } : {}),
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
            requestSurfaceScope(req),
          );
        }

        const runtimeMessagesMatch = runtimePath.match(/^\/topics\/([^/]+)\/messages$/);
        if (runtimeMessagesMatch && req.method === "GET") {
          const topicId = decodeURIComponent(runtimeMessagesMatch[1]);
          const messagesTopic = getTopic(topicId);
          if (!messagesTopic || !topicInRequestScope(req, messagesTopic)) {
            return jsonError(404, "Topic not found");
          }
          const cursor = url.searchParams.get("cursor");
          const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
          const result = listApiMessages(topicId, {
            cursor,
            limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
          });
          return Response.json({ ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, ...result });
        }

        const runtimeThreadMatch = runtimePath.match(
          /^\/topics\/([^/]+)\/messages\/([^/]+)\/thread$/,
        );
        if (runtimeThreadMatch && req.method === "GET") {
          const topicId = decodeURIComponent(runtimeThreadMatch[1]);
          const messageId = decodeURIComponent(runtimeThreadMatch[2]);
          const messagesTopic = getTopic(topicId);
          if (!messagesTopic || !topicInRequestScope(req, messagesTopic)) {
            return jsonError(404, "Topic not found");
          }
          const target = getApiMessage(topicId, messageId);
          if (!target || target.deleted) return jsonError(404, "Message not found");
          const rootId = target.threadRootId ?? target.id;
          const result = listThreadMessages(topicId, rootId);
          return Response.json({ ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, ...result });
        }

        const runtimeSystemMessageMatch = runtimePath.match(
          /^\/topics\/([^/]+)\/messages\/system$/,
        );
        if (runtimeSystemMessageMatch && req.method === "POST") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeSystemMessageMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const text = requiredText(body.text, "text");
          const message = {
            id: randomUUID(),
            topicId,
            authorId: "system",
            text,
            kind: "system" as const,
            createdAt: new Date().toISOString(),
          };
          appendApiMessage(message, { notify: false });
          WsHub.get().broadcastMessage(topicId, message);
          return Response.json({ ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, message });
        }

        /**
         * Mutate one canonical transcript message on behalf of an authenticated
         * product host. The product actor is not necessarily a participant on
         * ordinary mapped rooms (those execute as `local`), so authorship — not
         * canonical membership — is the edit/delete boundary. `allowAdmin` is
         * an explicit trusted-host override.
         */
        const runtimeMessageMatch = runtimePath.match(/^\/topics\/([^/]+)\/messages\/([^/]+)$/);
        if (runtimeMessageMatch && req.method === "PATCH") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeMessageMatch[1]);
          const messageId = decodeURIComponent(runtimeMessageMatch[2]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const actorUserId = requiredText(body.actorUserId, "actorUserId");
          const text = requiredText(body.text, "text");
          if (body.allowAdmin !== undefined && typeof body.allowAdmin !== "boolean") {
            return jsonError(400, "allowAdmin must be boolean");
          }
          const existing = getApiMessage(topicId, messageId);
          if (!existing || existing.deleted) return jsonError(404, "Message not found");
          if (existing.authorId !== actorUserId && body.allowAdmin !== true) {
            return jsonError(403, "Not allowed");
          }
          const editedAt = new Date().toISOString();
          const message = updateApiMessageText(topicId, messageId, text, editedAt);
          if (!message) return jsonError(404, "Message not found");
          WsHub.get().broadcastMessageUpdated(topicId, messageId, { text, editedAt });
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            message,
            previousText: existing.text,
          });
        }

        if (runtimeMessageMatch && req.method === "DELETE") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeMessageMatch[1]);
          const messageId = decodeURIComponent(runtimeMessageMatch[2]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const actorUserId = requiredText(body.actorUserId, "actorUserId");
          if (body.allowAdmin !== undefined && typeof body.allowAdmin !== "boolean") {
            return jsonError(400, "allowAdmin must be boolean");
          }
          const existing = getApiMessage(topicId, messageId);
          if (!existing || existing.deleted) return jsonError(404, "Message not found");
          if (existing.authorId !== actorUserId && body.allowAdmin !== true) {
            return jsonError(403, "Not allowed");
          }
          const message = softDeleteApiMessage(topicId, messageId);
          if (!message) return jsonError(404, "Message not found");
          WsHub.get().broadcastMessageUpdated(topicId, messageId, { deleted: true, text: "" });
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            message,
          });
        }

        const runtimeReactionMatch = runtimePath.match(
          /^\/topics\/([^/]+)\/messages\/([^/]+)\/reactions$/,
        );
        if (runtimeReactionMatch && req.method === "POST") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeReactionMatch[1]);
          const messageId = decodeURIComponent(runtimeReactionMatch[2]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const actorUserId = requiredText(body.actorUserId, "actorUserId");
          const emoji = requiredText(body.emoji, "emoji");
          if (emoji.length > 16) return jsonError(400, "emoji is too long");
          if (body.actorName !== undefined && typeof body.actorName !== "string") {
            return jsonError(400, "actorName must be a string");
          }
          const existing = getApiMessage(topicId, messageId);
          if (!existing || existing.deleted) return jsonError(404, "Message not found");
          const current = existing.reactions ?? [];
          const hasReaction = current.some(
            (reaction) => reaction.emoji === emoji && reaction.userId === actorUserId,
          );
          const reactions = hasReaction
            ? current.filter(
                (reaction) => !(reaction.emoji === emoji && reaction.userId === actorUserId),
              )
            : [
                ...current,
                {
                  emoji,
                  userId: actorUserId,
                  userName: typeof body.actorName === "string" ? body.actorName : "",
                },
              ];
          const message = setApiMessageReactions(topicId, messageId, reactions);
          if (!message) return jsonError(404, "Message not found");
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            reactions: message.reactions ?? [],
          });
        }

        /**
         * Topic discovery for the gateway.
         *
         * The gateway only ever sees the `otium` surface (S-6). Membership of
         * a surface *is* the consent that `accessMode=shared` used to encode,
         * so there is no per-topic flag left to filter on and no way for a host
         * to enumerate the owner's terminal or telegram rooms.
         *
         * The listing also carries `lastMessagePreview`. For a mapped room the
         * node owns the transcript (D-1), so the host's own message table is
         * empty and it can derive neither a subtitle nor a sane sort order from
         * a store it never writes to. Previews are batched into the one query
         * `getLastMessagePreviews` already does, keeping discovery a single
         * round-trip, and the ids come straight from `gatewayVisibleTopics` so
         * a preview can never escape the M-8 scope the listing is limited to.
         */
        if (req.method === "GET" && runtimePath === "/topics") {
          const topics = gatewayVisibleTopics(req);
          const previews = getLastMessagePreviews(topics.map((topic) => topic.id));
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            topics: topics.map((topic) => {
              const preview = previews.get(topic.id);
              return {
                ...topic,
                config: getApiTopicConfig(topic.id) ?? {},
                ...(preview ? { lastMessagePreview: preview } : {}),
              };
            }),
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
          if (
            agent !== undefined &&
            agent !== null &&
            !["none", "claude", "codex", "maestro"].includes(String(agent))
          ) {
            return jsonError(400, "Invalid agent");
          }
          const kind = body.kind ?? "agent";
          if (kind !== "agent" && kind !== "channel") return jsonError(400, "Invalid kind");
          if (body.model !== undefined && typeof body.model !== "string") {
            return jsonError(400, "model must be a string");
          }
          if (
            body.effort !== undefined &&
            !["low", "medium", "high", "xhigh", "max"].includes(String(body.effort))
          ) {
            return jsonError(400, "Invalid effort");
          }
          const topic = topicService.create({
            title,
            userId,
            kind,
            surface: "otium",
            // Born in the workspace that asked for it, not in whichever one
            // this process happens to have resolved last (M-1).
            ...requestSurfaceScope(req),
            ...(agent === null || agent === "none"
              ? { agent: "none" as const }
              : agent
                ? { agent: agent as AgentKind }
                : {}),
            ...(typeof body.model === "string" ? { model: body.model } : {}),
            ...(typeof body.effort === "string"
              ? { effort: body.effort as "low" | "medium" | "high" | "xhigh" | "max" }
              : {}),
          });
          return Response.json(
            { ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, topic },
            { status: 201 },
          );
        }

        /**
         * Fork or spawn a room, on the node that owns the source transcript.
         *
         * `canonical-topic-derive` was advertised in `/health` while the route
         * itself existed only on the control surface below, which the contract
         * dispatcher never reaches. A host therefore feature-detected support,
         * called it, and got "Runtime contract route not found" — so forking a
         * room in Otium failed with "Topic not found or access denied" (the
         * hub refuses to create a derived room it cannot back with a node
         * topic), and rooms derived before that refusal existed only in the
         * hub's store: invisible to every other surface and running their
         * turns off the canonical node, which is the second store D-1 forbids.
         *
         * Scope is checked the way every other contract topic route checks it,
         * so a host can only derive from a room in its own workspace.
         */
        const runtimeDeriveMatch = runtimePath.match(/^\/topics\/([^/]+)\/derive$/);
        if (runtimeDeriveMatch && req.method === "POST") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeDeriveMatch[1]);
          const userId = requiredText(body.userId, "userId");
          if (typeof body.copyHistory !== "boolean") {
            return jsonError(400, "copyHistory must be a boolean");
          }
          if (body.name !== undefined && typeof body.name !== "string") {
            return jsonError(400, "name must be a string");
          }
          const source = topicForUser(topicId, userId);
          if (!source || source.kind === "manager" || !topicInRequestScope(req, source)) {
            return jsonError(404, "Topic not found");
          }
          const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "";
          const derived = await topicService.derive({
            sourceTopicId: topicId,
            userId,
            copyHistory: body.copyHistory,
            ...(name ? { name } : {}),
          });
          if (!derived) return jsonError(500, "Failed to derive topic");
          return Response.json(
            { ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, topic: derived },
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
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
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

        /**
         * Stop the turn running in a room the host surfaced.
         *
         * A host that starts a turn must be able to stop it, or a runaway
         * answer can only be killed from Terminal on the node's own machine —
         * and for a worker room reached over the relay, not at all. The control
         * route already exists; this is the same call behind the contract's
         * envelope and workspace check, so the ability is not surface-dependent
         * (D-1).
         */
        const runtimeAbortMatch = runtimePath.match(/^\/topics\/([^/]+)\/abort$/);
        if (runtimeAbortMatch && req.method === "POST") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeAbortMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const userId = requiredText(body.userId, "userId");
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            aborted: topicService.abortTurn(topicId, userId),
          });
        }

        /**
         * Drop the room's agent session, keeping its transcript.
         *
         * `/reset` and `/compact` are context-window management, which a host
         * driving long-running rooms needs as much as Terminal does: without
         * them the only recovery from a wedged or overlong session is deleting
         * the room. Both mirror their control routes exactly, including the 409
         * on `isError` — a session that cannot be restarted right now (a turn is
         * in flight) is a conflict, not a bad request.
         */
        const runtimeResetMatch = runtimePath.match(/^\/topics\/([^/]+)\/session\/reset$/);
        if (runtimeResetMatch && req.method === "POST") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeResetMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const userId = requiredText(body.userId, "userId");
          const actorUserId =
            body.actorUserId === undefined
              ? undefined
              : requiredText(body.actorUserId, "actorUserId");
          const reason =
            body.reason === undefined ? undefined : requiredText(body.reason, "reason");
          const result = await topicService.reset({
            topicId,
            userId,
            actorUserId,
            // The caller's reason is only ever a label on the audit line, so an
            // absent one falls back to naming the surface rather than failing.
            reason: reason ?? "runtime-contract-session-reset",
          });
          if (result.isError) return jsonError(409, result.text);
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            result: result.text,
          });
        }

        const runtimeCompactMatch = runtimePath.match(/^\/topics\/([^/]+)\/session\/compact$/);
        if (runtimeCompactMatch && req.method === "POST") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeCompactMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const userId = requiredText(body.userId, "userId");
          const actorUserId =
            body.actorUserId === undefined
              ? undefined
              : requiredText(body.actorUserId, "actorUserId");
          const reason =
            body.reason === undefined ? undefined : requiredText(body.reason, "reason");
          const result = await topicService.compact({
            topicId,
            userId,
            actorUserId,
            reason: reason ?? "runtime-contract-session-compact",
            compactSession: options.compactSession,
          });
          if (result.isError) return jsonError(409, result.text);
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            result: result.text,
          });
        }

        /**
         * Settle an `ask_user_question` card the node itself is blocked on.
         *
         * The gate, the pending promise and the card row all live in this
         * process (see `#agents/mcp-tools/ask-user`), so the selection has to
         * come back here to resume the turn. A host that mirrors the room — the
         * Otium hub — renders the card and receives the click, but answering it
         * against the host's own store can only ever 404: the card was never
         * written there. Without this route that click has nowhere to go, so the
         * card silently rolls back and the agent keeps re-asking.
         *
         * Strictly narrower than `/turns`: it cannot start work, only deliver
         * one of the choices the node already published for a turn it is already
         * running.
         */
        const runtimeAskAnswerMatch = runtimePath.match(
          /^\/topics\/([^/]+)\/messages\/([^/]+)\/ask-answer$/,
        );
        if (runtimeAskAnswerMatch && req.method === "POST") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeAskAnswerMatch[1]);
          const messageId = decodeURIComponent(runtimeAskAnswerMatch[2]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const userId = requiredText(body.userId, "userId");
          const label = requiredText(body.label, "label");
          const answered = topicService.answerQuestion(topicId, messageId, label, userId);
          // 409, matching `/session/reset`: the card exists but is no longer
          // awaiting an answer (expired, already selected, or the turn ended).
          // That is a conflict with current state, not a malformed request, and
          // the hub needs to tell the two apart to decide whether to expire its
          // rendered card or just surface a retry.
          if (!answered.ok) return jsonError(409, answered.error);
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            queryId: answered.queryId,
            answerMessage: answered.answerMessage,
          });
        }

        /**
         * Read a visual a turn rendered on this node, in a form the calling
         * host can re-insert into its own store.
         *
         * A mapped room's turn runs here, so `show_html` and friends write to
         * this node's visual store and the URL on the runtime event points at
         * a topic id only this node knows. A host that owns the room but not
         * the execution has nothing to serve its panel from. Copying beats
         * proxying: the host keeps serving visuals after this node goes
         * offline, and its own access control stays in charge of who sees the
         * room.
         *
         * Media kinds carry `fileId`, which names a file in *this* node's
         * store — the caller has to fetch those bytes separately (`/files`)
         * and re-upload them under an id of its own.
         */
        const runtimeVisualMatch = runtimePath.match(/^\/topics\/([^/]+)\/visuals\/(\d+)$/);
        if (runtimeVisualMatch && req.method === "GET") {
          const topicId = decodeURIComponent(runtimeVisualMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const visual = getPortableTopicVisual(topicId, Number(runtimeVisualMatch[2]));
          if (!visual) return jsonError(404, "Visual not found");
          return Response.json({ ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, visual });
        }

        /**
         * Read bytes this node holds, so a host can copy them into its own
         * file store. Covers both halves of the same gap: the media behind an
         * `show_image`/`show_video` visual, and a file the agent delivered to
         * the chat. The contract could upload *to* a node but never read back,
         * which is why either one arriving from a node turn was unreachable.
         *
         * Deliberately addressed through the owning room rather than as a bare
         * `/files/<id>`. Every mapped room executes as the same `local`
         * principal, so a file ACL keyed on the caller's user id authorizes
         * nothing across workspaces: a gateway scoped to workspace A that
         * learned a workspace-B file UUID would be handed B's bytes, even
         * though B's rooms 404 for it. Routing through the topic puts the read
         * behind the same `topicInRequestScope` check as every other
         * topic-scoped route (M-8), and the file must actually belong to the
         * room being named.
         */
        const runtimeFileMatch = runtimePath.match(/^\/topics\/([^/]+)\/files\/([0-9a-f-]+)$/i);
        if (runtimeFileMatch && req.method === "GET") {
          const topicId = decodeURIComponent(runtimeFileMatch[1]);
          const fileId = runtimeFileMatch[2];
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const userId = requiredText(url.searchParams.get("user"), "user");
          // Bytes are only readable through the room they are filed under, so a
          // UUID guessed or leaked from another workspace resolves to nothing.
          //
          // Room membership, not ownership: callers disagree on who owns a file.
          // `send_file` stores with an owner, but a `show_image`/`show_video`
          // resolved from `file_path` stores with only a topic, so checking the
          // owner here 404'd every media visual while file delivery worked.
          // `response` still applies the file's own visibility/owner rules.
          if (!nodeFileStore.belongsToTopic(fileId, topicId)) {
            return jsonError(404, "File not found");
          }
          return nodeFileStore.response(fileId, userId) ?? jsonError(404, "File not found");
        }

        const runtimeUsageMatch = runtimePath.match(/^\/topics\/([^/]+)\/usage$/);
        if (runtimeUsageMatch && req.method === "GET") {
          const topicId = decodeURIComponent(runtimeUsageMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const userId = requiredText(url.searchParams.get("user"), "user");
          if (!isParticipant(topic, userId)) return jsonError(404, "Topic not found");
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            usage: getTopicStats(userId, topicId),
          });
        }

        const runtimeTopicMatch = runtimePath.match(/^\/topics\/([^/]+)$/);
        const runtimeTopicConfigMatch = runtimePath.match(/^\/topics\/([^/]+)\/config$/);
        if (runtimeTopicConfigMatch && req.method === "GET") {
          const topicId = decodeURIComponent(runtimeTopicConfigMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            topic,
            config: getApiTopicConfig(topicId) ?? {},
          });
        }
        if (runtimeTopicConfigMatch && req.method === "PATCH") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeTopicConfigMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const next: TopicConfig = { ...(getApiTopicConfig(topicId) ?? {}) };
          for (const key of ["model", "effort"] as const) {
            if (!(key in body)) continue;
            const value = body[key];
            if (value === null) delete next[key];
            else if (typeof value === "string" && value.trim()) {
              if (key === "effort" && !["low", "medium", "high", "xhigh", "max"].includes(value)) {
                return jsonError(400, "Invalid effort");
              }
              next[key] = value as never;
            } else return jsonError(400, `${key} must be a string or null`);
          }
          if ("mcp" in body) {
            if (body.mcp === null) delete next.mcp;
            else if (
              Array.isArray(body.mcp) &&
              body.mcp.every((item) => typeof item === "string")
            ) {
              next.mcp = [...new Set(body.mcp.map((item) => item.trim()).filter(Boolean))];
            } else return jsonError(400, "mcp must be an array of strings or null");
          }
          for (const key of ["agentLocked", "modelLocked", "effortLocked"] as const) {
            if (!(key in body)) continue;
            const value = body[key];
            if (value === null || value === false) delete next[key];
            else if (value === true) next[key] = true;
            else return jsonError(400, `${key} must be a boolean or null`);
          }
          setApiTopicConfig(topicId, next);
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            topic,
            config: getApiTopicConfig(topicId) ?? {},
          });
        }

        if (runtimeTopicMatch && req.method === "GET") {
          const topic = getTopic(decodeURIComponent(runtimeTopicMatch[1]));
          if (topic && !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          if (!topic) return jsonError(404, "Topic not found");
          return Response.json({
            ok: true,
            v: NODE_RUNTIME_CONTRACT_VERSION,
            topic,
            config: getApiTopicConfig(topic.id) ?? {},
          });
        }

        /**
         * Delete a canonical topic a host surfaced, so a deleted mirror room
         * stays deleted.
         *
         * Without this, deleting the Otium-side mirror of a shared topic left
         * the node's own topic untouched — still `surface: otium` — so the
         * next sync pass mirrored it right back. This is the seam that lets a
         * delete actually reach the topic that owns the transcript (D-1),
         * matching `canonical-topic-create`'s own reasoning in reverse.
         */
        if (runtimeTopicMatch && req.method === "DELETE") {
          const topicId = decodeURIComponent(runtimeTopicMatch[1]);
          const topic = getTopic(topicId);
          if (!topic || !topicInRequestScope(req, topic)) return jsonError(404, "Topic not found");
          const userId = requiredText(url.searchParams.get("user"), "user");
          const actorUserId = url.searchParams.get("actor")?.trim() || undefined;
          try {
            await topicService.delete({ topicId, userId, memoryUserId: actorUserId });
          } catch (err) {
            if (err instanceof TopicServiceError) {
              const status =
                err.code === "TOPIC_NOT_FOUND" ? 404 : err.code === "TOPIC_FORBIDDEN" ? 403 : 400;
              return jsonError(status, err.message);
            }
            throw err;
          }
          return Response.json({ ok: true, v: NODE_RUNTIME_CONTRACT_VERSION });
        }

        /**
         * Change a canonical topic's title, backend, model, effort or AI mode.
         *
         * The turn runner resolves execution from the *node's* `topic.agent` /
         * `defaultModel` / `defaultEffort`, so a picker on the host was purely
         * cosmetic without this: the room kept answering with whatever the node
         * last stored. Same reasoning for `aiMode` — "remove the AI from this
         * channel" is a property of the canonical room, not of the mirror.
         *
         * Absent fields are left alone, so a host that only renames a room does
         * not have to resend a whole topic and risk clobbering a change made in
         * Terminal between its read and its write.
         */
        if (runtimeTopicMatch && req.method === "PATCH") {
          const body = await bodyRecord(req);
          if (body.v !== NODE_RUNTIME_CONTRACT_VERSION) return jsonError(400, "Unsupported v");
          const topicId = decodeURIComponent(runtimeTopicMatch[1]);
          const existing = getTopic(topicId);
          if (!existing || !topicInRequestScope(req, existing)) {
            return jsonError(404, "Topic not found");
          }
          const userId = requiredText(body.userId, "userId");
          // Same membership bar as running a turn on the room (M-8): a caller
          // who could not speak in a room may not reconfigure it either.
          if (!existing.participants.some((participant) => participant.userId === userId)) {
            return jsonError(404, "Topic not found");
          }
          if (body.title !== undefined && typeof body.title !== "string") {
            return jsonError(400, "title must be a string");
          }
          // `null` is a real value here — it removes the agent — so presence is
          // checked with `in`, not against `undefined` alone.
          if (
            body.agent !== undefined &&
            body.agent !== null &&
            !["claude", "codex", "maestro"].includes(String(body.agent))
          ) {
            return jsonError(400, "Invalid agent");
          }
          if (body.defaultModel !== undefined && typeof body.defaultModel !== "string") {
            return jsonError(400, "defaultModel must be a string");
          }
          if (body.defaultEffort !== undefined && typeof body.defaultEffort !== "string") {
            return jsonError(400, "defaultEffort must be a string");
          }
          if (
            body.aiMode !== undefined &&
            !["always", "mention", "off"].includes(String(body.aiMode))
          ) {
            return jsonError(400, "Invalid aiMode");
          }
          try {
            const topic = updateTopicSettings({
              topicId,
              ...(body.title !== undefined ? { title: body.title as string } : {}),
              ...(body.agent !== undefined
                ? { agent: (body.agent as AgentKind | null) ?? null }
                : {}),
              ...(body.defaultModel !== undefined
                ? { defaultModel: body.defaultModel as string }
                : {}),
              ...(body.defaultEffort !== undefined
                ? { defaultEffort: body.defaultEffort as string }
                : {}),
              ...(body.aiMode !== undefined ? { aiMode: body.aiMode as AiMode } : {}),
            });
            return Response.json({ ok: true, v: NODE_RUNTIME_CONTRACT_VERSION, topic });
          } catch (err) {
            if (err instanceof TopicUpdateConflictError) return jsonError(409, err.message);
            if (err instanceof TopicValidationError) return jsonError(400, err.message);
            throw err;
          }
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
        const allUsers = url.searchParams.get("allUsers") === "true";
        return Response.json({
          ok: true,
          sessions: listBackgroundSessionsForUser(userId, allUsers),
        });
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

      /**
       * This node's own AI persona name — node identity, not topic state.
       *
       * Deliberately outside the runtime contract (`NODE_RUNTIME_CONTRACT_BASE_PATH`):
       * `gateway-forward.ts`'s allowlist only ever forwards a fixed read/turn
       * subset of that contract to a remote worker, and this route is not on it.
       * So changing a node's name here is structurally loopback-only — a hub can
       * rename itself through its own control token, but can never reach a
       * worker's name over the relay. Each computer keeps the name its own
       * operator gave it.
       */
      if (req.method === "GET" && path === "/ai-name") {
        return Response.json({ ok: true, aiName: getGlobalAiName() });
      }

      if (req.method === "PATCH" && path === "/ai-name") {
        const body = await bodyRecord(req);
        const aiName = requiredText(body.aiName, "aiName");
        return Response.json({ ok: true, aiName: setGlobalAiName(aiName) });
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

      const decisionsMatch = path.match(/^\/topics\/([^/]+)\/decisions$/);
      if (decisionsMatch && req.method === "GET") {
        const topicId = decodeURIComponent(decisionsMatch[1]);
        const userId = requiredText(url.searchParams.get("user"), "user");
        if (!topicForUser(topicId, userId)) return jsonError(404, "Topic not found");
        return Response.json({ ok: true, decisions: readDecisions(userId, topicId) });
      }

      const decisionGraphMatch = path.match(/^\/topics\/([^/]+)\/decision-graph$/);
      if (decisionGraphMatch && req.method === "POST") {
        const topicId = decodeURIComponent(decisionGraphMatch[1]);
        const body = await bodyRecord(req);
        const userId = requiredText(body.userId, "userId");
        const svg = requiredText(body.svg, "svg");
        if (!topicForUser(topicId, userId)) return jsonError(404, "Topic not found");
        writeDecisionGraphSvg(userId, topicId, svg);
        return Response.json({ ok: true });
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
