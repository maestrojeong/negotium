// Persistent topic store backed by shared SQLite.

import { GENERAL_TOPIC_ID } from "#platform/constants";
import { logger } from "#platform/logger";
import { db } from "#storage/forum-db";
import { registerStorageSchemaInitializer } from "#storage/storage-host";
import type { AgentKind, EffortLevel } from "#types";
import type {
  AiMode,
  ParticipantDto,
  SubagentReportMode,
  TopicDto,
  TopicKind,
  TopicSurface,
  TopicVisibility,
} from "#types/api";

const DEFAULT_AGENT_ROOM_AGENT: AgentKind = "maestro";

/**
 * Surface used when a caller does not name one — and the value every existing
 * row is backfilled with on first boot after the surface migration.
 *
 * Hosts that only ever serve one surface declare it once in their environment
 * (`NEGOTIUM_DEFAULT_SURFACE=otium` on the Otium hub and worker); a developer
 * Mac leaves it unset and gets `terminal`, with the telegram adapter
 * reclassifying its own mapped rooms afterwards.
 */
export function defaultTopicSurface(): TopicSurface {
  return normalizeTopicSurface(process.env.NEGOTIUM_DEFAULT_SURFACE);
}

export function normalizeTopicSurface(value: unknown): TopicSurface {
  return value === "telegram" || value === "otium" || value === "terminal" ? value : "terminal";
}

