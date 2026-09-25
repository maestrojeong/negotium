import type { ActorTopicScope } from "#types";

/**
 * Hard caps on a hub-supplied room assertion.
 *
 * The assertion is not stored and forgotten: it rides the signed per-turn MCP
 * token, which every hosted built-in MCP server receives in the URL query
 * (`?token=`) of an `http://127.0.0.1` request, and — with
 * `NEGOTIUM_BUILTIN_MCP_TRANSPORT=stdio` — one base64url argv entry of the
 * session-comm child. The transport, not the database, is the tight bound:
 *
 * - `Bun.serve` answers 431 once the request line is too long (Bun 1.3.14:
 *   a 16,205-character URL is served, 16,305 is refused). These caps alone
 *   do not bound the URL — the token carries other fields — so the whole URL
 *   is budgeted at `MCP_URL_BUDGET_CHARS` (14 KiB) in `runtime-spec.ts`,
 *   where the numbers live. The 8 KiB assertion below becomes 10,924
 *   base64url characters at most; with every other runtime-token field at
 *   its largest (the prompt itself is not in the token — only the derived
 *   `explicitAgentSwitchTargets`, at most three agent names) the URL is
 *   ≤ ~13.4 KB.
 * - argv: `encodeActorTopicScopeArg` is the assertion alone, ≤ 10,924
 *   characters, far below Linux `MAX_ARG_STRLEN` (128 KiB) for one argument
 *   and macOS `ARG_MAX` (1 MiB) overall. The encoder re-validates before it
 *   encodes, so an in-process caller that bypassed the gateway parser cannot
 *   put an unbounded object into argv either.
 *
 * With UUID room ids (39 bytes each serialized) the byte cap admits roughly
 * 208 ids across both lists; the per-list count cap bounds the work done on
 * an assertion before its size is known, and the id length cap keeps a single
 * id from being the whole budget. Raising these means moving the assertion
 * out of the token (server-side per-turn context), not editing the numbers.
 */
export const ACTOR_TOPIC_SCOPE_LIMITS = Object.freeze({
  /** Ids per list, counted before de-duplication. */
  maxIdsPerList: 200,
  /** Characters per id, after trimming. */
  maxIdLength: 128,
  /** UTF-8 bytes of the normalized assertion as JSON. */
  maxSerializedBytes: 8 * 1024,
});

const SCOPE_KEYS = ["visibleNodeTopicIds", "ownedNodeTopicIds"] as const;
const OPTIONAL_SCOPE_KEYS = ["issuedAt"] as const;

/**
 * How long a hub room assertion is believed after it was issued.
 *
 * The assertion rides the per-turn MCP token, which lives for hours
 * (`HOSTED_MCP_TOKEN_TTL_MS`), and nothing on this node re-asks the hub
 * whether a person is still in a room. Without a bound, a person removed from
 * a room would keep reaching it for the whole token lifetime. Past this age
 * the assertion is stale and grants no cross-room reach (fail-closed, see
 * `isActorTopicScopeFresh`): a person removed from a room loses it on their
 * next turn (a fresh assertion), and at the latest this long after the
 * assertion was issued for a turn that is still running.
 *
 * Trade-off (product decision, safe default): a turn that runs longer than
 * this keeps its own room and its own lineage but can no longer list, tell,
 * ask or abort other rooms until the person speaks again.
 * `NEGOTIUM_ACTOR_TOPIC_SCOPE_MAX_AGE_MS` overrides it, clamped to
 * [0, `ACTOR_TOPIC_SCOPE_MAX_AGE_CEILING_MS`]; `0` disables cross-room reach.
 */
export const ACTOR_TOPIC_SCOPE_DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;
/** Never believe an assertion longer than a hosted MCP token lives. */
export const ACTOR_TOPIC_SCOPE_MAX_AGE_CEILING_MS = 4 * 60 * 60 * 1000;
/** A stamp this far ahead of the local clock is not trusted as "fresh". */
const ACTOR_TOPIC_SCOPE_FUTURE_SKEW_MS = 60 * 1000;

export function actorTopicScopeMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NEGOTIUM_ACTOR_TOPIC_SCOPE_MAX_AGE_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return ACTOR_TOPIC_SCOPE_DEFAULT_MAX_AGE_MS;
  return Math.min(Number(raw), ACTOR_TOPIC_SCOPE_MAX_AGE_CEILING_MS);
}

