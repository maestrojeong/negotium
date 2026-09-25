/**
 * Node → hub client for remote (`node/topic`) session-comm on the `otium`
 * surface.
 *
 * The node never decides who may reach what across nodes. It presents the
 * turn's hub-issued capability (`RemoteSessionGrant.capability`, an opaque
 * `rsc1.` bearer) to the hub, names the target as the person typed it, and
 * the hub — the only party holding the signing key and the membership store —
 * verifies the capability, re-checks the person's membership of the origin
 * and target rooms at call time, and forwards into the target node over the
 * Runtime Gateway. No actor id travels in these bodies: the hub recovers the
 * actor from the capability.
 *
 * Wire contract (mirrored in `docs/RUNTIME-GATEWAY-CONTRACT.md`):
 *   POST {hubUrl}/api/v1/session-comm/remote/{sessions|peek|tell|ask|abort}
 *   Authorization: Bearer <capability>      Content-Type: application/json
 *   Success: exactly `{ ok:true, v:1, ... }` (a 2xx with any other body is a
 *   protocol failure, never a success — a proxy's 200 error page must not
 *   settle anything). Errors: { ok:false, v:1, error, code? } with
 *   400/401/404/409/413/429/502/503; `409 code:"in_progress"` means the hub
 *   is still working on the same requestId and is retried like a transport
 *   failure. Every POST carries a bearer and therefore never follows a
 *   redirect (`redirect: "error"`).
 */
import { logger } from "#platform/logger";
import type { RemoteSessionGrant } from "#types";

export const REMOTE_SESSION_HUB_BASE_PATH = "/api/v1/session-comm/remote";
export const REMOTE_SESSION_PROTOCOL_VERSION = 1 as const;
/** One attempt's wall clock, generous because the hub itself calls a node. */
const HUB_TIMEOUT_MS = 15_000;
/** Same `requestId` again after a transport failure: the hub claims it once. */
const HUB_RETRY_DELAYS_MS = [50, 150] as const;
/** The hub's "same requestId still in flight" verdict: retry, do not conclude. */
export const HUB_IN_PROGRESS_CODE = "in_progress";

export interface RemoteSessionTarget {
  node: string;
  topic: string;
}

export interface RemoteSessionFromLabel {
  /** `kind:title` of the origin room, as `session-comm` labels senders. */
  key: string;
  title: string;
}

export interface RemoteSessionListedRoom {
  name: string;
  /**
   * `null` = the hub says this room has no AI. Absent on `/peek`, whose
   * entries carry only name + status (interface §2.2) — the node then keeps
   * the room, having nothing that says otherwise.
   */
  agent?: string | null;
  /**
   * v1: "active" when the hub sees a turn in flight, otherwise "ready".
   * Optional on `/sessions`, **required** on `/peek` — that is the whole
   * answer a peek gives, and an absent one would read as idle.
   */
  status?: "active" | "ready";
  description?: string | null;
  role?: "owner" | "member";
}

/**
 * One node in a listing: its rooms, or why the hub could not answer for it —
 * exactly one of the two, never both and never neither (interface §2.1).
 */
export type RemoteSessionNodeListing =
  | { node: string; sessions: RemoteSessionListedRoom[]; error?: undefined }
  | { node: string; sessions?: undefined; error: string };

export interface RemoteSessionPendingAsk {
  to: string;
  requestId: string;
  status: "forwarded" | "reply_pending";
}

export type RemoteSessionCallError = {
  ok: false;
  /** Human-readable, safe to show the agent verbatim. */
  error: string;
  /** HTTP status the hub answered with; absent when it did not answer at all. */
  status?: number;
  code?: string;
  /** The request may have been delivered (a response timed out after sending). */
  uncertain?: boolean;
};

export type RemoteSessionsResult =
  | { ok: true; nodes: RemoteSessionNodeListing[] }
  | RemoteSessionCallError;