function tableColumns(table: string): Set<string> {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Persist the authoritative agent and, when supplied, its normalized base defaults. */
export function setApiTopicAgent(
  topicId: string,
  agent: AgentKind,
  defaults?: { model: string; effort?: EffortLevel },
): void {
  if (!defaults) {
    db.query("UPDATE api_topics SET agent = ? WHERE id = ?").run(agent, topicId);
    return;
  }
  db.query("UPDATE api_topics SET agent = ?, base_model = ?, base_effort = ? WHERE id = ?").run(
    agent,
    defaults.model,
    defaults.effort ?? null,
    topicId,
  );
}

function initializeApiTopicsSchema(): void {
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
      memory_topic_id TEXT,
      memory_key TEXT,
      is_fork INTEGER NOT NULL DEFAULT 0 CHECK (is_fork IN (0,1)),
      is_subagent INTEGER NOT NULL DEFAULT 0 CHECK (is_subagent IN (0,1)),
      visibility TEXT NOT NULL DEFAULT 'visible' CHECK (visibility IN ('visible','hidden')),
      surface TEXT NOT NULL DEFAULT 'terminal' CHECK (surface IN ('terminal','telegram','otium')),
      browser_profile TEXT NOT NULL DEFAULT 'default',
      browser_profile_owner TEXT,
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
              created_at,last_message_at,parent_topic_id,memory_topic_id,memory_key,is_fork,is_subagent,visibility,surface,session_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
            typeof row.memory_topic_id === "string" ? row.memory_topic_id : null,
            typeof row.memory_key === "string" ? row.memory_key : null,
            Number(row.is_fork ?? 0) !== 0 ? 1 : 0,
            Number(row.is_subagent ?? 0) !== 0 ? 1 : 0,
            row.visibility === "hidden" ? "hidden" : "visible",
            row.surface === undefined ? defaultTopicSurface() : normalizeTopicSurface(row.surface),
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_tell_grants (
      subagent_topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
      target_topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
      granted_by_topic_id TEXT NOT NULL REFERENCES api_topics(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (subagent_topic_id, target_topic_id)
    )
  `);
  db.exec(`
    DELETE FROM subagent_tell_grants
    WHERE subagent_topic_id NOT IN (SELECT id FROM api_topics)
       OR target_topic_id NOT IN (SELECT id FROM api_topics)
       OR granted_by_topic_id NOT IN (SELECT id FROM api_topics)
  `);
  db.exec("DELETE FROM topic_members WHERE topic_id NOT IN (SELECT id FROM api_topics)");

  // Canonical databases created before explicit adapter visibility need a
  // lightweight additive migration; fresh/rebuilt databases already have it.
  if (!tableColumns("api_topics").has("visibility")) {
    db.exec("ALTER TABLE api_topics ADD COLUMN visibility TEXT NOT NULL DEFAULT 'visible'");
  }
  if (!tableColumns("api_topics").has("surface")) {
    db.exec("ALTER TABLE api_topics ADD COLUMN surface TEXT NOT NULL DEFAULT 'terminal'");
  }
  // `access_mode` was replaced by `surface`: a topic is reachable from Otium
  // because it lives there, not because a flag was flipped (S-4). Dropping the
  // column removes the second, now-contradictory source of truth.
  if (tableColumns("api_topics").has("access_mode")) {
    try {
      db.exec("ALTER TABLE api_topics DROP COLUMN access_mode");
    } catch (err) {
      logger.warn({ err }, "api_topics: could not drop the retired access_mode column");
    }
  }
  if (!tableColumns("api_topics").has("browser_profile")) {
    db.exec("ALTER TABLE api_topics ADD COLUMN browser_profile TEXT NOT NULL DEFAULT 'default'");
  }
  if (!tableColumns("api_topics").has("browser_profile_owner")) {
    db.exec("ALTER TABLE api_topics ADD COLUMN browser_profile_owner TEXT");
  }
  if (!tableColumns("api_topics").has("subagent_report_mode")) {
    db.exec("ALTER TABLE api_topics ADD COLUMN subagent_report_mode TEXT NOT NULL DEFAULT 'auto'");
  }
  if (!tableColumns("api_topics").has("memory_topic_id")) {
    db.exec("ALTER TABLE api_topics ADD COLUMN memory_topic_id TEXT");
  }
  if (!tableColumns("api_topics").has("memory_key")) {
    db.exec("ALTER TABLE api_topics ADD COLUMN memory_key TEXT");
  }
  db.exec(`
  UPDATE api_topics
  SET browser_profile_owner = (
    SELECT m.user_id FROM topic_members m
    WHERE m.topic_id = api_topics.id AND m.role = 'owner'
    ORDER BY m.rowid
    LIMIT 1
  )
  WHERE browser_profile_owner IS NULL
`);
  backfillTopicSurfaces();
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_api_topics_last_message ON api_topics(last_message_at DESC)",
  );
  db.exec("CREATE INDEX IF NOT EXISTS idx_api_topics_surface ON api_topics(surface)");
}

const SURFACE_BACKFILL_MIGRATION = "api_topics_surface_backfill_20260808";

/**
 * One-time classification of pre-surface topics.
 *
 * Every row predates the column, so there is no per-row evidence in this store
 * to distinguish surfaces — the host declares it (`NEGOTIUM_DEFAULT_SURFACE`).
 * The telegram adapter owns the second pass: its chat↔topic mapping lives in a
 * different database file, so only it can reclassify the rooms it created.
 *
 * Names are unique per surface from now on, so collapsing three namespaces into
 * one can produce duplicates. Rather than failing the boot, the oldest room
 * keeps the name and the rest are suffixed — a rename is recoverable, a node
 * that refuses to start is not.
 */
function backfillTopicSurfaces(): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS api_schema_migrations (
    key TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )
`);
  const applied = db
    .query("SELECT key FROM api_schema_migrations WHERE key = ?")
    .get(SURFACE_BACKFILL_MIGRATION);
  if (applied) return;

  const surface = defaultTopicSurface();
  db.transaction(() => {
    db.query("UPDATE api_topics SET surface = ?").run(surface);
    renameSurfaceTitleCollisions();
    db.query("INSERT INTO api_schema_migrations (key, applied_at) VALUES (?, ?)").run(
      SURFACE_BACKFILL_MIGRATION,
      new Date().toISOString(),
    );
  })();
  logger.info({ surface }, "api_topics: surface backfilled");
}

/** Suffix duplicate `(surface, kind, title)` rows so the new uniqueness rule holds. */
function renameSurfaceTitleCollisions(): void {
  const rows = db
    .query<{ id: string; title: string; kind: string; surface: string }, []>(
      "SELECT id, title, kind, surface FROM api_topics ORDER BY created_at ASC, rowid ASC",
    )
    .all();
  const taken = new Set<string>();
  const update = db.query("UPDATE api_topics SET title = ? WHERE id = ?");
  for (const row of rows) {
    const key = (title: string) => [row.surface, row.kind, normalizedTitle(title)].join("\u0000");
    if (!taken.has(key(row.title))) {
      taken.add(key(row.title));
      continue;
    }
    let suffix = 2;
    let candidate = `${row.title} (${suffix})`;
    while (taken.has(key(candidate))) {
      suffix += 1;
      candidate = `${row.title} (${suffix})`;
    }
    taken.add(key(candidate));
    update.run(candidate, row.id);
    logger.warn(
      { topicId: row.id, surface: row.surface, from: row.title, to: candidate },
      "api_topics: renamed a duplicate title for surface-scoped uniqueness",
    );
  }
}

registerStorageSchemaInitializer(initializeApiTopicsSchema, 20);

export interface TopicRow {
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
  memory_topic_id: string | null;
  memory_key: string | null;
  is_fork: number;
  is_subagent: number;
  subagent_report_mode: string | null;
  visibility: string | null;
  surface: string | null;
  browser_profile_owner: string | null;
  session_id: string | null;
}

export interface TopicSessionLogContext {
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

function getAllSubagentTellTargets(): Map<string, string[]> {
  const rows = db
    .query(
      "SELECT subagent_topic_id, target_topic_id FROM subagent_tell_grants ORDER BY created_at",
    )
    .all() as Array<{ subagent_topic_id: string; target_topic_id: string }>;
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const targets = grouped.get(row.subagent_topic_id) ?? [];
    targets.push(row.target_topic_id);
    grouped.set(row.subagent_topic_id, targets);
  }
  return grouped;
}

function rowToDto(
  r: TopicRow,
  participants = getTopicParticipants(r.id),
  tellTargets?: Map<string, string[]>,
): TopicDto {
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
    memoryTopicId: r.memory_topic_id ?? undefined,
    memoryKey: r.memory_key ?? undefined,
    isFork: r.is_fork !== 0,
    ...(r.is_subagent !== 0 ? { isSubagent: true } : {}),
    ...(r.is_subagent !== 0
      ? {
          subagentTellTargetIds: tellTargets
            ? (tellTargets.get(r.id) ?? [])
            : listSubagentTellTargetIds(r.id),
        }
      : {}),
    ...(r.is_subagent !== 0
      ? {
          subagentReportMode: (r.subagent_report_mode === "tell" ||
          r.subagent_report_mode === "status-only"
            ? r.subagent_report_mode
            : "auto") as SubagentReportMode,
        }
      : {}),
    visibility: normalizeTopicVisibility(r.visibility),
    surface: normalizeTopicSurface(r.surface),
  };
}