/**
 * Whether `scope` may still grant cross-room reach at `now`. An assertion
 * without `issuedAt` (a row or token written before the stamp existed) is
 * never fresh — the safe reading of "we do not know how old this is".
 */
export function isActorTopicScopeFresh(
  scope: ActorTopicScope,
  now: number = Date.now(),
  maxAgeMs: number = actorTopicScopeMaxAgeMs(),
): boolean {
  const issuedAt = scope.issuedAt;
  if (issuedAt === undefined) return false;
  if (issuedAt > now + ACTOR_TOPIC_SCOPE_FUTURE_SKEW_MS) return false;
  return now - issuedAt <= maxAgeMs;
}

/**
 * Stamp an assertion as it enters this node. The node's receipt time is the
 * upper bound (a hub `issuedAt` in the future, e.g. clock skew, cannot extend
 * it); an older hub `issuedAt` is kept, so time the hub spent before sending
 * counts against the window.
 */
export function stampActorTopicScope(
  scope: ActorTopicScope,
  now: number = Date.now(),
): ActorTopicScope {
  const issuedAt = scope.issuedAt === undefined ? now : Math.min(scope.issuedAt, now);
  return { ...scope, issuedAt };
}

export type ActorTopicScopeValidation =
  | { ok: true; scope: ActorTopicScope | undefined }
  | { ok: false; error: string };

function idList(value: unknown, name: string): string[] | string {
  if (!Array.isArray(value)) return `${name} must be an array of topic ids`;
  if (value.length > ACTOR_TOPIC_SCOPE_LIMITS.maxIdsPerList) {
    return `${name} has ${value.length} ids; at most ${ACTOR_TOPIC_SCOPE_LIMITS.maxIdsPerList} are allowed`;
  }
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return `${name} must contain only strings`;
    const id = item.trim();
    if (!id) return `${name} must not contain empty ids`;
    if (id.length > ACTOR_TOPIC_SCOPE_LIMITS.maxIdLength) {
      return `${name} contains an id longer than ${ACTOR_TOPIC_SCOPE_LIMITS.maxIdLength} characters`;
    }
    ids.add(id);
  }
  return [...ids];
}

/**
 * Validate a hub-supplied room assertion and say why it failed.
 *
 * `undefined` in means `undefined` out (no assertion, fail-closed downstream);
 * anything else must be exactly `{ visibleNodeTopicIds, ownedNodeTopicIds }`
 * plus an optional `issuedAt` (epoch ms) — a plain object with those own keys
 * and nothing else (so a stray
 * `__proto__` or `constructor` key is a rejection, not a property), each a
 * list of non-empty strings within {@link ACTOR_TOPIC_SCOPE_LIMITS} — or it is
 * rejected, so a malformed assertion can never be read as "everything".
 */
export function validateActorTopicScope(value: unknown): ActorTopicScopeValidation {
  if (value === undefined) return { ok: true, scope: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error:
        "actorTopicScope must be { visibleNodeTopicIds: string[], ownedNodeTopicIds: string[] }",
    };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, error: "actorTopicScope must be a plain object" };
  }
  const keys = Object.keys(value);
  const allowed: readonly string[] = [...SCOPE_KEYS, ...OPTIONAL_SCOPE_KEYS];
  const unknown = keys.filter((key) => !allowed.includes(key));
  const required = SCOPE_KEYS.filter((key) => keys.includes(key)).length;
  if (unknown.length || required !== SCOPE_KEYS.length) {
    return {
      ok: false,
      error: unknown.length
        ? `actorTopicScope has unexpected key(s): ${unknown.join(", ")}`
        : "actorTopicScope must have both visibleNodeTopicIds and ownedNodeTopicIds",
    };
  }
  const record = value as Record<string, unknown>;
  const visible = idList(record.visibleNodeTopicIds, "actorTopicScope.visibleNodeTopicIds");
  if (typeof visible === "string") return { ok: false, error: visible };
  const owned = idList(record.ownedNodeTopicIds, "actorTopicScope.ownedNodeTopicIds");
  if (typeof owned === "string") return { ok: false, error: owned };
  const issuedAt = record.issuedAt;
  if (issuedAt !== undefined && (!Number.isSafeInteger(issuedAt) || (issuedAt as number) < 0)) {
    return { ok: false, error: "actorTopicScope.issuedAt must be epoch milliseconds" };
  }
  const scope: ActorTopicScope = {
    visibleNodeTopicIds: visible,
    ownedNodeTopicIds: owned,
    ...(issuedAt !== undefined ? { issuedAt: issuedAt as number } : {}),
  };
  const bytes = Buffer.byteLength(JSON.stringify(scope), "utf-8");
  if (bytes > ACTOR_TOPIC_SCOPE_LIMITS.maxSerializedBytes) {
    return {
      ok: false,
      error: `actorTopicScope is ${bytes} bytes serialized; at most ${ACTOR_TOPIC_SCOPE_LIMITS.maxSerializedBytes} are allowed`,
    };
  }
  return { ok: true, scope };
}

