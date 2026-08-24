/** "from" field for session-inbox entries injected after a setting change. */
export const FROM_AUTO_CONTINUE = "auto-continue";

/** "from" field for durable delayed continuations created by schedule_self. */
export const FROM_SELF_SCHEDULE = "self-schedule";

/** Topic names that collide with internal sentinels and must not be used. */
export const RESERVED_TOPIC_NAMES: ReadonlySet<string> = new Set([
  FROM_AUTO_CONTINUE,
  FROM_SELF_SCHEDULE,
  "general",
]);

/** Legacy shared General id. New General rooms use per-user UUIDs. */
export const GENERAL_TOPIC_ID = "general";

/**
 * Sanitized log name every private General resolves to.
 *
 * `general` is reserved above, so a manager room is the only room that can
 * produce it — which is what lets conversation storage qualify just that one
 * file per owner instead of namespacing the whole directory.
 */
export const MANAGER_TOPIC_LOG_NAME = "general";

/** The principal a standalone node runs as when no hub names another. */
export const NODE_LOCAL_USER_ID = "local";

/** Internal topic name for the forum manager session (General topic). */
export const TOPIC_MANAGER = "__manager__";
