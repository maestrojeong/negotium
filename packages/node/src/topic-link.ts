/**
 * Topic-link v2, node half (design v2 §4.2, §4.5, §4.6 — PR7).
 *
 * Everything here is additive to the Runtime Gateway contract:
 *
 * - create claims: a host that puts `requestId` in a `POST /topics` or
 *   `POST /topics/:id/derive` body gets an idempotent create. The claim is
 *   written in the topic's own SQLite transaction, so a response lost after
 *   commit is replayed by id (never re-created, never guessed at).
 * - `GET /topics/:id/existence` — `present | gone | unknown`, identity-bound.
 * - `GET /topic-tombstones` — the durable deletion log behind `gone`.
 * - `GET /surface-scope` — the workspace scope the caller's rooms are filed
 *   under, so a host caches the node's answer instead of hashing one itself.
 * - `GET /topic-claims/:requestId`, `POST /topic-claims/:requestId/abort` —
 *   saga recovery for a host whose own commit failed after the node's.
 * - the `NEGOTIUM_OTIUM_LINK_V2` create guard (default off).
 *
 * Kept out of `control.ts` so the contract dispatcher only gains a handful of
 * call sites. Hosts that send none of the new fields see exactly the old
 * behaviour.
 */
import {
  type AbortTopicCreateClaimOptions,
  abortTopicCreateClaim,
  committedClaimsByTopic,
  getTopic,
  getTopicCreateClaim,
  getTopicTombstone,
  insertCommittedTopicCreateClaim,
  latestTopicScopeMove,
  listTopicTombstonesAfter,
  localSurfaceScopeStatus,
  logger,
  NODE_ID,
  pruneTopicCreateClaims,
  recordTopicLinkNodeIdentity,
  surfaceScopeStampStatus,
  TOPIC_CREATE_CLAIM_PRUNE_BATCH,
  type TopicCreateClaim,
  type TopicDto,
  topicLinkDbEpoch,
  topicLinkNodeIdentity,
  topicLinkPayloadHash,
  topicTombstoneHighWater,
} from "@negotium/core/node-host";

const CONTRACT_VERSION = 1;

/** Header a host sets on room-creating requests to declare its link protocol. */
export const OTIUM_LINK_PROTOCOL_HEADER = "x-otium-link-protocol";
/**
 * Optional: the scope the host expects its rooms to be filed under (its cached
 * `GET /surface-scope` answer; empty = unscoped). Only checked by the guard.
 */
export const OTIUM_LINK_EXPECTED_SCOPE_HEADER = "x-otium-link-expected-scope";
/** Env flag for the strict create guard: unset/`0`/`off` | `1`/`on` | `strict`. */
export const OTIUM_LINK_GUARD_ENV = "NEGOTIUM_OTIUM_LINK_V2";
/**
 * Revision 7: the node identity a host planned a room delete against (its
 * recorded `/health.nodeId` for this node). `DELETE /topics/:id` compares it
 * with the identity answering now before touching anything, so a delete that
 * reaches another node (a changed loopback URL or relay target) deletes
 * nothing. Advertised as `canonical-topic-delete-conditional`.
 */
export const NODE_EXPECTED_NODE_ID_HEADER = "x-negotium-expected-node-id";

// Mirrors control.ts `NODE_RUNTIME_SURFACE_SCOPE_HEADER` / `_STRICT_HEADER`
// (pinned equal by tests); duplicated to keep this module free of an import
// cycle with the dispatcher.
const SURFACE_SCOPE_HEADER = "x-negotium-surface-scope";
const SURFACE_SCOPE_STRICT_HEADER = "x-negotium-surface-scope-strict";

const MAX_REQUEST_ID_LENGTH = 200;
const TOMBSTONE_PAGE_DEFAULT = 100;
const TOMBSTONE_PAGE_MAX = 500;
const CLAIM_PRUNE_INTERVAL_MS = 60 * 60_000;

function linkError(status: number, code: string, error: string, extra: object = {}): Response {
  return Response.json({ ok: false, v: CONTRACT_VERSION, error, code, ...extra }, { status });
}

// ── caller identity & scope ───────────────────────────────────────────────