/**
 * Validate a hub-supplied room assertion.
 *
 * `undefined` in means `undefined` out (no assertion, fail-closed downstream);
 * anything else must pass {@link validateActorTopicScope} or it is rejected
 * with `null`. Every path an assertion can enter by — the gateway body, the
 * signed MCP tokens, the stdio argv — goes through this one parser, so the
 * limits cannot drift between them.
 */
export function parseActorTopicScope(value: unknown): ActorTopicScope | undefined | null {
  const validated = validateActorTopicScope(value);
  return validated.ok ? validated.scope : null;
}

export function isActorTopicScope(value: unknown): value is ActorTopicScope {
  return parseActorTopicScope(value) != null;
}

/**
 * Read a validated assertion out of a persisted or signed context. Anything
 * that does not validate collapses to "no assertion" rather than throwing, so
 * a stale row cannot break a turn — it only narrows it to what a turn without
 * an assertion reaches: the current room plus its own subagent lineage.
 */
export function actorTopicScopeFrom(value: unknown): ActorTopicScope | undefined {
  return parseActorTopicScope(value) ?? undefined;
}

/**
 * The strictest assertion two requests agree on: an id is kept only when both
 * assert it, and a request without an assertion leaves the result without one
 * (fail-closed). Used when several pending requests of one actor fold into a
 * single turn, so the merged turn never reaches a room one of them could not.
 */
export function intersectActorTopicScopes(
  scopes: ReadonlyArray<ActorTopicScope | undefined>,
): ActorTopicScope | undefined {
  if (scopes.length === 0 || scopes.some((scope) => scope === undefined)) return undefined;
  const all = scopes as ActorTopicScope[];
  const [first, ...rest] = all;
  const keep = (key: "visibleNodeTopicIds" | "ownedNodeTopicIds") =>
    first[key].filter((id) => rest.every((scope) => scope[key].includes(id)));
  // The oldest stamp wins; one unstamped request leaves the batch unstamped
  // (stale), never fresher than any folded assertion.
  const stamps = all.map((scope) => scope.issuedAt);
  const issuedAt = stamps.every((stamp) => stamp !== undefined)
    ? Math.min(...(stamps as number[]))
    : undefined;
  return {
    visibleNodeTopicIds: keep("visibleNodeTopicIds"),
    ownedNodeTopicIds: keep("ownedNodeTopicIds"),
    ...(issuedAt !== undefined ? { issuedAt } : {}),
  };
}

/**
 * Argv-safe encoding for the stdio session-comm server (`--actor-topic-scope=`).
 * Bounded by {@link ACTOR_TOPIC_SCOPE_LIMITS}: 8,192 bytes of JSON become at
 * most 10,924 base64url characters, see there. The input is put through
 * {@link validateActorTopicScope} first and an invalid or oversized assertion
 * throws — it is never truncated (which would narrow the turn silently) nor
 * passed on (which would let a typed in-process caller overflow argv).
 */
export function encodeActorTopicScopeArg(scope: ActorTopicScope): string {
  const validated = validateActorTopicScope(scope);
  if (!validated.ok) throw new Error(validated.error);
  if (!validated.scope) throw new Error("actorTopicScope is required");
  return Buffer.from(JSON.stringify(validated.scope), "utf-8").toString("base64url");
}
