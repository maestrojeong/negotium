import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { Database } from "#storage/sqlite";

const SEARCH_INDEX_SCHEMA_VERSION = 3;

export type IndexedWikiKind = "article" | "summary";

export interface WikiSearchIndexSource {
  kind: IndexedWikiKind;
  key: string;
  path: string;
  mtimeMs: number;
  size: number;
}

export interface PreparedWikiSearchDocument {
  title: string;
  text: string;
  tokens: string[];
  date?: string;
  family?: string;
}

export interface WikiSearchIndexDocument extends PreparedWikiSearchDocument {
  id: string;
  kind: IndexedWikiKind;
  key: string;
  path: string;
}

export interface WikiSearchIndexMetadata {
  id: string;
  kind: IndexedWikiKind;
  key: string;
  title: string;
  date?: string;
  family?: string;
}

export interface WikiSummaryTemporalQuery {
  year?: string;
  month?: string;
  exactDate?: string;
  before?: string;
  after?: string;
  family?: string;
  direction: "latest" | "oldest";
  limit: number;
}

export interface WikiSearchIndexSyncResult {
  added: number;
  updated: number;
  removed: number;
}

interface StoredSourceRow {
  id: string;
  path: string;
  mtime_ms: number;
  size: number;
}

interface StoredDocumentRow {
  id: string;
  kind: IndexedWikiKind;
  key: string;
  path: string;
  title: string;
  text: string;
  date: string | null;
}

interface StoredMetadataRow {
  id: string;
  kind: IndexedWikiKind;
  key: string;
  title: string;
  date: string | null;
  family: string | null;
}

function documentId(source: Pick<WikiSearchIndexSource, "kind" | "key">): string {
  return `${source.kind}:${source.key}`;
}