/** The scope header, or `undefined` when absent (a loopback caller). */
function headerScope(req: Request): string | null | undefined {
  const header = req.headers.get(SURFACE_SCOPE_HEADER);
  if (header === null) return undefined;
  const scope = header.trim();
  return scope ? scope : null;
}

/**
 * Who a claim belongs to. The node never reads this from the body: a loopback
 * caller (no scope header) is `loopback`; a relayed caller is identified by
 * the workspace scope the Otium sidecar stamped on the request after verifying
 * it (the relay's cell id does not reach the node).
 */
export function topicLinkPrincipalKey(req: Request): string {
  const scope = headerScope(req);
  return scope === undefined ? "loopback" : `scope:${scope ?? ""}`;
}

/**
 * Same rule as control.ts `topicInRequestScope`, applied to a stored
 * `(surface, surfaceScope)` — a live topic or a tombstone. A scoped (relayed)
 * caller additionally only learns about Otium-surface records.
 */
function recordInRequestScope(
  req: Request,
  record: { surface?: string | null; surfaceScope?: string | null },
): boolean {
  const scope = headerScope(req);
  if (scope === undefined) return true;
  if (record.surface !== "otium") return false;
  const recordScope = record.surfaceScope ?? null;
  if (recordScope === null) return req.headers.get(SURFACE_SCOPE_STRICT_HEADER) !== "1";
  return recordScope === scope;
}

export interface RequestSurfaceScopeResolution {
  principal: "loopback" | "scoped";
  surfaceScope: string | null;
  resolved: boolean;
  scopeRequired: boolean;
  joinsMounted: number;
}

/** The scope rooms created by this caller are filed under (design v2 §4.6). */
export function requestSurfaceScopeResolution(req: Request): RequestSurfaceScopeResolution {
  const local = localSurfaceScopeStatus();
  const scope = headerScope(req);
  if (scope === undefined) return { principal: "loopback", ...local };
  return {
    principal: "scoped",
    surfaceScope: scope,
    // The sidecar states an empty scope while it has not resolved the
    // caller's workspace yet.
    resolved: scope !== null,
    scopeRequired: req.headers.get(SURFACE_SCOPE_STRICT_HEADER) === "1",
    joinsMounted: local.joinsMounted,
  };
}

// ── create guard ──────────────────────────────────────────────────────────

export type OtiumLinkGuardMode = "off" | "on" | "strict";

export function otiumLinkGuardMode(): OtiumLinkGuardMode {
  const raw = process.env[OTIUM_LINK_GUARD_ENV]?.trim().toLowerCase();
  if (raw === "strict") return "strict";
  if (raw === "1" || raw === "on" || raw === "true") return "on";
  return "off";
}

export function linkProtocolVersion(req: Request): number {
  const raw = req.headers.get(OTIUM_LINK_PROTOCOL_HEADER)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Number(raw);
}

/** Principal+protocol pairs already logged, so the rollout log stays readable. */
const observedProtocols = new Set<string>();

function observeProtocol(req: Request, route: string, protocol: number, mode: OtiumLinkGuardMode) {
  const key = `${topicLinkPrincipalKey(req)}|${protocol}`;
  if (observedProtocols.has(key)) return;
  observedProtocols.add(key);
  const fields = { principal: topicLinkPrincipalKey(req), route, protocol, guard: mode };
  // The operator turns the guard on only after every attached hub is seen
  // declaring protocol 2 here (design v2 §7.1 step 4).
  if (protocol >= 2) logger.info(fields, "otium link: caller declares link protocol");
  else logger.warn(fields, "otium link: room create from a caller without link protocol 2");
}

export type TopicCreateRoute = "create" | "derive" | "manager";

/**
 * The create guard for the three gateway room creators. Returns a refusal or
 * null. Off by default; `on` only ever refuses callers that declared protocol
 * ≥ 2 (an older hub would turn a 409 into an orphaned room); `strict` also
 * refuses callers that did not declare it.
 */
