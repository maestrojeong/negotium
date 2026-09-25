import type { RemoteSessionGrant } from "#types";

/**
 * Hard caps on a hub-supplied remote-session grant.
 *
 * Like the actor room assertion (`actor-topic-scope.ts`), the grant rides the
 * signed per-turn `session-comm` MCP token in a URL query and — with
 * `NEGOTIUM_BUILTIN_MCP_TRANSPORT=stdio` — one base64url argv entry, so the
 * transport bounds it, not the database. A capability is ≈330–440 characters
 * (`rsc1.<base64url JSON>.<base64url HMAC>`) and adds ≈680 URL characters
 * beside the maximal 8 KiB assertion (12,800 of the 14,336 budget, measured
 * in `hosted-runtime-spec.test.ts`). The caps below leave a hub room to grow
 * the payload, but a grant at both caps (≈3,475 URL characters) does not fit
 * beside the *maximal* assertion — `MCP_URL_BUDGET_CHARS` is the backstop and
 * refuses that mint loudly rather than dropping a field. A capability up to
 * ≈1,590 characters always fits.
 */
export const REMOTE_SESSION_GRANT_LIMITS = Object.freeze({
  /** Characters of `hubUrl`, after trimming. */
  maxHubUrlLength: 512,
  /** Characters of `capability`, after trimming. */
  maxCapabilityLength: 2 * 1024,
  /** The only capability format this node forwards. */
  capabilityPrefix: "rsc1.",
});

const GRANT_KEYS = ["hubUrl", "capability"] as const;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export type RemoteSessionGrantValidation =
  | { ok: true; grant: RemoteSessionGrant | undefined }
  | { ok: false; error: string };

/**
 * Normalize a hub URL the node may present a bearer to: loopback `http://`
 * or any `https://` origin, ≤ 512 characters, no credentials, no query or
 * fragment. Returns the canonical string (trailing slash dropped) or the
 * reason it is refused. The one rule for every hub URL the node stores — the
 * turn grant's `hubUrl` and an ask's `remoteReply.hubUrl` alike — so a
 * bearer can never be steered to an attacker-chosen host.
 */
export function normalizeHubUrl(
  raw: string,
  name = "remoteSession.hubUrl",
): { url: string } | { error: string } {
  if (raw.length > REMOTE_SESSION_GRANT_LIMITS.maxHubUrlLength) {
    return {
      error: `${name} is longer than ${REMOTE_SESSION_GRANT_LIMITS.maxHubUrlLength} characters`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: `${name} must be an absolute URL` };
  }
  if (url.username || url.password) {
    return { error: `${name} must not carry credentials` };
  }
  if (url.search || url.hash || raw.includes("?") || raw.includes("#")) {
    return { error: `${name} must not carry a query or fragment` };
  }
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return { error: `${name} must be https:// or a loopback http:// origin` };
    }
  } else if (url.protocol !== "https:") {
    return { error: `${name} must be https:// or a loopback http:// origin` };
  }
  return { url: url.toString().replace(/\/+$/, "") };
}

/** Shape of the hub's one-shot `rsr1` reply token; the node never verifies it. */
export const REMOTE_SESSION_REPLY_TOKEN_PATTERN = /^rsr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Same cap as the capability: the hub's tokens are ≈200 characters. */
export const MAX_REMOTE_SESSION_REPLY_TOKEN_LENGTH =
  REMOTE_SESSION_GRANT_LIMITS.maxCapabilityLength;

/**
 * Validate a hub-supplied remote-session grant and say why it failed.
 *
 * `undefined` in means `undefined` out (no grant: remote session-comm stays
 * fail-closed on `otium`); anything else must be exactly
 * `{ hubUrl, capability }` — a plain object with those two own keys — with a
 * callable hub URL and an opaque `rsc1.` capability within
 * {@link REMOTE_SESSION_GRANT_LIMITS}. The node never decodes or verifies the
 * capability: it is a bearer the hub issued and only the hub can check.
 */
