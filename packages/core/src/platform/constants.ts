/** "from" field for session-inbox entries injected after a setting change. */
export const FROM_AUTO_CONTINUE = "auto-continue";

/** Topic names that collide with internal sentinels and must not be used. */
export const RESERVED_TOPIC_NAMES: ReadonlySet<string> = new Set([FROM_AUTO_CONTINUE, "general"]);

/** Legacy shared General id. New General rooms use per-user UUIDs. */
export const GENERAL_TOPIC_ID = "general";

/** Internal topic name for the forum manager session (General topic). */
export const TOPIC_MANAGER = "__manager__";
