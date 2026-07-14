// Persistent topic store backed by shared SQLite.

import { GENERAL_TOPIC_ID } from "#platform/constants";
import { logger } from "#platform/logger";
import { db } from "#storage/forum-db";
import type { AgentKind, EffortLevel } from "#types";
import type { AiMode, ParticipantDto, TopicDto, TopicKind } from "#types/api";

const DEFAULT_AGENT_ROOM_AGENT: AgentKind = "maestro";

function tableColumns(table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Persist the single authoritative agent for an API topic. */
export function setApiTopicAgent(topicId: string, agent: AgentKind): void {
  db.query("UPDATE api_topics SET agent = ? WHERE id = ?").run(agent, topicId);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS api_topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'channel',
    description TEXT,
    agent TEXT,
    default_model TEXT,
    default_effort TEXT,
    participants TEXT,
    created_at TEXT NOT NULL,
    last_message_at TEXT,
    is_archived INTEGER NOT NULL DEFAULT 0,
    ai_mention INTEGER NOT NULL DEFAULT 0,
    ai_mode TEXT
  )
`);

const initialTopicColumns = tableColumns("api_topics");
const legacyTopicSchema = !initialTopicColumns.has("response_policy");
const needsCanonicalTopicRebuild = legacyTopicSchema || !initialTopicColumns.has("agent");
if (legacyTopicSchema) {
  // Rename the legacy column once; new databases are created with `agent`.
  try {
    db.exec("ALTER TABLE api_topics RENAME COLUMN default_agent TO agent");
  } catch {
    // Already migrated or freshly created.
  }

  // Migrate existing DBs that predate the ai_mention column (team-mode topics).
  try {
    db.exec("ALTER TABLE api_topics ADD COLUMN ai_mention INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists — nothing to do.
  }

  // Migrate for spawn/fork tracking (R1).
  try {
    db.exec("ALTER TABLE api_topics ADD COLUMN parent_topic_id TEXT");
  } catch {
    // Column already exists.
  }
  try {
    db.exec("ALTER TABLE api_topics ADD COLUMN is_fork INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists.
  }

  // Migrate for agent-spawned subagent worker rooms.
  try {
    db.exec("ALTER TABLE api_topics ADD COLUMN is_subagent INTEGER NOT NULL DEFAULT 0");
  } catch {
    // Column already exists.
  }

  // Migrate for session persistence.
  try {
    db.exec("ALTER TABLE api_topics ADD COLUMN session_id TEXT");
  } catch {
    // Column already exists.
  }

  try {
    db.exec("ALTER TABLE api_topics ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel'");
  } catch {
    // Column already exists.
  }

  try {
    db.exec("ALTER TABLE api_topics ADD COLUMN ai_mode TEXT");
  } catch {
    // Column already exists.
  }

  db.exec(`
  CREATE TABLE IF NOT EXISTS api_schema_migrations (
    key TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`);

  const ALWAYS_RESPOND_MIGRATION = "api_topics_ai_invited_default_always_respond_20260623";
  const alwaysRespondMigration = db
    .query("SELECT key FROM api_schema_migrations WHERE key = ?")
    .get(ALWAYS_RESPOND_MIGRATION);
  if (!alwaysRespondMigration) {
    db.transaction(() => {
      db.query("UPDATE api_topics SET ai_mention = 0 WHERE agent IS NOT NULL").run();
      db.query("INSERT INTO api_schema_migrations (key, applied_at) VALUES (?, ?)").run(
        ALWAYS_RESPOND_MIGRATION,
        new Date().toISOString(),
      );
    })();
  }

  const GENERAL_AGENT_KIND_MIGRATION = "api_topics_general_agent_kind_20260704";
  const generalAgentKindMigration = db
    .query("SELECT key FROM api_schema_migrations WHERE key = ?")
    .get(GENERAL_AGENT_KIND_MIGRATION);
  if (!generalAgentKindMigration) {
    db.transaction(() => {
      db.query("UPDATE api_topics SET kind = 'agent', ai_mention = 0 WHERE id = ?").run(
        GENERAL_TOPIC_ID,
      );
      db.query("INSERT INTO api_schema_migrations (key, applied_at) VALUES (?, ?)").run(
        GENERAL_AGENT_KIND_MIGRATION,
        new Date().toISOString(),
      );
    })();
  }

  const AI_MODE_MIGRATION = "api_topics_ai_mode_20260704";
  const aiModeMigration = db
    .query("SELECT key FROM api_schema_migrations WHERE key = ?")
    .get(AI_MODE_MIGRATION);
  if (!aiModeMigration) {
    db.transaction(() => {
      db.query(
        `UPDATE api_topics
       SET
         kind = CASE
           WHEN id = ? THEN 'agent'
           WHEN kind = 'channel' AND agent IS NOT NULL AND ai_mention = 0 THEN 'agent'
           ELSE kind
         END,
         ai_mode = CASE
           WHEN id = ? THEN 'always'
           WHEN agent IS NULL THEN 'off'
           WHEN kind = 'agent' THEN 'always'
           WHEN kind = 'channel' AND ai_mention != 0 THEN 'mention'
           WHEN kind = 'channel' AND ai_mention = 0 THEN 'always'
           WHEN ai_mention != 0 THEN 'mention'
           ELSE 'always'
         END`,
      ).run(GENERAL_TOPIC_ID, GENERAL_TOPIC_ID);
      db.query("INSERT INTO api_schema_migrations (key, applied_at) VALUES (?, ?)").run(
        AI_MODE_MIGRATION,
        new Date().toISOString(),
      );
    })();
  }

  const GENERAL_MANAGER_KIND_MIGRATION = "api_topics_general_manager_kind_20260704";
  const generalManagerKindMigration = db
    .query("SELECT key FROM api_schema_migrations WHERE key = ?")
    .get(GENERAL_MANAGER_KIND_MIGRATION);
  if (!generalManagerKindMigration) {
    db.transaction(() => {
      db.query(
        "UPDATE api_topics SET kind = 'manager', ai_mention = 0, ai_mode = 'always' WHERE id = ?",
      ).run(GENERAL_TOPIC_ID);
      db.query("INSERT INTO api_schema_migrations (key, applied_at) VALUES (?, ?)").run(
        GENERAL_MANAGER_KIND_MIGRATION,
        new Date().toISOString(),
      );
    })();
  }
}

function createCanonicalTopicsTable(name: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${name} (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('channel','agent','manager')),
      description TEXT,
      agent TEXT CHECK (agent IS NULL OR agent IN ('maestro','claude','codex')),
      base_model TEXT,
      base_effort TEXT CHECK (base_effort IS NULL OR base_effort IN ('low','medium','high','xhigh','max')),
      response_policy TEXT NOT NULL CHECK (response_policy IN ('off','mention','always')),
      created_at TEXT NOT NULL,
      last_message_at TEXT,
      parent_topic_id TEXT,
      is_fork INTEGER NOT NULL DEFAULT 0 CHECK (is_fork IN (0,1)),
      is_subagent INTEGER NOT NULL DEFAULT 0 CHECK (is_subagent IN (0,1)),
      session_id TEXT,
      CHECK (
        (kind = 'channel' AND response_policy = 'off' AND agent IS NULL) OR
        (kind = 'channel' AND response_policy = 'mention' AND agent IS NOT NULL) OR
        (kind IN ('agent','manager') AND response_policy = 'always' AND agent IS NOT NULL)
      )
    )
  `);
}

function createTopicMembersTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_members (
      topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','member')),
      PRIMARY KEY (topic_id, user_id)
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_topic_members_user ON topic_members(user_id)");
}

if (needsCanonicalTopicRebuild) {
  const legacyRows = db.query("SELECT * FROM api_topics").all() as Array<Record<string, unknown>>;
  const existingMemberRows = tableColumns("topic_members").has("topic_id")
    ? (db.query("SELECT topic_id, user_id, role FROM topic_members").all() as Array<{
        topic_id: string;
        user_id: string;
        role: string;
      }>)
    : [];
  const configColumns = tableColumns("api_topic_config");
  const legacyAgentOverrides = configColumns.has("agent")
    ? new Map(
        (
          db
            .query("SELECT topic_id, agent FROM api_topic_config WHERE agent IS NOT NULL")
            .all() as Array<{ topic_id: string; agent: AgentKind }>
        ).map((row) => [row.topic_id, row.agent]),
      )
    : new Map<string, AgentKind>();
  const previousForeignKeys = db
    .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get()?.foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      createCanonicalTopicsTable("api_topics_next");
      for (const row of legacyRows) {
        const selectedAgent = (legacyAgentOverrides.get(String(row.id)) ??
          row.agent ??
          row.runtime_agent ??
          row.default_agent ??
          undefined) as AgentKind | undefined;
        const normalized = normalizeTopicState({
          id: String(row.id),
          kind: normalizeTopicKind(row.kind),
          agent: selectedAgent,
          aiMode: normalizeAiMode(row.response_policy ?? row.ai_mode),
          aiMention: Number(row.ai_mention ?? 0) !== 0,
        });
        const legacyBaseModel = row.base_model ?? row.default_model;
        const legacyBaseEffort = row.base_effort ?? row.default_effort;
        db.query(
          `INSERT INTO api_topics_next
             (id,title,kind,description,agent,base_model,base_effort,response_policy,
              created_at,last_message_at,parent_topic_id,is_fork,is_subagent,session_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          String(row.id),
          String(row.title),
          normalized.kind,
          typeof row.description === "string" ? row.description : null,
          normalized.agent ?? null,
          typeof legacyBaseModel === "string" ? legacyBaseModel : null,
          typeof legacyBaseEffort === "string" ? legacyBaseEffort : null,
          normalized.aiMode,
          String(row.created_at),
          typeof row.last_message_at === "string" ? row.last_message_at : null,
          typeof row.parent_topic_id === "string" ? row.parent_topic_id : null,
          Number(row.is_fork ?? 0) !== 0 ? 1 : 0,
          Number(row.is_subagent ?? 0) !== 0 ? 1 : 0,
          typeof row.session_id === "string" ? row.session_id : null,
        );
      }
      db.exec("DROP TABLE IF EXISTS topic_members");
      db.exec("DROP TABLE api_topics");
      db.exec("ALTER TABLE api_topics_next RENAME TO api_topics");
      createTopicMembersTable();
      if (existingMemberRows.length > 0) {
        for (const member of existingMemberRows) {
          db.query(
            "INSERT OR REPLACE INTO topic_members (topic_id,user_id,role) VALUES (?,?,?)",
          ).run(member.topic_id, member.user_id, member.role === "owner" ? "owner" : "member");
        }
      } else {
        for (const row of legacyRows) {
          let participants: ParticipantDto[] = [];
          try {
            const parsed = JSON.parse(String(row.participants ?? "[]"));
            if (Array.isArray(parsed)) participants = parsed as ParticipantDto[];
          } catch {
            participants = [];
          }
          for (const participant of participants) {
            if (!participant?.userId) continue;
            db.query(
              "INSERT OR REPLACE INTO topic_members (topic_id,user_id,role) VALUES (?,?,?)",
            ).run(
              String(row.id),
              participant.userId,
              participant.role === "owner" ? "owner" : "member",
            );
          }
        }
      }
    })();
  } finally {
    db.exec(`PRAGMA foreign_keys = ${previousForeignKeys ? "ON" : "OFF"}`);
  }
} else {
  createCanonicalTopicsTable("api_topics");
  createTopicMembersTable();
}

interface TopicRow {
  id: string;
  title: string;
  kind: string | null;
  description: string | null;
  agent: string | null;
  base_model: string | null;
  base_effort: string | null;
  response_policy: string;
  created_at: string;
  last_message_at: string | null;
  parent_topic_id: string | null;
  is_fork: number;
  is_subagent: number;
  session_id: string | null;
}

interface TopicSessionLogContext {
  reason?: string;
  queryId?: string;
  agent?: AgentKind;
}

function shortSessionId(sessionId: string | null | undefined): string | null {
  return sessionId ? sessionId.slice(0, 8) : null;
}

function getTopicParticipants(topicId: string): ParticipantDto[] {
  return db
    .query<{ user_id: string; role: "owner" | "member" }, string>(
      "SELECT user_id, role FROM topic_members WHERE topic_id = ? ORDER BY rowid",
    )
    .all(topicId)
    .map((row) => ({ userId: row.user_id, role: row.role }));
}

function getAllTopicParticipants(): Map<string, ParticipantDto[]> {
  const grouped = new Map<string, ParticipantDto[]>();
  const rows = db
    .query<{ topic_id: string; user_id: string; role: "owner" | "member" }, []>(
      "SELECT topic_id, user_id, role FROM topic_members ORDER BY rowid",
    )
    .all();
  for (const row of rows) {
    const participants = grouped.get(row.topic_id) ?? [];
    participants.push({ userId: row.user_id, role: row.role });
    grouped.set(row.topic_id, participants);
  }
  return grouped;
}

function rowToDto(r: TopicRow, participants = getTopicParticipants(r.id)): TopicDto {
  const normalized = normalizeTopicState({
    id: r.id,
    kind: normalizeTopicKind(r.kind),
    agent: (r.agent as AgentKind | null) ?? undefined,
    aiMode: normalizeAiMode(r.response_policy),
  });
  return {
    id: r.id,
    title: r.title,
    kind: normalized.kind,
    description: r.description ?? undefined,
    agent: normalized.agent,
    defaultModel: r.base_model ?? "deepseek-pro",
    defaultEffort: (r.base_effort as EffortLevel) ?? undefined,
    aiMode: normalized.aiMode,
    aiMention: aiMentionFromMode(normalized.aiMode),
    participants,
    createdAt: r.created_at,
    lastMessageAt: r.last_message_at ?? new Date().toISOString(),
    parentTopicId: r.parent_topic_id ?? undefined,
    isFork: r.is_fork !== 0,
    ...(r.is_subagent !== 0 ? { isSubagent: true } : {}),
  };
}

export function normalizeTopicKind(value: unknown): TopicKind | null {
  return value === "channel" || value === "agent" || value === "manager" ? value : null;
}

export function normalizeAiMode(value: unknown): AiMode | null {
  return value === "off" || value === "mention" || value === "always" ? value : null;
}

export function aiMentionFromMode(mode: AiMode): boolean {
  return mode === "mention";
}

export function inferTopicKind(input: {
  agent?: string | null;
  aiMention?: boolean | null;
}): TopicKind {
  return input.agent && input.aiMention !== true ? "agent" : "channel";
}

export function inferAiMode(input: {
  kind?: TopicKind | null;
  agent?: string | null;
  aiMode?: AiMode | null;
  aiMention?: boolean | null;
}): AiMode {
  if (input.kind === "manager") return "always";
  if (input.kind === "agent") return "always";
  if (input.kind === "channel") {
    if (!input.agent) return "off";
    if (input.aiMode === "mention") return "mention";
    if (input.aiMention === true) return "mention";
    return "mention";
  }
  if (!input.agent) return "off";
  if (input.aiMode) return input.aiMode;
  return input.aiMention === true ? "mention" : "always";
}

export function normalizeTopicState(input: {
  id?: string;
  kind?: TopicKind | null;
  agent?: AgentKind | null;
  aiMode?: AiMode | null;
  aiMention?: boolean | null;
}): { kind: TopicKind; aiMode: AiMode; agent?: AgentKind } {
  if (input.kind === "manager" || input.id === GENERAL_TOPIC_ID) {
    return {
      kind: "manager",
      aiMode: "always",
      agent: input.agent ?? DEFAULT_AGENT_ROOM_AGENT,
    };
  }

  const requestedKind = input.kind;
  const kind =
    requestedKind ??
    (input.aiMode === "always"
      ? "agent"
      : input.aiMode === "mention" || input.aiMode === "off"
        ? "channel"
        : input.agent && input.aiMention !== true
          ? "agent"
          : "channel");

  if (kind === "agent") {
    return {
      kind: "agent",
      aiMode: "always",
      agent: input.agent ?? DEFAULT_AGENT_ROOM_AGENT,
    };
  }

  const agent = input.aiMode === "off" ? undefined : (input.agent ?? undefined);
  return {
    kind: "channel",
    aiMode: agent ? "mention" : "off",
    agent,
  };
}

function normalizedTitle(title: string): string {
  return title.trim().toLowerCase();
}

export function upsertTopic(t: TopicDto): void {
  const normalized = normalizeTopicState({
    id: t.id,
    kind: normalizeTopicKind(t.kind),
    agent: t.agent ?? undefined,
    aiMode: normalizeAiMode(t.aiMode),
    aiMention: t.aiMention,
  });
  db.transaction(() => {
    db.query(
      `INSERT INTO api_topics
       (id,title,kind,description,agent,base_model,base_effort,response_policy,
        created_at,last_message_at,parent_topic_id,is_fork,is_subagent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       kind = excluded.kind,
       description = excluded.description,
       agent = excluded.agent,
       base_model = excluded.base_model,
       base_effort = excluded.base_effort,
       response_policy = excluded.response_policy,
       created_at = excluded.created_at,
       last_message_at = excluded.last_message_at,
       parent_topic_id = excluded.parent_topic_id,
       is_fork = excluded.is_fork,
       is_subagent = excluded.is_subagent`,
    ).run(
      t.id,
      t.title,
      normalized.kind,
      t.description ?? null,
      normalized.agent ?? null,
      t.defaultModel ?? null,
      t.defaultEffort ?? null,
      normalized.aiMode,
      t.createdAt,
      t.lastMessageAt ?? null,
      t.parentTopicId ?? null,
      t.isFork ? 1 : 0,
      t.isSubagent ? 1 : 0,
    );
    db.query("DELETE FROM topic_members WHERE topic_id = ?").run(t.id);
    for (const participant of t.participants) {
      db.query("INSERT INTO topic_members (topic_id,user_id,role) VALUES (?,?,?)").run(
        t.id,
        participant.userId,
        participant.role,
      );
    }
  })();
}

export function listTopics(): TopicDto[] {
  const rows = db
    .query("SELECT * FROM api_topics ORDER BY last_message_at DESC")
    .all() as TopicRow[];
  const participants = getAllTopicParticipants();
  return rows.map((row) => rowToDto(row, participants.get(row.id) ?? []));
}

export function getTopic(id: string): TopicDto | null {
  const r = db.query("SELECT * FROM api_topics WHERE id = ?").get(id) as TopicRow | undefined;
  return r ? rowToDto(r) : null;
}

/** Return the private manager room owned by a user, excluding the retired shared General row. */
export function getManagerTopicForUser(userId: string): TopicDto | null {
  const row = db
    .query<TopicRow, [string, string]>(
      `SELECT t.* FROM api_topics t
       JOIN topic_members m ON m.topic_id = t.id
       WHERE t.kind = 'manager'
         AND t.id != ?
         AND m.user_id = ?
         AND m.role = 'owner'
       ORDER BY t.created_at ASC
       LIMIT 1`,
    )
    .get(GENERAL_TOPIC_ID, userId);
  return row ? rowToDto(row) : null;
}

/**
 * Resolve the topic whose wiki memory should be used for this topic.
 *
 * Derived rooms keep `parentTopicId` as an immediate UI link, but memory follows
 * Otium's `forkOrigin` semantics: a fork/spawn chain writes to and reads from
 * the original root topic.
 */
export function getTopicMemoryOrigin(id: string): TopicDto | null {
  let current = getTopic(id);
  if (!current) return null;

  const seen = new Set<string>([current.id]);
  while (current.parentTopicId && !seen.has(current.parentTopicId)) {
    const parent = getTopic(current.parentTopicId);
    if (!parent) break;
    current = parent;
    seen.add(current.id);
  }

  return current;
}

/** Look up a topic by its user-visible title (case-insensitive exact match). */
export function getTopicByName(title: string): TopicDto | null {
  const r = db.query("SELECT * FROM api_topics WHERE LOWER(title) = LOWER(?)").get(title) as
    | TopicRow
    | undefined;
  return r ? rowToDto(r) : null;
}

export function getTopicByNameAndKind(title: string, kind: TopicKind): TopicDto | null {
  const r = db
    .query("SELECT * FROM api_topics WHERE LOWER(title) = LOWER(?) AND kind = ?")
    .get(title, kind) as TopicRow | undefined;
  return r ? rowToDto(r) : null;
}

export function findTopicTitleConflict(
  title: string,
  kind: TopicKind,
  opts: { excludeTopicId?: string } = {},
): TopicDto | null {
  const wanted = normalizedTitle(title);
  const generalTitleRequested = wanted === normalizedTitle(GENERAL_TOPIC_ID);
  if (generalTitleRequested && opts.excludeTopicId !== GENERAL_TOPIC_ID) {
    const general = db.query("SELECT * FROM api_topics WHERE id = ?").get(GENERAL_TOPIC_ID) as
      | TopicRow
      | undefined;
    if (general) return rowToDto(general);
  }

  const params: string[] = [wanted];
  let sql = "SELECT * FROM api_topics WHERE LOWER(TRIM(title)) = ?";
  if (kind !== "manager") {
    sql += " AND (kind = ? OR id = ?)";
    params.push(kind, GENERAL_TOPIC_ID);
  }
  if (opts.excludeTopicId) {
    sql += " AND id != ?";
    params.push(opts.excludeTopicId);
  }
  sql += " LIMIT 1";
  const row = db.query<TopicRow, string[]>(sql).get(...params);
  return row ? rowToDto(row) : null;
}

/** Look up a topic by title, restricted to topics where `userId` participates. */
export function getTopicByNameForUser(title: string, userId: string): TopicDto | null {
  const trimmed = title.trim();
  const qualified = /^(agent|channel|manager):(.+)$/i.exec(trimmed);
  const requestedKind = qualified ? normalizeTopicKind(qualified[1]?.toLowerCase()) : null;
  const requestedTitle = qualified ? qualified[2]!.trim() : trimmed;
  const rows = db
    .query(
      `SELECT t.* FROM api_topics t
       WHERE LOWER(t.title) = LOWER(?)
         AND t.id != ?
         AND EXISTS (
           SELECT 1 FROM topic_members m WHERE m.topic_id = t.id AND m.user_id = ?
         )`,
    )
    .all(requestedTitle, GENERAL_TOPIC_ID, userId) as TopicRow[];
  const matches = requestedKind ? rows.filter((row) => row.kind === requestedKind) : rows;
  return matches.length === 1 ? rowToDto(matches[0]!) : null;
}

/** Persist the agent session ID for a topic after a successful turn. */
export function setTopicSessionId(
  topicId: string,
  sessionId: string,
  context: TopicSessionLogContext = {},
): void {
  const previous = getTopicSessionId(topicId);
  const result = db
    .query("UPDATE api_topics SET session_id = ? WHERE id = ?")
    .run(sessionId, topicId);
  const changes = Number(result.changes ?? 0);
  const logContext = {
    topicId,
    previousSessionId: shortSessionId(previous),
    sessionId: shortSessionId(sessionId),
    reason: context.reason,
    queryId: context.queryId,
    agent: context.agent,
  };
  if (changes === 0) {
    logger.warn(logContext, "api-topic session_id update missed topic");
  } else if (previous !== sessionId) {
    logger.debug(logContext, "api-topic session_id updated");
  } else {
    logger.debug(logContext, "api-topic session_id unchanged");
  }
}

/** Clear the session ID (e.g. on topic reset). */
export function clearTopicSessionId(topicId: string, reason = "unspecified"): void {
  const previous = getTopicSessionId(topicId);
  const result = db.query("UPDATE api_topics SET session_id = NULL WHERE id = ?").run(topicId);
  const changes = Number(result.changes ?? 0);
  const logContext = { topicId, previousSessionId: shortSessionId(previous), reason };
  if (changes === 0) {
    logger.warn(logContext, "api-topic session_id clear missed topic");
  } else if (previous) {
    logger.info(logContext, "api-topic session_id cleared");
  } else {
    logger.debug(logContext, "api-topic session_id already clear");
  }
}

/** Read the persisted session ID for a topic, or null if none. */
export function getTopicSessionId(topicId: string): string | null {
  const r = db
    .query<{ session_id: string | null }, string>("SELECT session_id FROM api_topics WHERE id = ?")
    .get(topicId);
  return r?.session_id ?? null;
}

/**
 * Hard-delete a topic row. Irreversible — the caller is responsible for also
 * deleting the topic's messages (see `deleteMessagesForTopic`). Returns false
 * if the topic didn't exist.
 */
export function deleteTopic(id: string, options: { allowManager?: boolean } = {}): boolean {
  const r = db
    .query<{ id: string; kind: string }, string>("SELECT id, kind FROM api_topics WHERE id = ?")
    .get(id);
  if (!r) return false;
  if (id === GENERAL_TOPIC_ID || (r.kind === "manager" && !options.allowManager)) return false;
  db.query("DELETE FROM api_topics WHERE id = ?").run(id);
  return true;
}

export function addParticipantToDB(
  topicId: string,
  userId: string,
  role: "member" | "owner",
): boolean {
  if (!db.query("SELECT 1 FROM api_topics WHERE id = ?").get(topicId)) return false;
  db.query("INSERT OR IGNORE INTO topic_members (topic_id,user_id,role) VALUES (?,?,?)").run(
    topicId,
    userId,
    role,
  );
  return true;
}

export function removeParticipantFromDB(topicId: string, userId: string): boolean {
  if (!db.query("SELECT 1 FROM api_topics WHERE id = ?").get(topicId)) return false;
  db.query("DELETE FROM topic_members WHERE topic_id = ? AND user_id = ?").run(topicId, userId);
  return true;
}
