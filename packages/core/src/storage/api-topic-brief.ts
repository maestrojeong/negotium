// Persistent per-topic wiki brief store, backed by shared SQLite.
// Topic briefs are keyed by topicId and shared across participants.
//
// Briefs are injected into AI-invited topic turns at session start. The
// wiki-archiver updates them post-session.
import { db } from "#storage/forum-db";

db.exec(`
  CREATE TABLE IF NOT EXISTS api_topic_brief (
    topic_id TEXT PRIMARY KEY,
    brief_md TEXT NOT NULL DEFAULT '',
    latest_summary_md TEXT,
    summary_date TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export interface TopicBrief {
  topicId: string;
  /** Lightweight topic brief (300-600 tokens, injected at session start). */
  briefMd: string;
  /** Latest session summary markdown (full source-summary). */
  latestSummaryMd?: string;
  /** Date of the latest summary (YYYY-MM-DD). */
  summaryDate?: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
}

interface BriefRow {
  topic_id: string;
  brief_md: string;
  latest_summary_md: string | null;
  summary_date: string | null;
  updated_at: string;
}

function rowToBrief(r: BriefRow): TopicBrief {
  return {
    topicId: r.topic_id,
    briefMd: r.brief_md,
    latestSummaryMd: r.latest_summary_md ?? undefined,
    summaryDate: r.summary_date ?? undefined,
    updatedAt: r.updated_at,
  };
}

/**
 * Get the topic brief for a given topicId. Returns null when no brief
 * has been written yet (fresh topic, no archiver run).
 */
export function getTopicBrief(topicId: string): TopicBrief | null {
  const row = db
    .query(
      "SELECT topic_id, brief_md, latest_summary_md, summary_date, updated_at FROM api_topic_brief WHERE topic_id = ?",
    )
    .get(topicId) as BriefRow | null;
  if (!row) return null;
  return rowToBrief(row);
}

/** Resolve current id-keyed briefs while retaining legacy title-keyed wiki memory. */
export function resolveTopicBrief(
  topicId: string,
  legacyTitle: string,
): { brief: TopicBrief; storageKey: string } | null {
  const current = getTopicBrief(topicId);
  if (current) return { brief: current, storageKey: topicId };
  const legacy = getTopicBrief(legacyTitle);
  return legacy ? { brief: legacy, storageKey: legacyTitle } : null;
}

/**
 * Upsert the topic brief. `briefMd` and `latestSummaryMd` are
 * independently optional — callers can update just one field without
 * wiping the other. `summaryDate` should be the date of the summary
 * (YYYY-MM-DD), set alongside `latestSummaryMd`.
 */
export function setTopicBrief(
  topicId: string,
  fields: {
    briefMd?: string;
    latestSummaryMd?: string;
    summaryDate?: string;
  },
): TopicBrief {
  const existing = getTopicBrief(topicId);

  const briefMd = fields.briefMd !== undefined ? fields.briefMd : (existing?.briefMd ?? "");
  const latestSummaryMd =
    fields.latestSummaryMd !== undefined
      ? fields.latestSummaryMd
      : (existing?.latestSummaryMd ?? null);
  const summaryDate =
    fields.summaryDate !== undefined ? fields.summaryDate : (existing?.summaryDate ?? null);

  db.query(
    `INSERT INTO api_topic_brief
       (topic_id, brief_md, latest_summary_md, summary_date, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(topic_id) DO UPDATE SET
       brief_md = excluded.brief_md,
       latest_summary_md = excluded.latest_summary_md,
       summary_date = excluded.summary_date,
       updated_at = excluded.updated_at`,
  ).run(topicId, briefMd, latestSummaryMd, summaryDate);

  return getTopicBrief(topicId)!;
}

/** Remove a topic's brief row entirely (e.g. on topic hard-delete). */
export function deleteTopicBrief(topicId: string): void {
  db.query("DELETE FROM api_topic_brief WHERE topic_id = ?").run(topicId);
}

/**
 * List all topic briefs for browsing (wiki UI). Returns briefMd
 * only (no full summary body) to keep the payload light.
 */
export function listTopicBriefs(): TopicBrief[] {
  const rows = db
    .query(
      "SELECT topic_id, brief_md, latest_summary_md, summary_date, updated_at FROM api_topic_brief ORDER BY updated_at DESC",
    )
    .all() as BriefRow[];
  return rows.map(rowToBrief);
}
