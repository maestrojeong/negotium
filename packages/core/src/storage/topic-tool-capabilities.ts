/**
 * The tool capabilities the adapter that owns a room last granted it.
 *
 * A capability is a property of the *surface* a room is rendered on, not of
 * the message that happened to trigger a turn: whether `show_html` output can
 * be displayed depends on whether Otium is drawing the panel, which is equally
 * true for a user's message, a `tell`, a cron job, and an auto-continue resume.
 *
 * But only a user turn arrives from the adapter, so only a user turn carries
 * the grant. `triggerTopicAiTurn` — session-comm tell/ask, config-change
 * auto-continue, cron, subagent reports — starts a turn with no adapter in
 * sight, and every one of those turns silently lost the tools. A scheduled job
 * that renders a chart is exactly the case that should work and did not.
 *
 * Recording the grant on the room fixes all of them at once, and is deliberately
 * *not* derived from `topic.surface`. Deriving would grant tools to any host
 * serving an `otium` room, including one too old to carry a node's rendered
 * visual back to its panel — reintroducing the callable-tool-with-no-output
 * failure during a rollout. A recorded grant only ever says what an adapter
 * actually asked for.
 */

import { db } from "#storage/forum-db";

db.exec(`
  CREATE TABLE IF NOT EXISTS api_topic_tool_capabilities (
    topic_id            TEXT PRIMARY KEY,
    visual_tools        INTEGER NOT NULL DEFAULT 0,
    file_delivery_tools INTEGER NOT NULL DEFAULT 0,
    updated_at          TEXT NOT NULL
  )
`);

export interface TopicToolCapabilities {
  visualTools: boolean;
  fileDeliveryTools: boolean;
}

interface CapabilityRow {
  visual_tools: number;
  file_delivery_tools: number;
}

/** What the owning adapter last granted, or null if it never has. */
export function getTopicToolCapabilities(topicId: string): TopicToolCapabilities | null {
  const row = db
    .query<CapabilityRow, [string]>(
      `SELECT visual_tools, file_delivery_tools
         FROM api_topic_tool_capabilities WHERE topic_id = ?`,
    )
    .get(topicId);
  if (!row) return null;
  return {
    visualTools: row.visual_tools === 1,
    fileDeliveryTools: row.file_delivery_tools === 1,
  };
}

/**
 * Record what the adapter granted for this room's user turn.
 *
 * Called on every user turn rather than once at room creation, so a host that
 * gains or loses a surface — an Otium version that starts copying node visuals,
 * or an adapter that stops rendering them — takes effect from its next turn
 * instead of being pinned to whatever was true when the room was made.
 */
export function recordTopicToolCapabilities(
  topicId: string,
  capabilities: TopicToolCapabilities,
): void {
  db.query(
    `INSERT INTO api_topic_tool_capabilities
       (topic_id, visual_tools, file_delivery_tools, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(topic_id) DO UPDATE SET
       visual_tools = excluded.visual_tools,
       file_delivery_tools = excluded.file_delivery_tools,
       updated_at = excluded.updated_at`,
  ).run(
    topicId,
    capabilities.visualTools ? 1 : 0,
    capabilities.fileDeliveryTools ? 1 : 0,
    new Date().toISOString(),
  );
}

export function deleteTopicToolCapabilities(topicId: string): void {
  db.query("DELETE FROM api_topic_tool_capabilities WHERE topic_id = ?").run(topicId);
}