export function normalizeTopicVisibility(value: unknown): TopicVisibility {
  return value === "hidden" ? "hidden" : "visible";
}

/** Discovery boundary shared by user-facing adapters. */
export function isTopicVisible(topic: Pick<TopicDto, "visibility">): boolean {
  return topic.visibility !== "hidden";
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
        created_at,last_message_at,parent_topic_id,memory_topic_id,memory_key,is_fork,is_subagent,visibility,surface,
        subagent_report_mode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
       memory_topic_id = excluded.memory_topic_id,
       memory_key = excluded.memory_key,
       is_fork = excluded.is_fork,
       is_subagent = excluded.is_subagent,
       visibility = excluded.visibility,
       surface = excluded.surface,
       subagent_report_mode = excluded.subagent_report_mode`,
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
      t.memoryTopicId ?? null,
      t.memoryKey ?? null,
      t.isFork ? 1 : 0,
      t.isSubagent ? 1 : 0,
      normalizeTopicVisibility(t.visibility),
      // A DTO without a surface means "wherever this host puts rooms", not
      // "terminal": embedding hosts (Otium) build topic literals by hand and
      // never name one, so defaulting to the literal would file every hub room
      // on the wrong surface.
      normalizeTopicSurface(t.surface ?? defaultTopicSurface()),
      t.subagentReportMode ?? "auto",
    );
    db.query("DELETE FROM topic_members WHERE topic_id = ?").run(t.id);
    for (const participant of t.participants) {
      db.query("INSERT INTO topic_members (topic_id,user_id,role) VALUES (?,?,?)").run(
        t.id,
        participant.userId,
        participant.role,
      );
    }
    const initialBrowserProfileOwner = t.participants.find(
      (participant) => participant.role === "owner",
    )?.userId;
    if (initialBrowserProfileOwner) {
      db.query(
        `UPDATE api_topics
         SET browser_profile_owner = COALESCE(browser_profile_owner, ?)
         WHERE id = ?`,
      ).run(initialBrowserProfileOwner, t.id);
    }
  })();
}

/**
 * List topics, optionally restricted to one surface.
 *
 * The filter lives here rather than in each adapter so a forgotten call site
 * cannot leak a telegram room into the terminal picker; adapters pass their own
 * surface and get a closed world back.
 */
export function listTopics(opts: { surface?: TopicSurface } = {}): TopicDto[] {
  const rows = (
    opts.surface
      ? db
          .query("SELECT * FROM api_topics WHERE surface = ? ORDER BY last_message_at DESC")
          .all(normalizeTopicSurface(opts.surface))
      : db.query("SELECT * FROM api_topics ORDER BY last_message_at DESC").all()
  ) as TopicRow[];
  const participants = getAllTopicParticipants();
  // Batch-load tell grants once: per-row queries would make every listTopics()
  // call O(N) extra statements as subagent counts grow.
  const tellTargets = rows.some((row) => row.is_subagent !== 0)
    ? getAllSubagentTellTargets()
    : undefined;
  return rows.map((row) => rowToDto(row, participants.get(row.id) ?? [], tellTargets));
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
 * Derived rooms keep `parentTopicId` as an immediate UI link. Memory normally
 * follows the chain to its original root, while `memoryTopicId` can redirect a
 * subagent to another accessible topic's accumulated knowledge.
 */
export function getTopicMemoryOrigin(id: string): TopicDto | null {
  let current = getTopic(id);
  if (!current) return null;

  const seen = new Set<string>([current.id]);
  while (true) {
    const nextId = current.memoryTopicId ?? current.parentTopicId;
    if (!nextId || seen.has(nextId)) break;
    const next = getTopic(nextId);
    if (!next) {
      // An explicitly selected memory topic that no longer resolves must not
      // silently fall back to the parent chain — that would leak the parent
      // room's memory to a subagent that asked for something else. Stop at the
      // current topic instead so the broken source is visible.
      if (current.memoryTopicId) {
        console.warn(
          `[topics] memory topic ${current.memoryTopicId} for ${current.id} is unresolvable; using the topic's own memory`,
        );
      }
      break;
    }
    current = next;
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