function ensureSchema(database: InstanceType<typeof Database>): void {
  const version = database
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()?.user_version;
  if (version !== 0 && version !== SEARCH_INDEX_SCHEMA_VERSION) {
    throw new Error(`Unsupported wiki search index schema: ${version}`);
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS wiki_search_documents (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      path TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      date TEXT,
      family TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS wiki_search_documents_kind_key
      ON wiki_search_documents(kind, key);
    CREATE INDEX IF NOT EXISTS wiki_search_documents_kind_date
      ON wiki_search_documents(kind, date);
    CREATE INDEX IF NOT EXISTS wiki_search_documents_kind_family_date
      ON wiki_search_documents(kind, family, date);
    CREATE VIRTUAL TABLE IF NOT EXISTS wiki_search_fts USING fts5(
      document_id UNINDEXED,
      kind UNINDEXED,
      tokens,
      tokenize = 'unicode61'
    );
    PRAGMA user_version = ${SEARCH_INDEX_SCHEMA_VERSION};
  `);
}

export class WikiSearchIndex {
  readonly #database: InstanceType<typeof Database>;

  constructor(readonly path: string) {
    this.#database = new Database(path, { create: true });
    try {
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;");
      ensureSchema(this.#database);
      chmodSync(path, 0o600);
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  sync(
    sources: WikiSearchIndexSource[],
    prepare: (source: WikiSearchIndexSource, text: string) => PreparedWikiSearchDocument,
    options: { removeMissing?: boolean } = {},
  ): WikiSearchIndexSyncResult {
    const result: WikiSearchIndexSyncResult = { added: 0, updated: 0, removed: 0 };
    const existingRows = this.#database
      .query<StoredSourceRow, []>(
        "SELECT id, path, mtime_ms, size FROM wiki_search_documents ORDER BY id",
      )
      .all();
    const existing = new Map(existingRows.map((row) => [row.id, row]));
    const present = new Set<string>();
    const changed: Array<{
      source: WikiSearchIndexSource;
      document: PreparedWikiSearchDocument;
      added: boolean;
    }> = [];

    for (const source of sources) {
      const id = documentId(source);
      present.add(id);
      const stored = existing.get(id);
      if (
        stored &&
        stored.path === source.path &&
        stored.mtime_ms === source.mtimeMs &&
        stored.size === source.size
      ) {
        continue;
      }
      try {
        const text = readFileSync(source.path, "utf-8");
        changed.push({ source, document: prepare(source, text), added: !stored });
      } catch {
        // Keep the previous indexed copy, if any. A later sync can retry after
        // a concurrent writer finishes or permissions are restored.
      }
    }
    const removed =
      options.removeMissing === false ? [] : existingRows.filter((row) => !present.has(row.id));

    const apply = this.#database.transaction(() => {
      const deleteTerms = this.#database.query("DELETE FROM wiki_search_fts WHERE document_id = ?");
      const deleteDocument = this.#database.query("DELETE FROM wiki_search_documents WHERE id = ?");
      const insertDocument = this.#database.query(`
        INSERT INTO wiki_search_documents
          (id, kind, key, path, mtime_ms, size, title, text, date, family)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertTerms = this.#database.query(`
        INSERT INTO wiki_search_fts(document_id, kind, tokens)
        VALUES (?, ?, ?)
      `);

      for (const row of removed) {
        deleteTerms.run(row.id);
        deleteDocument.run(row.id);
        result.removed += 1;
      }
      for (const { source, document, added } of changed) {
        const id = documentId(source);
        deleteTerms.run(id);
        deleteDocument.run(id);
        insertDocument.run(
          id,
          source.kind,
          source.key,
          source.path,
          source.mtimeMs,
          source.size,
          document.title,
          document.text,
          document.date ?? null,
          document.family ?? null,
        );
        insertTerms.run(id, source.kind, document.tokens.join(" "));
        if (added) result.added += 1;
        else result.updated += 1;
      }
    });
    apply.immediate();
    return result;
  }

  metadata(kinds: IndexedWikiKind[]): WikiSearchIndexMetadata[] {
    if (kinds.length === 0) return [];
    const placeholders = kinds.map(() => "?").join(", ");
    const rows = this.#database
      .query<StoredMetadataRow, string[]>(
        `SELECT id, kind, key, title, date, family
         FROM wiki_search_documents
         WHERE kind IN (${placeholders})`,
      )
      .all(...kinds);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      title: row.title,
      ...(row.date ? { date: row.date } : {}),
      ...(row.family ? { family: row.family } : {}),
    }));
  }

  summaryMetadataByDate(query: WikiSummaryTemporalQuery): WikiSearchIndexMetadata[] {
    const conditions = ["kind = 'summary'", "date IS NOT NULL"];
    const parameters: Array<string | number> = [];
    if (query.exactDate) {
      conditions.push("date = ?");
      parameters.push(query.exactDate);
    } else if (query.before) {
      conditions.push("date < ?");
      parameters.push(query.before);
    } else if (query.after) {
      conditions.push("date > ?");
      parameters.push(query.after);
    } else if (query.year && query.month) {
      const month = Number(query.month);
      const nextYear = month === 12 ? String(Number(query.year) + 1) : query.year;
      const nextMonth = String(month === 12 ? 1 : month + 1).padStart(2, "0");
      conditions.push("date >= ?", "date < ?");
      parameters.push(`${query.year}-${query.month}-01`, `${nextYear}-${nextMonth}-01`);
    } else if (query.year) {
      conditions.push("date >= ?", "date < ?");
      parameters.push(`${query.year}-01-01`, `${Number(query.year) + 1}-01-01`);
    } else if (query.month) {
      conditions.push("substr(date, 6, 2) = ?");
      parameters.push(query.month);
    }
    if (query.family) {
      conditions.push("family = ?");
      parameters.push(query.family);
    }
    parameters.push(query.limit);
    const rows = this.#database
      .query<StoredMetadataRow, Array<string | number>>(
        `SELECT id, kind, key, title, date, family
         FROM wiki_search_documents
         WHERE ${conditions.join(" AND ")}
         ORDER BY date ${query.direction === "oldest" ? "ASC" : "DESC"}, key ASC
         LIMIT ?`,
      )
      .all(...parameters);
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      title: row.title,
      ...(row.date ? { date: row.date } : {}),
      ...(row.family ? { family: row.family } : {}),
    }));
  }

  matchingDocumentIds(kinds: IndexedWikiKind[], terms: string[]): Set<string> {
    if (kinds.length === 0 || terms.length === 0) return new Set();
    const kindPlaceholders = kinds.map(() => "?").join(", ");
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const rows = this.#database
      .query<{ document_id: string }, string[]>(
        `SELECT DISTINCT document_id
         FROM wiki_search_fts
         WHERE wiki_search_fts MATCH ? AND kind IN (${kindPlaceholders})`,
      )
      .all(match, ...kinds);
    return new Set(rows.map((row) => row.document_id));
  }

  documents(ids: Set<string>): WikiSearchIndexDocument[] {
    if (ids.size === 0) return [];
    const values = [...ids];
    const rows: StoredDocumentRow[] = [];
    for (let offset = 0; offset < values.length; offset += 500) {
      const chunk = values.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      rows.push(
        ...this.#database
          .query<StoredDocumentRow, string[]>(
            `SELECT id, kind, key, path, title, text, date
             FROM wiki_search_documents
             WHERE id IN (${placeholders})`,
          )
          .all(...chunk),
      );
    }
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      key: row.key,
      path: row.path,
      title: row.title,
      text: row.text,
      tokens: [],
      ...(row.date ? { date: row.date } : {}),
    }));
  }
}

export function resetCorruptWikiSearchIndex(path: string): void {
  for (const candidate of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(candidate)) continue;
    unlinkSync(candidate);
  }
}