export function otiumLinkCreateGuard(req: Request, route: TopicCreateRoute): Response | null {
  const mode = otiumLinkGuardMode();
  const protocol = linkProtocolVersion(req);
  observeProtocol(req, route, protocol, mode);
  if (mode === "off") return null;
  if (protocol < 2) {
    if (mode === "strict") {
      return linkError(
        409,
        "link_protocol_required",
        `this node requires ${OTIUM_LINK_PROTOCOL_HEADER}: 2 to create rooms`,
      );
    }
    return null;
  }
  // A derived room inherits its parent's scope, so the caller's own scope
  // cannot misfile it; only the protocol requirement applies.
  if (route === "derive") return null;
  const resolution = requestSurfaceScopeResolution(req);
  if (!resolution.resolved) {
    return linkError(
      409,
      "scope_unresolved",
      "this node cannot tell which workspace the room belongs to yet",
      { surfaceScope: resolution.surfaceScope, scopeRequired: resolution.scopeRequired },
    );
  }
  const expectedHeader = req.headers.get(OTIUM_LINK_EXPECTED_SCOPE_HEADER);
  if (expectedHeader !== null) {
    const expected = expectedHeader.trim() || null;
    if (expected !== resolution.surfaceScope) {
      return linkError(
        409,
        "scope_mismatch",
        "the room would be filed under a different workspace than the caller expects",
        { surfaceScope: resolution.surfaceScope, expectedSurfaceScope: expected },
      );
    }
  }
  return null;
}

// ── create claims ─────────────────────────────────────────────────────────

export interface TopicLinkRequest {
  principalKey: string;
  requestId: string;
  op: "create" | "derive";
  /** Computed by this node from the received body; never the host's value. */
  payloadHash: string;
  /** Derive: the PATH source topic id (the body cannot name another one). */
  sourceTopicId?: string;
}

/**
 * A requestId exactly as sent: 1..200 chars, no leading/trailing whitespace
 * (never trimmed — a trimmed id would alias two different keys).
 */
function validRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REQUEST_ID_LENGTH &&
    value === value.trim()
  );
}

/**
 * Read the saga fields of a room-creating body. `null` = no `requestId`
 * (legacy caller, old behaviour). A malformed id is a 400 so a host bug can
 * never silently fall back to an unclaimed create.
 *
 * `hashInput` is exactly what the hub hashes: the body for `create`, and
 * `{ sourceTopicId: <path id>, ...body }` for `derive`.
 */
export function parseTopicLinkRequest(
  req: Request,
  body: Record<string, unknown>,
  op: "create" | "derive",
  hashInput: Record<string, unknown>,
): TopicLinkRequest | Response | null {
  if (body.requestId === undefined || body.requestId === null) return null;
  if (!validRequestId(body.requestId)) {
    return linkError(
      400,
      "invalid_request_id",
      "requestId must be 1-200 characters without leading or trailing whitespace",
    );
  }
  const requestId = body.requestId;
  const sourceTopicId =
    op === "derive" && typeof hashInput.sourceTopicId === "string"
      ? hashInput.sourceTopicId
      : undefined;
  const payloadHash = topicLinkPayloadHash(hashInput);
  if (typeof body.payloadHash === "string" && body.payloadHash !== payloadHash) {
    // Not a refusal: the node's own hash is the one it keys on. A mismatch
    // means the host canonicalizes differently, which would break its own
    // retry matching — worth a loud log, not a failed room.
    logger.warn(
      { requestId, op, hostPayloadHash: body.payloadHash, nodePayloadHash: payloadHash },
      "otium link: host payloadHash differs from the node's",
    );
  }
  return {
    principalKey: topicLinkPrincipalKey(req),
    requestId,
    op,
    payloadHash,
    ...(sourceTopicId !== undefined ? { sourceTopicId } : {}),
  };
}

function hostCreateOf(claim: TopicCreateClaim) {
  return { requestId: claim.requestId, op: claim.op, createdAt: claim.createdAt };
}

/** Topic DTOs with `hostCreate` for the rooms this caller itself created. */
export function withHostCreate<T extends Pick<TopicDto, "id">>(req: Request, topics: T[]): T[] {
  if (topics.length === 0) return topics;
  maybePruneClaims();
  const claims = committedClaimsByTopic(
    topicLinkPrincipalKey(req),
    topics.map((topic) => topic.id),
  );
  if (claims.size === 0) return topics;
  return topics.map((topic) => {
    const claim = claims.get(topic.id);
    return claim ? { ...topic, hostCreate: hostCreateOf(claim) } : topic;
  });
}

