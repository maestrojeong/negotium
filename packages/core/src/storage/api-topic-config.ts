// Persistent per-topic model/effort/MCP overrides and user locks.
// SQLite. Mirrors api-topics.ts. This replaces the previous in-memory Map in
// routes/topic-config.ts, which lost every override on server restart — a
// regression now that topic config is the canonical path for model/effort
// switching (the MCP-based direction), not just a transient convenience.
import { db } from "#storage/forum-db";
import type { EffortLevel } from "#types";

function tableColumns(table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function createCanonicalConfigTable(name = "api_topic_config"): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${name} (
      topic_id TEXT PRIMARY KEY REFERENCES api_topics(id) ON DELETE CASCADE,
      model TEXT,
      effort TEXT CHECK (effort IS NULL OR effort IN ('low','medium','high','xhigh','max')),
      mcp TEXT,
      agent_locked INTEGER NOT NULL DEFAULT 0 CHECK (agent_locked IN (0,1)),
      model_locked INTEGER NOT NULL DEFAULT 0 CHECK (model_locked IN (0,1)),
      effort_locked INTEGER NOT NULL DEFAULT 0 CHECK (effort_locked IN (0,1))
    )
  `);
}

const existingConfigColumns = tableColumns("api_topic_config");
if (existingConfigColumns.size === 0) {
  createCanonicalConfigTable();
} else if (
  existingConfigColumns.has("agent") ||
  existingConfigColumns.has("agent_pinned") ||
  existingConfigColumns.has("runtime_locked") ||
  existingConfigColumns.has("model_pinned") ||
  existingConfigColumns.has("effort_pinned") ||
  existingConfigColumns.has("last_shown_agent")
) {
  // Complete the old agent-override migration before dropping the column. The
  // selected agent itself belongs to api_topics; only its user lock belongs here.
  const topicColumns = tableColumns("api_topics");
  const agentColumn = topicColumns.has("agent")
    ? "agent"
    : topicColumns.has("runtime_agent")
      ? "runtime_agent"
      : null;
  if (agentColumn && existingConfigColumns.has("agent")) {
    db.exec(
      `UPDATE api_topics
       SET ${agentColumn} = (
         SELECT c.agent FROM api_topic_config c WHERE c.topic_id = api_topics.id
       )
       WHERE ${agentColumn} IS NULL
         AND EXISTS (
           SELECT 1 FROM api_topic_config c
           WHERE c.topic_id = api_topics.id AND c.agent IS NOT NULL
         )`,
    );
  }

  const previousForeignKeys = db
    .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get()?.foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    const agentLockSource = existingConfigColumns.has("runtime_locked")
      ? "runtime_locked"
      : existingConfigColumns.has("agent_pinned")
        ? "agent_pinned"
        : "0";
    const modelLockSource = existingConfigColumns.has("model_locked")
      ? "model_locked"
      : existingConfigColumns.has("model_pinned")
        ? "model_pinned"
        : "0";
    const effortLockSource = existingConfigColumns.has("effort_locked")
      ? "effort_locked"
      : existingConfigColumns.has("effort_pinned")
        ? "effort_pinned"
        : "0";
    db.transaction(() => {
      createCanonicalConfigTable("api_topic_config_next");
      db.exec(`
        INSERT INTO api_topic_config_next
          (topic_id, model, effort, mcp, agent_locked, model_locked, effort_locked)
        SELECT
          topic_id,
          model,
          effort,
          mcp,
          COALESCE(${agentLockSource}, 0),
          COALESCE(${modelLockSource}, 0),
          COALESCE(${effortLockSource}, 0)
        FROM api_topic_config
        WHERE EXISTS (SELECT 1 FROM api_topics t WHERE t.id = api_topic_config.topic_id)
      `);
      db.exec("DROP TABLE api_topic_config");
      db.exec("ALTER TABLE api_topic_config_next RENAME TO api_topic_config");
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
  }
} else {
  createCanonicalConfigTable();
}

export interface TopicConfig {
  model?: string;
  effort?: EffortLevel;
  mcp?: string[]; // enabled optional MCP server names
  // Per-field user locks: when true, AI self-config cannot override the field.
  agentLocked?: boolean;
  modelLocked?: boolean;
  effortLocked?: boolean;
}

interface ConfigRow {
  topic_id: string;
  model: string | null;
  effort: string | null;
  mcp: string | null;
  agent_locked: number;
  model_locked: number;
  effort_locked: number;
}

function rowToConfig(r: ConfigRow): TopicConfig {
  const cfg: TopicConfig = {};
  if (r.model) cfg.model = r.model;
  if (r.effort) cfg.effort = r.effort as EffortLevel;
  if (r.mcp) {
    try {
      const parsed = JSON.parse(r.mcp);
      if (Array.isArray(parsed)) cfg.mcp = parsed as string[];
    } catch {
      // corrupt JSON — treat as no mcp override
    }
  }
  if (r.agent_locked) cfg.agentLocked = true;
  if (r.model_locked) cfg.modelLocked = true;
  if (r.effort_locked) cfg.effortLocked = true;
  return cfg;
}

/**
 * Per-topic override set via `PATCH /config` (and, going forward, the MCP
 * self-config tools). Returns `undefined` when the topic has no stored row,
 * so callers can distinguish "no override" from "override with empty fields".
 */
export function getApiTopicConfig(topicId: string): TopicConfig | undefined {
  const row = db
    .query(
      "SELECT topic_id, model, effort, mcp, agent_locked, model_locked, effort_locked FROM api_topic_config WHERE topic_id = ?",
    )
    .get(topicId) as ConfigRow | null;
  if (!row) return undefined;
  const config = rowToConfig(row);
  return Object.keys(config).length > 0 ? config : undefined;
}

/**
 * Upsert the full override for a topic. Fields set to `undefined` are cleared
 * (stored as SQL NULL), matching the previous Map semantics where the route
 * built a complete `updated` object before persisting.
 */
export function setApiTopicConfig(topicId: string, config: TopicConfig): void {
  db.query(
    `INSERT INTO api_topic_config
       (topic_id, model, effort, mcp, agent_locked, model_locked, effort_locked)
       VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(topic_id) DO UPDATE SET
       model = excluded.model,
       effort = excluded.effort,
       mcp = excluded.mcp,
       agent_locked = excluded.agent_locked,
       model_locked = excluded.model_locked,
       effort_locked = excluded.effort_locked`,
  ).run(
    topicId,
    config.model ?? null,
    config.effort ?? null,
    config.mcp ? JSON.stringify(config.mcp) : null,
    config.agentLocked ? 1 : 0,
    config.modelLocked ? 1 : 0,
    config.effortLocked ? 1 : 0,
  );
}

/** Remove a topic's override row entirely (e.g. on topic hard-delete). */
export function deleteApiTopicConfig(topicId: string): void {
  db.query("DELETE FROM api_topic_config WHERE topic_id = ?").run(topicId);
}