export function validateRemoteSessionGrant(value: unknown): RemoteSessionGrantValidation {
  if (value === undefined) return { ok: true, grant: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "remoteSession must be { hubUrl: string, capability: string }" };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, error: "remoteSession must be a plain object" };
  }
  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !(GRANT_KEYS as readonly string[]).includes(key));
  if (unknown.length || keys.length !== GRANT_KEYS.length) {
    return {
      ok: false,
      error: unknown.length
        ? `remoteSession has unexpected key(s): ${unknown.join(", ")}`
        : "remoteSession must have both hubUrl and capability",
    };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.hubUrl !== "string" || !record.hubUrl.trim()) {
    return { ok: false, error: "remoteSession.hubUrl must be a non-empty string" };
  }
  const hubUrl = normalizeHubUrl(record.hubUrl.trim());
  if ("error" in hubUrl) return { ok: false, error: hubUrl.error };
  if (typeof record.capability !== "string" || !record.capability.trim()) {
    return { ok: false, error: "remoteSession.capability must be a non-empty string" };
  }
  const capability = record.capability.trim();
  if (capability.length > REMOTE_SESSION_GRANT_LIMITS.maxCapabilityLength) {
    return {
      ok: false,
      error: `remoteSession.capability is ${capability.length} characters; at most ${REMOTE_SESSION_GRANT_LIMITS.maxCapabilityLength} are allowed`,
    };
  }
  if (!capability.startsWith(REMOTE_SESSION_GRANT_LIMITS.capabilityPrefix)) {
    return {
      ok: false,
      error: `remoteSession.capability must start with "${REMOTE_SESSION_GRANT_LIMITS.capabilityPrefix}"`,
    };
  }
  // Three dot-separated base64url parts and nothing else, so a value that
  // is not even shaped like a capability never reaches the hub.
  if (!/^rsc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(capability)) {
    return { ok: false, error: "remoteSession.capability is malformed" };
  }
  return { ok: true, grant: { hubUrl: hubUrl.url, capability } };
}

/** {@link validateRemoteSessionGrant} collapsed to `null` on failure. */
export function parseRemoteSessionGrant(value: unknown): RemoteSessionGrant | undefined | null {
  const validated = validateRemoteSessionGrant(value);
  return validated.ok ? validated.grant : null;
}

export function isRemoteSessionGrant(value: unknown): value is RemoteSessionGrant {
  return parseRemoteSessionGrant(value) != null;
}

/**
 * Read a validated grant out of a persisted or signed context. Anything that
 * does not validate collapses to "no grant" rather than throwing: a stale row
 * only loses remote reach, it never breaks the turn.
 */
export function remoteSessionGrantFrom(value: unknown): RemoteSessionGrant | undefined {
  return parseRemoteSessionGrant(value) ?? undefined;
}

/**
 * Best-effort peek at the capability's expiry (`e`, epoch seconds), used only
 * to order grants when several requests fold into one turn. Untrusted: the
 * node never decides validity from it — the hub does.
 */
export function remoteSessionGrantExpiry(grant: RemoteSessionGrant): number | null {
  const payload = grant.capability.split(".")[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")) as unknown;
    const exp = (decoded as { e?: unknown } | null)?.e;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * The grant a merged turn runs with: symmetric to `intersectActorTopicScopes`
 * — a request without a grant leaves the batch without one (fail-closed), and
 * a batch of grants for one hub keeps the one that expires last so the merged
 * turn is not cut short by the oldest message's capability. Grants naming
 * different hubs never merge (the batch runs with none). The caller has
 * already ensured the folded requests speak for the same actor.
 */
export function mergeRemoteSessionGrants(
  grants: ReadonlyArray<RemoteSessionGrant | undefined>,
): RemoteSessionGrant | undefined {
  if (grants.length === 0 || grants.some((grant) => grant === undefined)) return undefined;
  const present = grants as RemoteSessionGrant[];
  const hubUrl = present[0]!.hubUrl;
  if (present.some((grant) => grant.hubUrl !== hubUrl)) return undefined;
  let chosen = present[present.length - 1]!;
  let chosenExpiry = remoteSessionGrantExpiry(chosen);
  for (const grant of present) {
    const expiry = remoteSessionGrantExpiry(grant);
    if (expiry !== null && (chosenExpiry === null || expiry > chosenExpiry)) {
      chosen = grant;
      chosenExpiry = expiry;
    }
  }
  return chosen;
}

/**
 * Argv-safe encoding for the stdio session-comm server
 * (`--remote-session-grant=`). Re-validated before encoding, so an in-process
 * caller cannot put an unbounded or malformed grant into argv.
 */
export function encodeRemoteSessionGrantArg(grant: RemoteSessionGrant): string {
  const validated = validateRemoteSessionGrant(grant);
  if (!validated.ok) throw new Error(validated.error);
  if (!validated.grant) throw new Error("remoteSession is required");
  return Buffer.from(JSON.stringify(validated.grant), "utf-8").toString("base64url");
}

/** Inverse of {@link encodeRemoteSessionGrantArg}; `null` when malformed. */
export function decodeRemoteSessionGrantArg(value: string): RemoteSessionGrant | null {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as unknown;
    return parseRemoteSessionGrant(decoded) ?? null;
  } catch {
    return null;
  }
}