export type RemoteSessionPeekResult =
  | { ok: true; nodes: RemoteSessionNodeListing[]; pendingAsks: RemoteSessionPendingAsk[] }
  | RemoteSessionCallError;

export type RemoteSessionDeliveryResult =
  | { ok: true; requestId: string; replayed: boolean }
  | RemoteSessionCallError;

export type RemoteSessionHubFetch = (input: string, init: RequestInit) => Promise<Response>;

let hubFetch: RemoteSessionHubFetch = (input, init) => fetch(input, init);

/** Test seam: replace the transport without an HTTP server. */
export function setRemoteSessionHubFetch(next: RemoteSessionHubFetch | null): void {
  hubFetch = next ?? ((input, init) => fetch(input, init));
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

/**
 * Socket-level causes that prove the request never reached the hub: the
 * connection was never established, so nothing could have been delivered.
 * Everything else — including the bare `TypeError: fetch failed` a socket
 * hangup after the bytes went out produces — has to count as *maybe*
 * delivered.
 */
const NEVER_REACHED_HUB_CAUSE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_INVALID_URL",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);

/**
 * Whether a transport failure is provably *before* the request left: only
 * then is "not delivered" a fact.
 *
 * The default has to be the other way round. Once `fetch` has been called the
 * request may already be at the hub, and a hangup while waiting for the
 * response surfaces as `TypeError("fetch failed")` — indistinguishable by
 * name from a refused connection. Treating that as a clean failure is what
 * loses messages: the caller then deletes its pending marker and the durable
 * ask, so the hub's late `ask-reply` 404s and a `tell` retry duplicates.
 * Erring the other way only costs a "delivery unconfirmed" line.
 */
function neverReachedHub(error: unknown): boolean {
  if (isTimeout(error)) return false;
  const cause = (error as { cause?: { code?: unknown } | null } | null)?.cause;
  const code = cause?.code;
  return typeof code === "string" && NEVER_REACHED_HUB_CAUSE_CODES.has(code);
}

/**
 * The v1 success envelope, checked exactly: `ok === true`, `v === 1`, and
 * the fields the operation promises with their types. Anything else on a
 * 2xx — an HTML page, a JSON error with the wrong `v`, a missing `ok` — is
 * not the hub's answer and must not be treated as one.
 */
export type HubEnvelopeShape = "sessions" | "peek" | "delivery" | "reply";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Which listing the rooms came from. `/sessions` describes rooms (`status` is
 * an optional extra); `/peek` exists *only* to say which of them are running,
 * so there a room without `status` carries no answer at all — and read as an
 * absent field it silently becomes "idle", which is the one reading a peek
 * must never invent (interface §2.2).
 */
type ListingMode = "sessions" | "peek";

/**
 * One room in a node's listing, parsed field by field.
 *
 * An array that merely *is* an array is not a listing: `[null]`, `[{}]` or a
 * room whose `name` is a number all used to pass the envelope check and then
 * crash (or silently render `undefined/undefined`) in the caller that reads
 * `session.name`. The hub is a peer, not a trusted library, so its 200 gets
 * the same scrutiny as its 400.
 */
function parseListedRoom(value: unknown, mode: ListingMode): RemoteSessionListedRoom | null {
  if (!isPlainRecord(value)) return null;
  const { name, agent, status, description, role } = value;
  if (typeof name !== "string" || !name.trim()) return null;
  if (agent !== undefined && agent !== null && typeof agent !== "string") return null;
  if (status === undefined) {
    // A peek entry is its status; without one the entry answers nothing.
    if (mode === "peek") return null;
  } else if (status !== "active" && status !== "ready") {
    return null;
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    return null;
  }
  if (role !== undefined && role !== "owner" && role !== "member") return null;
  return {
    name,
    ...(agent !== undefined ? { agent } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(role !== undefined ? { role } : {}),
  };
}

/**
 * One node's entry: `sessions` or `error`, exactly one of the two.
 *
 * The contract makes them alternatives (interface §2.1), and the readers rely
 * on it: a node reported as unreachable *and* carrying rooms would be printed
 * as unreachable while its rooms vanish, and one carrying neither would be a
 * node the person can neither address nor be told about. Either way the hub
 * and this node no longer agree on what was said, which is a protocol failure,
 * not a listing.
 */
function parseNodeListing(value: unknown, mode: ListingMode): RemoteSessionNodeListing | null {
  if (!isPlainRecord(value)) return null;
  const { node, sessions, error } = value;
  // The node name is what the person types before the slash, so a name
  // containing one could never be addressed and is not a valid listing.
  if (typeof node !== "string" || !node.trim() || node.includes("/")) return null;
  if (error !== undefined && (typeof error !== "string" || !error.trim())) return null;
  if ((sessions === undefined) === (error === undefined)) return null;
  if (sessions === undefined) return { node, error: error as string };
  if (!Array.isArray(sessions)) return null;
  const parsed: RemoteSessionListedRoom[] = [];
  for (const entry of sessions) {
    const room = parseListedRoom(entry, mode);
    if (!room) return null;
    parsed.push(room);
  }
  return { node, sessions: parsed };
}

function parseNodeListings(value: unknown, mode: ListingMode): RemoteSessionNodeListing[] | null {
  if (!Array.isArray(value)) return null;
  const listings: RemoteSessionNodeListing[] = [];
  for (const entry of value) {
    const listing = parseNodeListing(entry, mode);
    if (!listing) return null;
    listings.push(listing);
  }
  return listings;
}

function parsePendingAsks(value: unknown): RemoteSessionPendingAsk[] | null {
  if (!Array.isArray(value)) return null;
  const asks: RemoteSessionPendingAsk[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) return null;
    const { to, requestId, status } = entry;
    if (typeof to !== "string" || !to.trim()) return null;
    if (typeof requestId !== "string" || !requestId.trim()) return null;
    if (status !== "forwarded" && status !== "reply_pending") return null;
    asks.push({ to, requestId, status });
  }
  return asks;
}

/**
 * The parsed v1 success payload, or `null` for anything that is not it.
 *
 * `null` is not "an empty answer": every caller turns it into a protocol
 * failure, which is retried and then reported as unconfirmed, exactly like a
 * transport failure.
 */
export type HubSuccessEnvelope =
  | { shape: "sessions"; nodes: RemoteSessionNodeListing[] }
  | { shape: "peek"; nodes: RemoteSessionNodeListing[]; pendingAsks: RemoteSessionPendingAsk[] }
  | { shape: "delivery"; replayed: boolean }
  | { shape: "reply"; replayed: boolean };

export function validateHubSuccessEnvelope(
  body: unknown,
  shape: HubEnvelopeShape,
): HubSuccessEnvelope | null {
  if (!isPlainRecord(body)) return null;
  if (body.ok !== true || body.v !== REMOTE_SESSION_PROTOCOL_VERSION) return null;
  switch (shape) {
    case "sessions": {
      const nodes = parseNodeListings(body.nodes, "sessions");
      return nodes ? { shape, nodes } : null;
    }
    case "peek": {
      const nodes = parseNodeListings(body.nodes, "peek");
      const pendingAsks = parsePendingAsks(body.pendingAsks);
      return nodes && pendingAsks ? { shape, nodes, pendingAsks } : null;
    }
    case "delivery":
    case "reply":
      return typeof body.replayed === "boolean" ? { shape, replayed: body.replayed } : null;
  }
}

function hubHeaders(bearer: string): Record<string, string> {
  return {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

function errorText(status: number, body: unknown, fallback: string): string {
  const text = (body as { error?: unknown } | null)?.error;
  if (typeof text === "string" && text.trim()) return text.trim();
  return `${fallback} (hub answered ${status})`;
}

function describeFailure(status: number, body: unknown): string {
  switch (status) {
    case 401:
      return "remote session authorization for this turn is no longer valid (expired or revoked); send a new message to start a turn with a fresh grant";
    case 404:
      return errorText(status, body, "remote session not found");
    case 409:
      return errorText(status, body, "remote session refused the request");
    case 413:
      return errorText(status, body, "message too long for the hub");
    case 429:
      return errorText(status, body, "remote session rate limit reached; try again shortly");
    case 502:
      return errorText(status, body, "the target node could not be reached by the hub");
    case 503:
      return errorText(status, body, "remote session-comm is disabled on the hub");
    default:
      return errorText(status, body, "hub refused the remote session call");
  }
}

async function postHub(
  grant: RemoteSessionGrant,
  op: "sessions" | "peek" | "tell" | "ask" | "abort",
  shape: HubEnvelopeShape,
  body: Record<string, unknown>,
  opts: { retry: boolean },
): Promise<{ ok: true; body: HubSuccessEnvelope } | RemoteSessionCallError> {
  const url = `${grant.hubUrl}${REMOTE_SESSION_HUB_BASE_PATH}/${op}`;
  const payload = JSON.stringify({ v: REMOTE_SESSION_PROTOCOL_VERSION, ...body });
  let uncertain = false;
  let lastError = "hub unreachable";
  const attempts = opts.retry ? HUB_RETRY_DELAYS_MS.length + 1 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, HUB_RETRY_DELAYS_MS[attempt - 1]));
    }
    let response: Response;
    try {
      response = await hubFetch(url, {
        method: "POST",
        headers: hubHeaders(grant.capability),
        body: payload,
        signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error) {
      // Uncertain by default: the send has started, so only a failure that
      // provably happened before the connection existed is a clean "not
      // delivered" (see `neverReachedHub`).
      if (!neverReachedHub(error)) uncertain = true;
      lastError = `hub unreachable: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (response.ok) {
      const envelope = validateHubSuccessEnvelope(parsed, shape);
      if (envelope) return { ok: true, body: envelope };
      // A 2xx that is not the v1 envelope is not the hub speaking (a relay's
      // error page, a version skew): the request may or may not have landed.
      uncertain = true;
      lastError = `hub answered ${response.status} with an unexpected body`;
      continue;
    }
    const code =
      typeof (parsed as { code?: unknown } | null)?.code === "string"
        ? (parsed as { code: string }).code
        : undefined;
    if (code === HUB_IN_PROGRESS_CODE && (response.status === 409 || response.status === 502)) {
      // The hub is still delivering this very requestId: the outcome is not
      // known yet, so this is neither success nor a final refusal. The code —
      // not the status — is what carries that meaning: the contract says 409,
      // but a hub that flattens the target node's 409 into its own 502 while
      // keeping the code is still saying "in flight", and reading it as a
      // final 502 is exactly what drops a pending ask a late reply needs.
      uncertain = true;
      lastError = describeFailure(response.status, parsed);
      continue;
    }
    // 5xx other than the hub's own "node unreachable" verdict is worth one
    // more try; everything else is the hub's answer.
    if (response.status >= 500 && response.status !== 502 && response.status !== 503) {
      lastError = describeFailure(response.status, parsed);
      continue;
    }
    return {
      ok: false,
      error: describeFailure(response.status, parsed),
      status: response.status,
      ...(code ? { code } : {}),
    };
  }
  logger.warn({ op, hubUrl: grant.hubUrl, uncertain }, "session-comm: hub remote call failed");
  return { ok: false, error: lastError, ...(uncertain ? { uncertain: true } : {}) };
}

/** Rooms on other nodes the person who spoke may address, grouped by node. */
export async function hubRemoteSessions(grant: RemoteSessionGrant): Promise<RemoteSessionsResult> {
  const result = await postHub(grant, "sessions", "sessions", {}, { retry: true });
  if (!result.ok) return result;
  if (result.body.shape !== "sessions") return { ok: false, error: "hub answered the wrong shape" };
  return { ok: true, nodes: result.body.nodes };
}

/** Remote running/idle view plus this turn's asks the hub still holds. */
export async function hubRemotePeek(grant: RemoteSessionGrant): Promise<RemoteSessionPeekResult> {
  const result = await postHub(grant, "peek", "peek", {}, { retry: true });
  if (!result.ok) return result;
  if (result.body.shape !== "peek") return { ok: false, error: "hub answered the wrong shape" };
  return { ok: true, nodes: result.body.nodes, pendingAsks: result.body.pendingAsks };
}

function deliveryResult(
  requestId: string,
  result: { ok: true; body: HubSuccessEnvelope } | RemoteSessionCallError,
): RemoteSessionDeliveryResult {
  if (!result.ok) return result;
  if (result.body.shape !== "delivery") return { ok: false, error: "hub answered the wrong shape" };
  return { ok: true, requestId, replayed: result.body.replayed };
}

export async function hubRemoteTell(
  grant: RemoteSessionGrant,
  args: {
    requestId: string;
    to: RemoteSessionTarget;
    message: string;
    depth: number;
    fromLabel: RemoteSessionFromLabel;
  },
): Promise<RemoteSessionDeliveryResult> {
  return deliveryResult(
    args.requestId,
    await postHub(grant, "tell", "delivery", args, { retry: true }),
  );
}

export async function hubRemoteAsk(
  grant: RemoteSessionGrant,
  args: {
    requestId: string;
    to: RemoteSessionTarget;
    message: string;
    fromDepth: number;
    fromLabel: RemoteSessionFromLabel;
  },
): Promise<RemoteSessionDeliveryResult> {
  return deliveryResult(
    args.requestId,
    await postHub(grant, "ask", "delivery", args, { retry: true }),
  );
}

export async function hubRemoteAbort(
  grant: RemoteSessionGrant,
  args: { requestId: string; to: RemoteSessionTarget },
): Promise<RemoteSessionDeliveryResult> {
  return deliveryResult(
    args.requestId,
    await postHub(grant, "abort", "delivery", args, { retry: true }),
  );
}

/**
 * Post an ask's answer to the hub with the one-shot reply token the hub put
 * in the inbox entry. Returns whether the outbox row may be dropped: the hub
 * accepted it (or already had it) with the exact v1 envelope, or gave a final
 * answer that no retry can change (bad/expired token, unknown request).
 * Transport failures, 5xx, 429, `409 in_progress` and a 2xx without the
 * envelope keep the row for the outbox worker.
 */
export async function hubRemoteReply(args: {
  hubUrl: string;
  token: string;
  requestId: string;
  kind: "reply" | "error";
  replyText: string;
  fromLabel: string;
}): Promise<{ settled: true; replayed: boolean } | { settled: false; error: string }> {
  const url = `${args.hubUrl}${REMOTE_SESSION_HUB_BASE_PATH}/reply`;
  let response: Response;
  try {
    response = await hubFetch(url, {
      method: "POST",
      headers: hubHeaders(args.token),
      body: JSON.stringify({
        v: REMOTE_SESSION_PROTOCOL_VERSION,
        requestId: args.requestId,
        kind: args.kind,
        replyText: args.replyText,
        fromLabel: args.fromLabel,
      }),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    return {
      settled: false,
      error: `hub unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (response.ok) {
    const envelope = validateHubSuccessEnvelope(parsed, "reply");
    if (!envelope) {
      return {
        settled: false,
        error: `hub answered ${response.status} with an unexpected body`,
      };
    }
    return { settled: true, replayed: envelope.shape === "reply" && envelope.replayed };
  }
  const code = (parsed as { code?: unknown } | null)?.code;
  if (
    response.status >= 500 ||
    response.status === 429 ||
    (response.status === 409 && code === HUB_IN_PROGRESS_CODE)
  ) {
    return { settled: false, error: describeFailure(response.status, parsed) };
  }
  logger.warn(
    {
      requestId: args.requestId,
      status: response.status,
      error: describeFailure(response.status, parsed),
    },
    "session-comm: hub rejected an ask reply; dropping it",
  );
  return { settled: true, replayed: false };
}
