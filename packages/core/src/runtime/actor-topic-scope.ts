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
 * — a plain object with those two own keys and nothing else (so a stray
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
  const unknown = keys.filter((key) => !(SCOPE_KEYS as readonly string[]).includes(key));
  if (unknown.length || keys.length !== SCOPE_KEYS.length) {
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
  const scope: ActorTopicScope = { visibleNodeTopicIds: visible, ownedNodeTopicIds: owned };
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
  const [first, ...rest] = scopes as ActorTopicScope[];
  const keep = (key: keyof ActorTopicScope) =>
    first[key].filter((id) => rest.every((scope) => scope[key].includes(id)));
  return {
    visibleNodeTopicIds: keep("visibleNodeTopicIds"),
    ownedNodeTopicIds: keep("ownedNodeTopicIds"),
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