function claimedCreateResponse(
  topic: TopicDto,
  claim: TopicCreateClaim,
  replayed: boolean,
): Response {
  return Response.json(
    {
      ok: true,
      v: CONTRACT_VERSION,
      topic: { ...topic, hostCreate: hostCreateOf(claim) },
      requestId: claim.requestId,
      payloadHash: claim.payloadHash,
      replayed,
    },
    // 201 on replay too: current hubs accept nothing else from these routes.
    { status: 201 },
  );
}

/** What an existing claim says about a repeated request. */
function answerExistingClaim(
  claim: TopicCreateClaim,
  link: TopicLinkRequest,
  req: Request,
): Response {
  if (claim.state === "aborted") {
    return linkError(409, "request_aborted", "this requestId was aborted", {
      requestId: claim.requestId,
    });
  }
  if (
    claim.op !== link.op ||
    claim.payloadHash !== link.payloadHash ||
    // A derive claim is bound to the path source it was made on (legacy rows
    // without a recorded source rely on the hash, which includes it).
    (claim.op === "derive" &&
      claim.sourceTopicId !== null &&
      claim.sourceTopicId !== (link.sourceTopicId ?? null))
  ) {
    return linkError(
      409,
      "request_id_conflict",
      "this requestId was already used for a different request",
      { requestId: claim.requestId },
    );
  }
  const topic = claim.topicId ? getTopic(claim.topicId) : null;
  if (!topic) {
    return linkError(410, "claim_topic_gone", "the topic created for this requestId is gone", {
      requestId: claim.requestId,
      topicId: claim.topicId,
    });
  }
  if (!recordInRequestScope(req, topic)) {
    // The room is no longer filed under this caller's workspace: its claim
    // grants nothing (no DTO, no replay).
    return linkError(
      409,
      "claim_topic_moved",
      "the topic created for this requestId left your workspace",
      {
        requestId: claim.requestId,
        topicId: claim.topicId,
      },
    );
  }
  return claimedCreateResponse(topic, claim, true);
}

/** Requests of this process still inside their create. */
const inFlight = new Set<string>();
let lastPrune = 0;

function claimKey(link: { principalKey: string; requestId: string }): string {
  return `${link.principalKey}\u0000${link.requestId}`;
}

/**
 * Answer a request that already has a claim, or null when it has none yet
 * (the caller then applies its guard and calls {@link runClaimedTopicCreate}).
 */
export function replayTopicCreateClaim(link: TopicLinkRequest, req: Request): Response | null {
  if (inFlight.has(claimKey(link))) {
    return linkError(409, "request_in_progress", "this requestId is still being processed", {
      requestId: link.requestId,
    });
  }
  const claim = getTopicCreateClaim(link.principalKey, link.requestId);
  return claim ? answerExistingClaim(claim, link, req) : null;
}

/**
 * Run a claimed create. `create` receives the hook that records the claim and
 * must run it inside the topic-insert transaction. Returns null when `create`
 * produced no topic (the caller answers as it always has).
 */
