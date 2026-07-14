/**
 * Per-topic agent/model/effort/MCP override — read side.
 *
 * Overrides are persisted in SQLite (storage/api-topic-config.ts), keyed by
 * topicId, so they survive restarts — required now that topic config is the
 * canonical model/agent/effort switching path (the MCP-based direction). The
 * turn runner reads these via getTopicConfig() and resolves them at
 * `config override > topic default` priority.
 *
 * The REST GET/PATCH routes (validation, access control, agent switching)
 * stayed in the host; core only needs the getter.
 */

import { getApiTopicConfig, type TopicConfig } from "#storage/api-topic-config";

export type { TopicConfig };

/**
 * Per-topic agent/model/effort override set via `PATCH /config`.
 *
 * The AI query path (turn-runner) reads this so a stored override actually
 * takes effect on plain messages. Without this getter the override was
 * write-only: `GET /config` reflected it but the agent kept using
 * `topic.defaultModel` (bug A — owner PATCHes {model:"opus"}, response still
 * answered as sonnet). Returns `undefined` when the topic has no override.
 */
export function getTopicConfig(topicId: string): TopicConfig | undefined {
  return getApiTopicConfig(topicId);
}