/**
 * Titles are unique **per surface**, not per node: `otium` may exist once on
 * the terminal, once on telegram and once on the Otium hub.
 */
export function findTopicTitleConflict(
  title: string,
  kind: TopicKind,
  opts: { excludeTopicId?: string; surface?: TopicSurface } = {},
): TopicDto | null {
  const wanted = normalizedTitle(title);
  const surface = normalizeTopicSurface(opts.surface ?? defaultTopicSurface());
  const generalTitleRequested = wanted === normalizedTitle(GENERAL_TOPIC_ID);
  if (generalTitleRequested && opts.excludeTopicId !== GENERAL_TOPIC_ID) {
    const general = db.query("SELECT * FROM api_topics WHERE id = ?").get(GENERAL_TOPIC_ID) as
      | TopicRow
      | undefined;
    if (general) return rowToDto(general);
  }

  const params: string[] = [wanted, surface];
  let sql = "SELECT * FROM api_topics WHERE LOWER(TRIM(title)) = ? AND surface = ?";
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

/**
 * Move topics onto a surface. Used by adapters that own a classification the
 * canonical store cannot derive on its own (the telegram chat↔topic mapping
 * lives in that adapter's database, not this one).
 */
export function setTopicSurfaces(topicIds: readonly string[], surface: TopicSurface): number {
  if (topicIds.length === 0) return 0;
  const normalized = normalizeTopicSurface(surface);
  let changed = 0;
  db.transaction(() => {
    const update = db.query("UPDATE api_topics SET surface = ? WHERE id = ? AND surface != ?");
    for (const topicId of topicIds) {
      changed += Number(update.run(normalized, topicId, normalized).changes ?? 0);
    }
  })();
  return changed;
}

/** Look up a topic by title, restricted to topics where `userId` participates. */
export function getTopicByNameForUser(
  title: string,
  userId: string,
  opts: { surface?: TopicSurface } = {},
): TopicDto | null {
  const trimmed = title.trim();
  const qualified = /^(agent|channel|manager):(.+)$/i.exec(trimmed);
  const requestedKind = qualified ? normalizeTopicKind(qualified[1]?.toLowerCase()) : null;
  const requestedTitle = qualified ? qualified[2]!.trim() : trimmed;
  const rows = db
    .query(
      `SELECT t.* FROM api_topics t
       WHERE LOWER(t.title) = LOWER(?)
         AND t.id != ?
         AND t.visibility != 'hidden'
         AND (? IS NULL OR t.surface = ?)
         AND EXISTS (
           SELECT 1 FROM topic_members m WHERE m.topic_id = t.id AND m.user_id = ?
         )`,
    )
    .all(
      requestedTitle,
      GENERAL_TOPIC_ID,
      opts.surface ?? null,
      opts.surface ?? null,
      userId,
    ) as TopicRow[];
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
  db.query(
    `DELETE FROM subagent_tell_grants
     WHERE subagent_topic_id = ? OR target_topic_id = ? OR granted_by_topic_id = ?`,
  ).run(id, id, id);
  db.query("DELETE FROM topic_members WHERE topic_id = ?").run(id);
  db.query("DELETE FROM api_topics WHERE id = ?").run(id);
  return true;
}

export function listSubagentTellTargetIds(subagentTopicId: string): string[] {
  return db
    .query<{ target_topic_id: string }, string>(
      "SELECT target_topic_id FROM subagent_tell_grants WHERE subagent_topic_id = ? ORDER BY created_at",
    )
    .all(subagentTopicId)
    .map((row) => row.target_topic_id);
}

export function grantSubagentTellTarget(
  subagentTopicId: string,
  targetTopicId: string,
  grantedByTopicId: string,
): void {
  db.query(
    `INSERT INTO subagent_tell_grants
       (subagent_topic_id,target_topic_id,granted_by_topic_id,created_at)
     VALUES (?,?,?,?)
     ON CONFLICT(subagent_topic_id,target_topic_id) DO UPDATE SET
       granted_by_topic_id = excluded.granted_by_topic_id`,
  ).run(subagentTopicId, targetTopicId, grantedByTopicId, new Date().toISOString());
}

export function revokeSubagentTellTarget(subagentTopicId: string, targetTopicId: string): boolean {
  return (
    db
      .query("DELETE FROM subagent_tell_grants WHERE subagent_topic_id = ? AND target_topic_id = ?")
      .run(subagentTopicId, targetTopicId).changes > 0
  );
}

/**
 * Preserve a derived-topic chain when an intermediate parent is deleted.
 * Direct children move to the deleted topic's parent (or become roots) rather
 * than retaining a dangling parent id that would break memory-origin lookup.
 */
export function reparentTopicChildren(
  deletedTopicId: string,
  replacementParentTopicId: string | null,
): string[] {
  const rows = db
    .query<{ id: string }, string>("SELECT id FROM api_topics WHERE parent_topic_id = ?")
    .all(deletedTopicId);
  if (rows.length === 0) return [];
  db.query("UPDATE api_topics SET parent_topic_id = ? WHERE parent_topic_id = ?").run(
    replacementParentTopicId,
    deletedTopicId,
  );
  // Reparenting can move a topic out of the subtree whose manager granted its
  // tell edges; purge involved grants (fail closed) — an ancestor can re-grant.
  for (const row of rows) {
    db.query(
      "DELETE FROM subagent_tell_grants WHERE subagent_topic_id = ? OR target_topic_id = ?",
    ).run(row.id, row.id);
  }
  return rows.map((row) => row.id);
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
