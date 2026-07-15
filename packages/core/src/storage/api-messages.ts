// Persistent message store for the REST/WS API channel (Otium).
//
// Replaces the previous in-memory `Map<topicId, MessageDto[]>` so messages
// survive server restarts. Backed by the shared sessions SQLite DB — the same
// database the Telegram channel uses — which is the foundation for unifying
// conversation state across channels later.
//
// Ordering is by the implicit SQLite `rowid` (monotonic insert order). Cursor
// pagination resolves the cursor id → its rowid and returns rows after it.

import { db } from "#storage/forum-db";
import type { AgentKind } from "#types";
import type { MessageDto } from "#types/api";

db.exec(`
  CREATE TABLE IF NOT EXISTS api_messages (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    parent_id TEXT,
    author_id TEXT NOT NULL,
    text TEXT NOT NULL,
    query_id TEXT,
    agent_type TEXT,
    model TEXT,
    attachments TEXT,
    usage TEXT,
    deleted INTEGER NOT NULL DEFAULT 0,
    edited_at TEXT,
    reactions TEXT,
    kind TEXT,
    ask_user_question TEXT,
    mentions TEXT,
    thread_root_id TEXT,
    created_at TEXT NOT NULL
  )
`);
try {
  db.exec("ALTER TABLE api_messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
} catch {
  // Column already exists.
}
try {
  db.exec("ALTER TABLE api_messages ADD COLUMN edited_at TEXT");
} catch {
  // Column already exists.
}
try {
  db.exec("ALTER TABLE api_messages ADD COLUMN reactions TEXT");
} catch {
  // Column already exists.
}
try {
  db.exec("ALTER TABLE api_messages ADD COLUMN kind TEXT");
} catch {
  // Column already exists.
}
try {
  db.exec("ALTER TABLE api_messages ADD COLUMN ask_user_question TEXT");
} catch {
  // Column already exists.
}
try {
  db.exec("ALTER TABLE api_messages ADD COLUMN mentions TEXT");
} catch {
  // Column already exists.
}
try {
  // Slack-style threads: a reply carries the ROOT message id (flat, no nesting).
  // Distinct from parent_id (which is a Telegram-style inline quote-reply).
  db.exec("ALTER TABLE api_messages ADD COLUMN thread_root_id TEXT");
} catch {
  // Column already exists.
}
try {
  db.exec("ALTER TABLE api_messages ADD COLUMN subagent_card TEXT");
} catch {
  // Column already exists.
}
// Index on topic_id; SQLite appends the implicit rowid to every index entry,
// so `WHERE topic_id=? AND rowid>? ORDER BY rowid` stays index-driven.
db.exec("CREATE INDEX IF NOT EXISTS idx_api_messages_topic ON api_messages(topic_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_api_messages_thread_root ON api_messages(thread_root_id)");

export interface ApiMessageRow {
  id: string;
  topic_id: string;
  parent_id: string | null;
  author_id: string;
  text: string;
  query_id: string | null;
  agent_type: string | null;
  model: string | null;
  attachments: string | null;
  usage: string | null;
  deleted: number;
  edited_at: string | null;
  reactions: string | null;
  kind: string | null;
  ask_user_question: string | null;
  subagent_card: string | null;
  mentions: string | null;
  thread_root_id: string | null;
  created_at: string;
  rowid?: number;
}

type ApiMessageAppendHook = (msg: MessageDto) => void | Promise<void>;
const appendHooks = new Set<ApiMessageAppendHook>();

export interface AppendApiMessageOptions {
  notify?: boolean;
  updateTopicLastMessageAt?: boolean;
}

export function registerApiMessageAppendHook(hook: ApiMessageAppendHook): () => void {
  appendHooks.add(hook);
  return () => {
    appendHooks.delete(hook);
  };
}

function emitApiMessageAppended(msg: MessageDto): void {
  for (const hook of appendHooks) {
    queueMicrotask(() => {
      try {
        void Promise.resolve(hook(msg)).catch(() => undefined);
      } catch {
        // Hooks are post-persist side effects; never make message writes fail.
      }
    });
  }
}

function rowToDto(r: ApiMessageRow): MessageDto {
  return {
    id: r.id,
    topicId: r.topic_id,
    parentId: r.parent_id ?? undefined,
    authorId: r.author_id,
    text: r.text,
    queryId: r.query_id ?? undefined,
    agentType: (r.agent_type as AgentKind | null) ?? undefined,
    model: r.model ?? undefined,
    attachments: r.attachments ? JSON.parse(r.attachments) : undefined,
    usage: r.usage ? JSON.parse(r.usage) : undefined,
    deleted: r.deleted !== 0,
    editedAt: r.edited_at ?? undefined,
    reactions: r.reactions ? JSON.parse(r.reactions) : undefined,
    kind: (r.kind as MessageDto["kind"] | null) ?? undefined,
    askUserQuestion: r.ask_user_question ? JSON.parse(r.ask_user_question) : undefined,
    subagentCard: r.subagent_card ? JSON.parse(r.subagent_card) : undefined,
    mentions: r.mentions ? JSON.parse(r.mentions) : undefined,
    threadRootId: r.thread_root_id ?? undefined,
    createdAt: r.created_at,
  };
}

function attachmentListHasFileId(raw: string | null, fileId: string): boolean {
  if (!raw) return false;
  try {
    const attachments = JSON.parse(raw) as unknown;
    return (
      Array.isArray(attachments) &&
      attachments.some(
        (attachment) =>
          typeof attachment === "object" &&
          attachment !== null &&
          "id" in attachment &&
          attachment.id === fileId,
      )
    );
  } catch {
    return false;
  }
}

/** Persist a single message. Idempotent on id: duplicate appends do not rewrite edited/reaction state. */
export function appendApiMessage(msg: MessageDto, options: AppendApiMessageOptions = {}): void {
  const notify = options.notify ?? true;
  const updateTopicLastMessageAt = options.updateTopicLastMessageAt ?? true;
  let inserted = false;
  db.transaction(() => {
    const result = db
      .query(
        `INSERT INTO api_messages
         (id, topic_id, parent_id, author_id, text, query_id, agent_type, model, attachments, usage, deleted, edited_at, reactions, kind, ask_user_question, subagent_card, mentions, thread_root_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        msg.id,
        msg.topicId,
        msg.parentId ?? null,
        msg.authorId,
        msg.text,
        msg.queryId ?? null,
        msg.agentType ?? null,
        msg.model ?? null,
        msg.attachments ? JSON.stringify(msg.attachments) : null,
        msg.usage ? JSON.stringify(msg.usage) : null,
        msg.deleted ? 1 : 0,
        msg.editedAt ?? null,
        msg.reactions?.length ? JSON.stringify(msg.reactions) : null,
        msg.kind ?? null,
        msg.askUserQuestion ? JSON.stringify(msg.askUserQuestion) : null,
        msg.subagentCard ? JSON.stringify(msg.subagentCard) : null,
        msg.mentions?.length ? JSON.stringify(msg.mentions) : null,
        msg.threadRootId ?? null,
        msg.createdAt,
      );
    inserted = Number(result.changes ?? 0) > 0;
    if (inserted && updateTopicLastMessageAt && !msg.deleted) {
      db.query(
        `UPDATE api_topics
         SET last_message_at = CASE
           WHEN last_message_at IS NULL OR last_message_at < ? THEN ?
           ELSE last_message_at
         END
         WHERE id = ?`,
      ).run(msg.createdAt, msg.createdAt, msg.topicId);
    }
  })();
  if (inserted && notify && !msg.deleted) emitApiMessageAppended(msg);
}

export function getApiMessage(topicId: string, messageId: string): MessageDto | null {
  const row = db
    .query("SELECT * FROM api_messages WHERE topic_id = ? AND id = ?")
    .get(topicId, messageId) as ApiMessageRow | undefined;
  return row ? rowToDto(row) : null;
}

export function topicHasAttachmentFileId(topicId: string, fileId: string): boolean {
  const rows = db
    .query<{ attachments: string | null }, [string]>(
      "SELECT attachments FROM api_messages WHERE topic_id = ? AND deleted = 0 AND attachments IS NOT NULL",
    )
    .all(topicId);
  return rows.some((row) => attachmentListHasFileId(row.attachments, fileId));
}

export function updateApiMessageText(
  topicId: string,
  messageId: string,
  text: string,
  editedAt = new Date().toISOString(),
): MessageDto | null {
  const res = db
    .query(
      `UPDATE api_messages
       SET text = ?, edited_at = ?
       WHERE topic_id = ? AND id = ? AND deleted = 0`,
    )
    .run(text, editedAt, topicId, messageId);
  if (Number(res.changes ?? 0) === 0) return null;
  return getApiMessage(topicId, messageId);
}

/** Attach terminal turn usage to an already-persisted assistant segment. */
export function updateApiMessageUsage(
  topicId: string,
  messageId: string,
  usage: NonNullable<MessageDto["usage"]>,
): MessageDto | null {
  const res = db
    .query(
      `UPDATE api_messages
       SET usage = ?
       WHERE topic_id = ? AND id = ? AND deleted = 0`,
    )
    .run(JSON.stringify(usage), topicId, messageId);
  if (Number(res.changes ?? 0) === 0) return null;
  return getApiMessage(topicId, messageId);
}

export function updateApiMessageAskUserQuestion(
  topicId: string,
  messageId: string,
  askUserQuestion: NonNullable<MessageDto["askUserQuestion"]>,
  editedAt = new Date().toISOString(),
): MessageDto | null {
  const res = db
    .query(
      `UPDATE api_messages
       SET ask_user_question = ?, edited_at = ?
       WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'ask_user_question'`,
    )
    .run(JSON.stringify(askUserQuestion), editedAt, topicId, messageId);
  if (Number(res.changes ?? 0) === 0) return null;
  return getApiMessage(topicId, messageId);
}

export function updateApiMessageSubagentCard(
  topicId: string,
  messageId: string,
  subagentCard: NonNullable<MessageDto["subagentCard"]>,
  editedAt = new Date().toISOString(),
): MessageDto | null {
  const res = db
    .query(
      `UPDATE api_messages
       SET subagent_card = ?, edited_at = ?
       WHERE topic_id = ? AND id = ? AND deleted = 0 AND kind = 'subagent'`,
    )
    .run(JSON.stringify(subagentCard), editedAt, topicId, messageId);
  if (Number(res.changes ?? 0) === 0) return null;
  return getApiMessage(topicId, messageId);
}

/** All non-deleted messages of one kind, across topics (boot-time sweeps). */
export function listApiMessagesByKind(kind: NonNullable<MessageDto["kind"]>): MessageDto[] {
  const rows = db
    .query("SELECT * FROM api_messages WHERE kind = ? AND deleted = 0")
    .all(kind) as ApiMessageRow[];
  return rows.map(rowToDto);
}

/** Replace a message's full reactions array. Toggle logic lives in the route. */
export function setApiMessageReactions(
  topicId: string,
  messageId: string,
  reactions: NonNullable<MessageDto["reactions"]>,
): MessageDto | null {
  const res = db
    .query(
      `UPDATE api_messages
       SET reactions = ?
       WHERE topic_id = ? AND id = ? AND deleted = 0`,
    )
    .run(reactions.length ? JSON.stringify(reactions) : null, topicId, messageId);
  if (Number(res.changes ?? 0) === 0) return null;
  return getApiMessage(topicId, messageId);
}

export function softDeleteApiMessage(topicId: string, messageId: string): MessageDto | null {
  const res = db
    .query(
      `UPDATE api_messages
       SET deleted = 1, text = ''
       WHERE topic_id = ? AND id = ? AND deleted = 0`,
    )
    .run(topicId, messageId);
  if (Number(res.changes ?? 0) === 0) return null;
  return getApiMessage(topicId, messageId);
}

export interface MessagePage {
  page: MessageDto[];
  cursor?: string;
  hasMore: boolean;
}

/**
 * List messages for a topic, NEWEST-FIRST by default (bug G).
 *
 * The chat client loads once on mount and renders whatever it gets, so the
 * initial page must be the *latest* N messages, not the oldest. We therefore
 * query newest→oldest (`ORDER BY rowid DESC`) and then reverse the page back to
 * chronological (oldest→newest) order for display.
 *
 * Pagination is BACKWARD (toward older history): pass the returned `cursor`
 * (the oldest id currently loaded) to fetch the page of messages *older* than
 * it. `hasMore` therefore means "there are older messages above this page".
 */
export function listApiMessages(
  topicId: string,
  options?: { cursor?: string | null; limit?: number },
): MessagePage {
  const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));

  let anchorRowid: number | null = null;
  if (options?.cursor) {
    const cur = db
      .query("SELECT rowid AS rowid FROM api_messages WHERE topic_id = ? AND id = ?")
      .get(topicId, options.cursor) as { rowid: number } | undefined;
    if (cur) anchorRowid = cur.rowid;
  }

  const rows = (
    anchorRowid !== null
      ? db
          .query(
            `SELECT *, rowid AS rowid FROM api_messages
             WHERE topic_id = ? AND deleted = 0 AND thread_root_id IS NULL AND rowid < ?
             ORDER BY rowid DESC
             LIMIT ?`,
          )
          .all(topicId, anchorRowid, limit + 1)
      : db
          .query(
            `SELECT *, rowid AS rowid FROM api_messages
             WHERE topic_id = ? AND deleted = 0 AND thread_root_id IS NULL
             ORDER BY rowid DESC
             LIMIT ?`,
          )
          .all(topicId, limit + 1)
  ) as (ApiMessageRow & { rowid: number })[];

  const hasMore = rows.length > limit;
  // rows are newest→oldest; trim the look-ahead row, then flip to chronological.
  const pageRows = (hasMore ? rows.slice(0, limit) : rows).reverse();
  const page = pageRows.map(rowToDto);

  // Stamp thread reply counts onto the messages that are thread roots.
  const summaries = getThreadSummaries(page.map((m) => m.id));
  if (summaries.size > 0) {
    for (const m of page) {
      const s = summaries.get(m.id);
      if (s) {
        m.threadReplyCount = s.replyCount;
        m.threadLastReplyAt = s.lastReplyAt;
      }
    }
  }

  return {
    page,
    // Oldest loaded id — pass back as `cursor` to load the previous (older) page.
    cursor: page.length > 0 ? page[0].id : undefined,
    hasMore,
  };
}

/**
 * Reply count + last reply time per thread root, computed on read (no
 * denormalized counters to drift). Only non-deleted replies are counted.
 */
export function getThreadSummaries(
  rootIds: readonly string[],
): Map<string, { replyCount: number; lastReplyAt: string }> {
  const out = new Map<string, { replyCount: number; lastReplyAt: string }>();
  const ids = [...new Set(rootIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const rows = db
    .query(
      `SELECT thread_root_id AS rootId, COUNT(*) AS replyCount, MAX(created_at) AS lastReplyAt
       FROM api_messages
       WHERE thread_root_id IN (${ids.map(() => "?").join(",")}) AND deleted = 0
       GROUP BY thread_root_id`,
    )
    .all(...ids) as { rootId: string; replyCount: number; lastReplyAt: string }[];
  for (const r of rows) {
    out.set(r.rootId, { replyCount: Number(r.replyCount), lastReplyAt: r.lastReplyAt });
  }
  return out;
}

/** The root message plus its thread replies (chronological). */
export function listThreadMessages(
  topicId: string,
  rootId: string,
): { root: MessageDto | null; replies: MessageDto[] } {
  const root = getApiMessage(topicId, rootId);
  const rows = db
    .query(
      `SELECT *, rowid AS rowid FROM api_messages
       WHERE topic_id = ? AND thread_root_id = ? AND deleted = 0
       ORDER BY rowid ASC
       LIMIT 200`,
    )
    .all(topicId, rootId) as ApiMessageRow[];
  return { root, replies: rows.map(rowToDto) };
}

/**
 * Find the newest same-user/same-text message that is recent enough to be the
 * message just posted before a follow-up `/ai` call. This is a compatibility
 * fallback for clients that persist attachments through `/messages` but do not
 * repeat their file ids in the `/ai` request body.
 */
export function findRecentUserMessage(
  topicId: string,
  authorId: string,
  text: string,
  maxAgeMs: number,
): MessageDto | undefined {
  const row = db
    .query(
      `SELECT * FROM api_messages
       WHERE topic_id = ? AND author_id = ? AND text = ?
         AND deleted = 0
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(topicId, authorId, text) as ApiMessageRow | undefined;
  if (!row) return undefined;

  const createdMs = Date.parse(row.created_at);
  if (!Number.isFinite(createdMs) || Date.now() - createdMs > maxAgeMs) return undefined;
  return rowToDto(row);
}

/**
 * Latest message text per topic, keyed by topic_id. Used to render a preview
 * subtitle in the topic list. One index-driven query (MAX(rowid) per topic)
 * instead of N round-trips. Empty topics are simply absent from the map.
 */
export function getLastMessagePreviews(topicIds?: readonly string[]): Map<string, string> {
  const uniqueTopicIds = topicIds ? [...new Set(topicIds)] : undefined;
  if (uniqueTopicIds && uniqueTopicIds.length === 0) return new Map();
  const topicFilter = uniqueTopicIds
    ? `AND topic_id IN (${uniqueTopicIds.map(() => "?").join(",")})`
    : "";
  const rows = db
    .query(
      `SELECT m.topic_id AS topic_id, m.text AS text
       FROM api_messages m
       JOIN (
         SELECT topic_id, MAX(rowid) AS mx FROM api_messages
         WHERE deleted = 0 AND thread_root_id IS NULL
           ${topicFilter}
         GROUP BY topic_id
       ) last ON m.topic_id = last.topic_id AND m.rowid = last.mx`,
    )
    .all(...(uniqueTopicIds ?? [])) as { topic_id: string; text: string }[];

  const out = new Map<string, string>();
  for (const r of rows) {
    const preview = (r.text ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (preview) out.set(r.topic_id, preview);
  }
  return out;
}

/** Hard-delete every message in a topic (used when a topic is deleted). */
export function deleteMessagesForTopic(topicId: string): number {
  const res = db.query("DELETE FROM api_messages WHERE topic_id = ?").run(topicId);
  return Number(res.changes ?? 0);
}

/** Anonymize all messages authored by a deleted user. */
export function anonymizeApiMessages(userId: string): void {
  db.query("UPDATE api_messages SET author_id = 'deleted-user' WHERE author_id = ?").run(userId);
}

/** Topic ids whose persisted attachment JSON references this exact upload id.
 * Used only as a compatibility bridge for uploads created before ACL metadata
 * was introduced. JSON UUIDs are quoted, avoiding substring matches. */
export function listTopicIdsForAttachment(fileId: string): string[] {
  const needle = `%"${fileId.replace(/[\\%_]/g, (char) => `\\${char}`)}"%`;
  // The ESCAPE literal must reach SQLite as a SINGLE backslash. SQLite string
  // literals do no backslash processing, so '\\' there is two characters and
  // fails at row-evaluation time ("ESCAPE expression must be a single
  // character") — which only surfaces once api_messages has any rows.
  const rows = db
    .query<{ topic_id: string }, [string]>(
      "SELECT DISTINCT topic_id FROM api_messages WHERE attachments LIKE ? ESCAPE '\\'",
    )
    .all(needle);
  return rows.map((row) => row.topic_id);
}

/**
 * Copy all messages from one topic to another (used by fork).
 * Each message gets a new UUID but retains original content, author, and timestamps.
 * Returns the number of messages copied.
 */
export function copyMessagesForTopic(sourceTopicId: string, targetTopicId: string): number {
  const rows = db
    .query("SELECT * FROM api_messages WHERE topic_id = ? AND deleted = 0 ORDER BY rowid ASC")
    .all(sourceTopicId) as ApiMessageRow[];

  if (rows.length === 0) return 0;

  const idMap = new Map(rows.map((r) => [r.id, crypto.randomUUID()]));
  let copied = 0;
  for (const r of rows) {
    const newId = idMap.get(r.id);
    if (!newId) continue;
    appendApiMessage(
      {
        ...rowToDto(r),
        id: newId,
        topicId: targetTopicId,
        parentId: r.parent_id ? (idMap.get(r.parent_id) ?? r.parent_id) : undefined,
        threadRootId: r.thread_root_id
          ? (idMap.get(r.thread_root_id) ?? r.thread_root_id)
          : undefined,
      },
      { notify: false, updateTopicLastMessageAt: false },
    );
    copied++;
  }

  return copied;
}

/**
 * Get all messages for a topic in chronological order (used by export).
 */
export function getAllMessagesForTopic(topicId: string): ApiMessageRow[] {
  return db
    .query(
      "SELECT *, rowid AS rowid FROM api_messages WHERE topic_id = ? AND deleted = 0 ORDER BY rowid ASC",
    )
    .all(topicId) as ApiMessageRow[];
}

export function getMessagesForTopicAfterRowid(
  topicId: string,
  afterRowid: number,
): ApiMessageRow[] {
  return db
    .query(
      "SELECT *, rowid AS rowid FROM api_messages WHERE topic_id = ? AND rowid > ? AND deleted = 0 ORDER BY rowid ASC",
    )
    .all(topicId, afterRowid) as ApiMessageRow[];
}
