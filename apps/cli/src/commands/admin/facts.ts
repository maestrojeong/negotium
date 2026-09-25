/**
 * Facts about one topic, read identically from a private copy, from the
 * audit's node snapshot, or from the live DB inside the apply transaction, so
 * the three can be compared field by field (review findings 1, 2, 7).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refuse } from "./errors";
import {
  legacySessionInboxFiles,
  type NodePaths,
  pendingAskDir,
  sessionInboxFiles,
  topicWorkspaceDir,
} from "./paths";

/** Structural subset shared by `bun:sqlite` Database and core's storage db. */
export interface SqlDb {
  query(sql: string): {
    get(...params: any[]): any;
    all(...params: any[]): any[];
    run(...params: any[]): any;
  };
  exec(sql: string): void;
}

export const GENERAL_TOPIC_ID = "general";
/** Same window as core's topic maintenance / claim-abort fence staleness. */
export const MAINTENANCE_STALE_MS = 30_000;

export function tableExists(db: SqlDb, name: string): boolean {
  return Boolean(
    db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
      ?.n,
  );
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function tableColumns(db: SqlDb, table: string): string[] {
  return (db.query(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

export function requireNodeSchema(db: SqlDb, label: string): void {
  for (const table of [
    "api_topics",
    "topic_members",
    "api_node_identity",
    "api_topic_tombstones",
  ]) {
    if (!tableExists(db, table)) {
      refuse(`${label} is not a PR7 Negotium node database: table ${table} is missing`);
    }
  }
}

export interface NodeIdentity {
  nodeId: string | null;
  dbEpoch: string | null;
}

export function readNodeIdentity(db: SqlDb): NodeIdentity {
  if (!tableExists(db, "api_node_identity")) return { nodeId: null, dbEpoch: null };
  const columns = tableColumns(db, "api_node_identity");
  const row = db
    .query(
      `SELECT node_id${columns.includes("epoch_id") ? ", epoch_id" : ", NULL AS epoch_id"}
       FROM api_node_identity WHERE singleton = 1`,
    )
    .get() as { node_id: string | null; epoch_id: string | null } | null;
  return { nodeId: row?.node_id ?? null, dbEpoch: row?.epoch_id ?? null };
}

export interface TopicRow {
  id: string;
  title: string;
  kind: string;
  surface: string | null;
  surfaceScope: string | null;
  visibility: string | null;
  createdAt: string;
  parentTopicId: string | null;
  isSubagent: boolean;
  sessionId: string | null;
}

/** Exact-id lookup: no prefix, case folding or trimming. */
export function getTopicRow(db: SqlDb, id: string): TopicRow | null {
  const columns = new Set(tableColumns(db, "api_topics"));
  const col = (name: string) => (columns.has(name) ? name : `NULL AS ${name}`);
  const row = db
    .query(
      `SELECT id, title, kind, ${col("surface")}, ${col("surface_scope")}, ${col("visibility")},
              created_at, ${col("parent_topic_id")}, ${col("is_subagent")}, ${col("session_id")}
       FROM api_topics WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | null;
  if (!row || row.id !== id) return null;
  return {
    id: row.id as string,
    title: row.title as string,
    kind: row.kind as string,
    surface: (row.surface as string | null) ?? null,
    surfaceScope: (row.surface_scope as string | null) ?? null,
    visibility: (row.visibility as string | null) ?? null,
    createdAt: row.created_at as string,
    parentTopicId: (row.parent_topic_id as string | null) ?? null,
    isSubagent: Number(row.is_subagent ?? 0) === 1,
    sessionId: (row.session_id as string | null) ?? null,
  };
}

export interface Member {
  userId: string;
  role: string;
}

export function membersOf(db: SqlDb, topicId: string): Member[] {
  return (
    db
      .query("SELECT user_id, role FROM topic_members WHERE topic_id = ? ORDER BY role, user_id")
      .all(topicId) as Array<{ user_id: string; role: string }>
  ).map((row) => ({ userId: row.user_id, role: row.role }));
}

export function ownersOf(db: SqlDb, topicId: string): string[] {
  return membersOf(db, topicId)
    .filter((member) => member.role === "owner")
    .map((member) => member.userId)
    .sort();
}

export function messageCount(db: SqlDb, topicId: string): number {
  if (!tableExists(db, "api_messages")) return 0;
  return Number(
    db.query("SELECT COUNT(*) AS n FROM api_messages WHERE topic_id = ?").get(topicId)?.n ?? 0,
  );
}

/**
 * Rows referencing a topic that `delete-manager` itself removes in its one
 * transaction (topic_members is also validated to be exactly one owner).
 */
export const DELETED_WITH_TOPIC = new Set([
  "topic_members.topic_id",
  "api_topic_config.topic_id",
  "runtime_topic_state.topic_id",
]);
/** Append-only history that legitimately outlives the topic; left untouched. */
export const HISTORY_REFERENCES = new Set([
  "runtime_events.topic_id",
  "api_topic_scope_moves.topic_id",
]);

/**
 * Every column whose name mentions "topic", in every table, counted for this
 * id — including tables added after this tool was written. `api_topics.id`
 * itself is skipped; `api_topics.parent_topic_id`/`memory_topic_id` count
 * children and memory links.
 */
export function topicReferences(db: SqlDb, topicId: string): Record<string, number> {
  const tables = (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  const refs: Record<string, number> = {};
  for (const table of tables) {
    for (const column of tableColumns(db, table)) {
      if (!/topic/i.test(column)) continue;
      const n = Number(
        db
          .query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} = ?`)
          .get(topicId)?.n ?? 0,
      );
      if (n > 0) refs[`${table}.${column}`] = n;
    }
  }
  return refs;
}

export function maintenanceActive(db: SqlDb, topicId: string, now = Date.now()): boolean {
  if (!tableExists(db, "runtime_topic_state")) return false;
  const columns = tableColumns(db, "runtime_topic_state");
  if (!columns.includes("maintenance") || !columns.includes("heartbeat_at")) return false;
  return Boolean(
    db
      .query(
        `SELECT 1 AS found FROM runtime_topic_state
         WHERE topic_id = ? AND maintenance = 1 AND heartbeat_at >= ?`,
      )
      .get(topicId, now - MAINTENANCE_STALE_MS),
  );
}

export interface TopicFacts {
  row: TopicRow;
  owners: string[];
  members: Member[];
  messages: number;
  references: Record<string, number>;
}

export function topicFacts(db: SqlDb, topicId: string): TopicFacts | null {
  const row = getTopicRow(db, topicId);
  if (!row) return null;
  return {
    row,
    owners: ownersOf(db, topicId),
    members: membersOf(db, topicId),
    messages: messageCount(db, topicId),
    references: topicReferences(db, topicId),
  };
}

/**
 * The comparable identity of a topic: two snapshots with equal fingerprints
 * hold the same row, owners, members, message count and references.
 */
export function fingerprint(facts: TopicFacts | null): string {
  if (!facts) return "absent";
  return JSON.stringify([
    facts.row,
    facts.owners,
    facts.members,
    facts.messages,
    Object.entries(facts.references).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ]);
}

// ── node-local files that reference a topic ───────────────────────────────

export interface TopicFileState {
  workspaceDir: string;
  workspaceExists: boolean;
  workspaceEntries: number;
  /** Paths/reasons that make a delete unsafe. */
  blockers: string[];
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

/**
 * Files the lifecycle would purge: workspace (incl. attachments), session
 * inbox (id- and legacy title-keyed), pending asks, uploads. `delete-manager`
 * requires all of them to be absent (an empty workspace directory is allowed
 * and removed after commit), so the delete itself touches no file.
 */
export function topicFileState(
  paths: NodePaths,
  topicId: string,
  title: string,
  owners: readonly string[],
): TopicFileState {
  const blockers: string[] = [];
  const workspaceDir = topicWorkspaceDir(paths, topicId);
  const workspaceExists = existsSync(workspaceDir);
  const workspaceEntries = workspaceExists ? listDir(workspaceDir).length : 0;
  if (workspaceEntries > 0) {
    blockers.push(
      `workspace ${workspaceDir} holds ${workspaceEntries} entr(y/ies) (files/attachments)`,
    );
  }
  for (const owner of owners) {
    for (const path of [
      ...sessionInboxFiles(paths, owner, topicId),
      ...legacySessionInboxFiles(paths, owner, title),
    ]) {
      if (existsSync(path)) blockers.push(`session inbox file ${path}`);
    }
    const askDir = pendingAskDir(paths, owner);
    for (const name of listDir(askDir)) {
      const path = join(askDir, name);
      let record: { from?: unknown; to?: unknown } | null = null;
      try {
        record = JSON.parse(readFileSync(path, "utf8")) as { from?: unknown; to?: unknown };
      } catch {
        blockers.push(`unreadable pending ask file ${path} (cannot prove it is unrelated)`);
        continue;
      }
      if ([record?.from, record?.to].some((value) => value === topicId || value === title)) {
        blockers.push(`pending ask file ${path} references this topic (by id or title)`);
      }
    }
  }
  for (const name of listDir(paths.uploadsDir)) {
    if (!name.endsWith(".meta.json")) continue;
    const path = join(paths.uploadsDir, name);
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as { topicId?: unknown };
      if (meta.topicId === topicId) blockers.push(`upload ${path} belongs to this topic`);
    } catch {
      blockers.push(`unreadable upload metadata ${path} (cannot prove it is unrelated)`);
    }
  }
  return { workspaceDir, workspaceExists, workspaceEntries, blockers };
}