export async function runClaimedTopicCreate(
  link: TopicLinkRequest,
  req: Request,
  create: (withinCreateTransaction: (topic: TopicDto) => void) => Promise<TopicDto | null>,
): Promise<Response | null> {
  const key = claimKey(link);
  if (inFlight.has(key)) {
    return linkError(409, "request_in_progress", "this requestId is still being processed", {
      requestId: link.requestId,
    });
  }
  inFlight.add(key);
  try {
    maybePruneClaims();
    let claim: TopicCreateClaim | null = null;
    let topic: TopicDto | null;
    try {
      topic = await create((created) => {
        claim = insertCommittedTopicCreateClaim({
          principalKey: link.principalKey,
          requestId: link.requestId,
          op: link.op,
          payloadHash: link.payloadHash,
          topicId: created.id,
          ...(link.sourceTopicId !== undefined ? { sourceTopicId: link.sourceTopicId } : {}),
        });
      });
    } catch (error) {
      // Another writer (a second process) committed the same key first: its
      // primary key rolled this topic back, so answer from its claim.
      const raced = getTopicCreateClaim(link.principalKey, link.requestId);
      if (raced) return answerExistingClaim(raced, link, req);
      throw error;
    }
    if (!topic) {
      // A creator that swallows its failure (derive returns null) may still
      // have lost the race to another process: answer from that claim.
      const raced = getTopicCreateClaim(link.principalKey, link.requestId);
      if (raced) return answerExistingClaim(raced, link, req);
      return null;
    }
    if (!claim) throw new Error("topic create finished without recording its claim");
    return claimedCreateResponse(topic, claim, false);
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Bounded retention sweep, from the create, list and claim routes (so a node
 * that stops creating still ages its claims out). At most one batch per call;
 * a full batch lets the next call continue instead of waiting an hour.
 */
function maybePruneClaims(): void {
  const now = Date.now();
  if (now - lastPrune < CLAIM_PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  try {
    if (pruneTopicCreateClaims(now) >= TOPIC_CREATE_CLAIM_PRUNE_BATCH) lastPrune = 0;
  } catch (error) {
    logger.warn({ error }, "otium link: claim prune failed");
  }
}

// ── read/recovery routes ──────────────────────────────────────────────────

/**
 * Stamp this process's identity into the store on authenticated requests (not
 * at handler construction: an embedding host may build the handler before it
 * configures storage). Checked against the CURRENT store every time — one
 * indexed read — so a store swapped in-process (a new DB handle) is stamped
 * too; the write happens only when the stored identity differs.
 */
export function initializeTopicLinkIdentity(): void {
  if (topicLinkNodeIdentity() === NODE_ID) return;
  recordTopicLinkNodeIdentity(NODE_ID);
}

function currentNodeId(): string {
  // The identity this process answers as — NOT the stored one: a tombstone
  // only binds when its stamp equals the node actually answering.
  return NODE_ID;
}

/** Identity fields a conditional delete's `2xx` carries (revision 7). */
export function topicDeleteIdentity(): { nodeId: string; dbEpoch: string | null } {
  return { nodeId: currentNodeId(), dbEpoch: topicLinkDbEpoch() };
}

/**
 * Revision 7 guard for `DELETE /topics/:id`, run before the topic is looked
 * up. With `x-negotium-expected-node-id`: a blank value is `400
 * invalid_expected_node_id`; a value that is not the identity this process
 * answers as — or a store stamped with another identity — is `409
 * node_identity_mismatch` carrying the current `nodeId`, and nothing is
 * deleted. Without the header (a hub older than revision 7) the delete goes
 * ahead as before, with a warning.
 */
export function topicDeleteIdentityGuard(req: Request, topicId: string): Response | null {
  const header = req.headers.get(NODE_EXPECTED_NODE_ID_HEADER);
  const nodeId = currentNodeId();
  if (header === null) {
    logger.warn(
      { topicId, nodeId },
      "topic delete without x-negotium-expected-node-id: identity not verified (pre-revision-7 host)",
    );
    return null;
  }
  const expected = header.trim();
  if (!expected) {
    return linkError(
      400,
      "invalid_expected_node_id",
      `${NODE_EXPECTED_NODE_ID_HEADER} must not be empty`,
      { nodeId, dbEpoch: topicLinkDbEpoch() },
    );
  }
  const stored = topicLinkNodeIdentity();
  if (expected !== nodeId || (stored !== null && stored !== nodeId)) {
    logger.warn(
      { topicId, nodeId, expectedNodeId: expected, storedNodeId: stored },
      "topic delete refused: expected node identity does not match this node",
    );
    return linkError(
      409,
      "node_identity_mismatch",
      "this delete was planned against a different node; nothing was deleted",
      { nodeId, dbEpoch: topicLinkDbEpoch(), expectedNodeId: expected },
    );
  }
  return null;
}

export type TopicExistenceState = "present" | "gone" | "unknown";

/**
 * Existence, bound to this node's identity (design v2 §4.5). `gone` ONLY when
 * this store holds a deletion tombstone written under the identity it answers
 * as; a topic this node simply does not have is `unknown`, never `gone`.
 */
export function topicExistence(req: Request, topicId: string) {
  const nodeId = currentNodeId();
  const base = {
    ok: true as const,
    v: CONTRACT_VERSION,
    nodeId,
    dbEpoch: topicLinkDbEpoch(),
    topicId,
  };
  const topic = getTopic(topicId);
  const tombstone = getTopicTombstone(topicId);
  if (topic) {
    const shared = topic.surface === "otium" && topic.visibility !== "hidden";
    if (recordInRequestScope(req, topic)) {
      return { ...base, state: "present" as const, shared };
    }
    // Withdrawn from this caller's workspace: the unshare tombstone proves it
    // once belonged to that caller, so saying "present, not shared" leaks
    // nothing it did not already know.
    // Same for a room an admin scope repair moved out of this caller's scope.
    const moved = latestTopicScopeMove(topicId);
    if (
      [tombstone, moved].some(
        (evidence) =>
          evidence?.reason === "unshared" &&
          evidence.nodeId === nodeId &&
          recordInRequestScope(req, evidence),
      )
    ) {
      return { ...base, state: "present" as const, shared: false };
    }
    return { ...base, state: "unknown" as const };
  }
  if (
    tombstone?.reason === "deleted" &&
    tombstone.nodeId !== null &&
    tombstone.nodeId === nodeId &&
    recordInRequestScope(req, tombstone)
  ) {
    return { ...base, state: "gone" as const, deletedAt: tombstone.deletedAt };
  }
  return { ...base, state: "unknown" as const };
}

function claimView(req: Request, requestId: string) {
  const claim = getTopicCreateClaim(topicLinkPrincipalKey(req), requestId);
  const base = {
    ok: true as const,
    v: CONTRACT_VERSION,
    nodeId: currentNodeId(),
    dbEpoch: topicLinkDbEpoch(),
    requestId,
  };
  maybePruneClaims();
  if (!claim) return { ...base, state: "none" as const };
  const topic = claim.topicId ? getTopic(claim.topicId) : null;
  // Present = exists AND still filed under this caller's workspace; a room
  // that left it reads as not present plus `topicMoved` (never its DTO).
  const inScope = topic !== null && recordInRequestScope(req, topic);
  return {
    ...base,
    state: claim.state,
    op: claim.op,
    topicId: claim.topicId,
    ...(claim.topicId ? { topicPresent: inScope } : {}),
    ...(topic && !inScope ? { topicMoved: true } : {}),
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

/**
 * Test seam for the abort path (gates between the fence and the cascade, and
 * a deterministic cleanup hook). Empty in production.
 */
export const topicLinkAbortTestHooks: AbortTopicCreateClaimOptions = {};

async function abortClaim(req: Request, requestId: string): Promise<Response> {
  const principalKey = topicLinkPrincipalKey(req);
  const key = claimKey({ principalKey, requestId });
  if (inFlight.has(key)) {
    return linkError(409, "request_in_progress", "this requestId is still being processed", {
      requestId,
    });
  }
  const base = {
    ok: true,
    v: CONTRACT_VERSION,
    nodeId: currentNodeId(),
    dbEpoch: topicLinkDbEpoch(),
    requestId,
  };
  inFlight.add(key);
  let result: Awaited<ReturnType<typeof abortTopicCreateClaim>>;
  try {
    // One BEGIN IMMEDIATE decides the claim's state and writes what the abort
    // needs (fence / flip / maintenance fence); see core `claim-abort.ts`.
    result = await abortTopicCreateClaim(principalKey, requestId, {
      ...topicLinkAbortTestHooks,
      // Re-verified inside the deciding transaction and again right before
      // the delete: a room that left this caller's workspace is never deleted
      // through the caller's old claim.
      topicInScope: (topic) => recordInRequestScope(req, topic),
    });
  } finally {
    inFlight.delete(key);
  }
  const topicId = result.claim.topicId;
  switch (result.kind) {
    case "fenced":
      return Response.json({ ...base, aborted: true, existed: false, topicDeleted: false });
    case "already-aborted":
    case "topic-missing":
      return Response.json({ ...base, aborted: true, existed: true, topicDeleted: false, topicId });
    case "deleted":
      return Response.json({ ...base, aborted: true, existed: true, topicDeleted: true, topicId });
    case "has-messages":
      return linkError(
        409,
        "claim_topic_has_messages",
        "the topic has messages written after its creation; it is not deleted automatically",
        { requestId, topicId },
      );
    case "moved":
      return linkError(
        409,
        "claim_topic_moved",
        "the topic created for this requestId left your workspace; it is not deleted",
        { requestId, topicId },
      );
    case "protected":
      return linkError(409, "claim_topic_protected", "the topic cannot be deleted by an abort", {
        requestId,
        topicId,
      });
    case "busy":
      return linkError(409, "claim_topic_busy", "the topic could not be deleted right now", {
        requestId,
        topicId,
      });
  }
}

function tombstonePage(req: Request, url: URL) {
  const after = Math.max(0, Number.parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
  const requested = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    TOMBSTONE_PAGE_MAX,
    Number.isFinite(requested) && requested > 0 ? requested : TOMBSTONE_PAGE_DEFAULT,
  );
  const nodeId = currentNodeId();
  const rows = listTopicTombstonesAfter(after, limit);
  const tombstones = rows
    .filter((row) => recordInRequestScope(req, row))
    // A scope move is news only to a caller that lost the room: one that still
    // sees it (the new scope, loopback) is not told it was withdrawn.
    .filter((row) => {
      if (!row.scopeMoved) return true;
      const topic = getTopic(row.topicId);
      return !(topic && recordInRequestScope(req, topic));
    })
    .map((row) => ({
      seq: row.seq,
      topicId: row.topicId,
      reason: row.reason,
      nodeId: row.nodeId,
      // Only a tombstone stamped with the identity answering now may be
      // treated as this node's own statement.
      boundToNode: row.nodeId !== null && row.nodeId === nodeId,
      surface: row.surface,
      surfaceScope: row.surfaceScope,
      deletedAt: row.deletedAt,
      ...(row.scopeMoved ? { scopeMoved: true } : {}),
    }));
  const last = rows.at(-1);
  return {
    ok: true,
    v: CONTRACT_VERSION,
    nodeId,
    dbEpoch: topicLinkDbEpoch(),
    // Highest seq ever handed out (never decreases). A cursor above it means
    // this store was rolled back.
    highWater: topicTombstoneHighWater(),
    tombstones,
    // Advances past rows filtered out of this caller's scope too.
    cursor: last ? last.seq : after,
    hasMore: rows.length === limit,
  };
}

/**
 * The new read/recovery routes. Returns null for any other path. Must run
 * inside the gateway's authenticated branch.
 */
export async function handleTopicLinkRoute(
  req: Request,
  runtimePath: string,
  url: URL,
): Promise<Response | null> {
  if (req.method === "GET" && runtimePath === "/surface-scope") {
    return Response.json({
      ok: true,
      v: CONTRACT_VERSION,
      nodeId: currentNodeId(),
      dbEpoch: topicLinkDbEpoch(),
      ...requestSurfaceScopeResolution(req),
      linkGuard: otiumLinkGuardMode(),
      // Revision 5 (additive): pre-existing otium rooms the M-9 stamp has not
      // been able to file yet (live maintenance, title conflict). Non-zero
      // means the migration is incomplete and still retrying.
      unscopedPending: surfaceScopeStampStatus().pending,
    });
  }
  if (req.method === "GET" && runtimePath === "/topic-tombstones") {
    return Response.json(tombstonePage(req, url));
  }
  const existence = runtimePath.match(/^\/topics\/([^/]+)\/existence$/);
  if (existence && req.method === "GET") {
    return Response.json(topicExistence(req, decodeURIComponent(existence[1] as string)));
  }
  const claimMatch = runtimePath.match(/^\/topic-claims\/([^/]+)(\/abort)?$/);
  if (claimMatch) {
    const requestId = decodeURIComponent(claimMatch[1] as string);
    if (!validRequestId(requestId)) {
      return linkError(
        400,
        "invalid_request_id",
        "requestId must be 1-200 characters without leading or trailing whitespace",
      );
    }
    if (!claimMatch[2] && req.method === "GET") return Response.json(claimView(req, requestId));
    if (claimMatch[2] && req.method === "POST") return abortClaim(req, requestId);
  }
  return null;
}
