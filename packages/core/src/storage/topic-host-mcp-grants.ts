/** Credential-bearing manager MCP grants, isolated from ordinary tool flags. */

import type { HostMcpServerSpec } from "#runtime-gateway";
import { parseHostMcpServers } from "#runtime-gateway";
import { db } from "#storage/forum-db";

db.exec(`
  CREATE TABLE IF NOT EXISTS api_topic_host_mcp_grants (
    topic_id     TEXT PRIMARY KEY,
    servers_json TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )
`);

interface HostMcpGrantRow {
  servers_json: string;
}

export function getTopicHostMcpGrant(topicId: string): Record<string, HostMcpServerSpec> | null {
  const row = db
    .query<HostMcpGrantRow, [string]>(
      "SELECT servers_json FROM api_topic_host_mcp_grants WHERE topic_id = ?",
    )
    .get(topicId);
  if (!row) return null;
  try {
    return parseHostMcpServers(JSON.parse(row.servers_json)) ?? null;
  } catch {
    // Fail closed if durable state was corrupted or written by an incompatible build.
    return null;
  }
}

export function recordTopicHostMcpGrant(
  topicId: string,
  servers: Record<string, HostMcpServerSpec>,
): void {
  const validated = parseHostMcpServers(servers) ?? {};
  if (Object.keys(validated).length === 0) {
    deleteTopicHostMcpGrant(topicId);
    return;
  }
  db.query(
    `INSERT INTO api_topic_host_mcp_grants (topic_id, servers_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(topic_id) DO UPDATE SET
       servers_json = excluded.servers_json,
       updated_at = excluded.updated_at`,
  ).run(topicId, JSON.stringify(validated), new Date().toISOString());
}

export function deleteTopicHostMcpGrant(topicId: string): void {
  db.query("DELETE FROM api_topic_host_mcp_grants WHERE topic_id = ?").run(topicId);
}
