/**
 * Fixtures for the `negotium admin` tests: seeded topics on a private
 * temporary node DB (see {@link SESSIONS_DB}), and a link-audit report generator that computes D2, D3,
 * D6 and D7 from a node snapshot with the same row shapes as otium
 * `scripts/link-audit/checks.ts` (reportVersion 1).
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const preloadDb = process.env.SESSIONS_DB_PATH ?? "";
if (!preloadDb.includes("negotium-root-test-") && !preloadDb.startsWith(tmpdir())) {
  // Only ever run under the preload's temporary state.
  throw new Error("admin tests must run from the repo root (preload sets a temp DB)");
}

export const work = mkdtempSync(join(tmpdir(), "negotium-admin-test-"));
// Shared by every admin test file in this process: removed once, at exit.
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

/**
 * The admin tests' own node DB, not the preload's shared one.
 *
 * The in-process admin CLI reads its DB with `fs` (private copy,
 * `dbFileListing`) while this process holds it open through core. POSIX
 * `fcntl` locks are per process, so that `close(2)` drops this process's
 * SQLite locks on the file; any other process that later opens and closes the
 * same DB believes it is the last connection and deletes `-wal`/`-shm` under
 * the open one — the "disk I/O error" / "database disk image is malformed"
 * cascade (and hang) of CI run 36156534788 on Linux + Bun 1.2.15, when this
 * was the preload DB every test file and its child processes share. No other
 * process opens this file. (The real CLI copies before it ever loads core, and
 * `createPrivateCopy` refuses a DB open in its own process; these in-process
 * tests opt out through `allowLiveDbOpenInThisProcess`.)
 */
export const SESSIONS_DB = join(work, "node", "node.db");
mkdirSync(join(work, "node"), { mode: 0o700 });

/** Points core and `nodePaths()` at the admin DB; returns the restore. */
export function useAdminNodeDb(): () => void {
  const previous = process.env.SESSIONS_DB_PATH;
  process.env.SESSIONS_DB_PATH = SESSIONS_DB;
  return () => {
    process.env.SESSIONS_DB_PATH = previous;
  };
}

/** Every admin test file: `beforeAll`/`afterAll` around its tests. */
export function adminNodeDbForThisFile(): void {
  let restore: (() => void) | null = null;
  beforeAll(() => {
    restore = useAdminNodeDb();
  });
  afterAll(() => {
    restore?.();
  });
}

export const core = await import("@negotium/core");
export const { NODE_ID } = await import("@negotium/core/node-host");

const restoreAtImport = useAdminNodeDb();
core.listTopics();
core.recordTopicLinkNodeIdentity(NODE_ID);
export const DB_EPOCH = core.topicLinkDbEpoch() as string;
restoreAtImport();

let clock = Date.parse("2026-01-01T00:00:00.000Z");
function nextTime(): string {
  clock += 60_000;
  return new Date(clock).toISOString();
}

export function freshUser(): string {
  return `admin-test-${randomUUID().slice(0, 8)}`;
}

export function freshScope(): string {
  return `ws_${randomUUID().slice(0, 8)}`;
}

export function seedTopic(opts: {
  owners: string[];
  kind?: "manager" | "agent";
  scope: string | null;
  surface?: "otium" | "terminal";
  title?: string;
  messages?: number;
  parentTopicId?: string;
  isSubagent?: boolean;
}): string {
  const id = randomUUID();
  const kind = opts.kind ?? "manager";
  const createdAt = nextTime();
  core.upsertTopic({
    id,
    title: opts.title ?? (kind === "manager" ? "General" : `room-${id.slice(0, 6)}`),
    kind,
    agent: "codex",
    aiMode: "always",
    defaultModel: "gpt-test",
    defaultEffort: "medium",
    participants: opts.owners.map((userId) => ({ userId, role: "owner" as const })),
    surface: opts.surface ?? "otium",
    surfaceScope: opts.scope,
    createdAt,
    lastMessageAt: createdAt,
    ...(opts.parentTopicId ? { parentTopicId: opts.parentTopicId } : {}),
    ...(opts.isSubagent ? { isSubagent: true } : {}),
  } as Parameters<typeof core.upsertTopic>[0]);
  for (let i = 0; i < (opts.messages ?? 0); i++) addMessage(id, opts.owners[0] ?? "x");
  return id;
}

export function addMessage(topicId: string, author: string): void {
  core.appendApiMessage(
    {
      id: core.asMessageId(randomUUID()),
      topicId: core.asTopicId(topicId),
      authorId: core.asUserId(author),
      text: `message in ${topicId}`,
      createdAt: nextTime(),
    } as Parameters<typeof core.appendApiMessage>[0],
    { notify: false },
  );
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

type Vacuumable = { query(sql: string): { run(...args: unknown[]): unknown } };

/** A single-file node snapshot, like sqlite3's `.backup copy.db`. */
export function nodeSnapshot(from: Vacuumable = core.db as unknown as Vacuumable): string {
  const path = join(work, `node-copy-${randomUUID()}.db`);
  from.query("VACUUM INTO ?").run(path);
  return path;
}

function titleHash(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 12);
}

function ok(id: string, rows: unknown[], extra: Record<string, unknown> = {}) {
  return { id, status: "ok", count: rows.length, truncated: false, ...extra, rows };
}

type Loose = Record<string, any>;

export interface ReportOptions {
  /** node topic id -> otium room id */
  mapped?: Record<string, string>;
  cellKey?: string;
  scopes?: string[];
  generatedAt?: string;
  /** Snapshot to audit (default: a fresh snapshot of the live test DB). */
  snapshot?: string;
  mutate?: (report: Loose) => void;
}

export interface Report {
  path: string;
  sha256: string;
  snapshot: string;
  json: Loose;
  /** The full binding flag set for this report. */
  args: string[];
}

export function makeReport(opts: ReportOptions = {}): Report {
  const cellKey = opts.cellKey ?? "";
  const snapshot = opts.snapshot ?? nodeSnapshot();
  const mapped = new Map(Object.entries(opts.mapped ?? {}));
  const db = new Database(snapshot, { readonly: true });
  const topics = db
    .query(
      `SELECT id, title, kind, created_at, last_message_at, parent_topic_id, is_subagent,
              surface, surface_scope, visibility FROM api_topics ORDER BY id`,
    )
    .all() as Loose[];
  const owners = new Map<string, string[]>();
  for (const row of db
    .query(
      "SELECT topic_id, user_id FROM topic_members WHERE role = 'owner' ORDER BY topic_id, user_id",
    )
    .all() as Array<{ topic_id: string; user_id: string }>) {
    owners.set(row.topic_id, [...(owners.get(row.topic_id) ?? []), row.user_id]);
  }
  const counts = new Map(
    (
      db
        .query("SELECT topic_id, COUNT(*) AS n FROM api_messages GROUP BY topic_id")
        .all() as Array<{
        topic_id: string;
        n: number;
      }>
    ).map((row) => [row.topic_id, row.n]),
  );
  const otium = topics.filter((t) => t.surface === "otium");
  const d2 = otium
    .filter((t) => t.surface_scope === null && mapped.has(t.id))
    .map((t) => ({
      cellKey,
      id: t.id,
      titleHash: titleHash(t.title),
      kind: t.kind,
      createdAt: t.created_at,
      parentTopicId: t.parent_topic_id,
      otiumTopicId: mapped.get(t.id),
      origin: "negotium",
    }));
  const d6 = otium
    .filter((t) => !mapped.has(t.id))
    .map((t) => ({
      cellKey,
      id: t.id,
      titleHash: titleHash(t.title),
      kind: t.kind,
      surfaceScope: t.surface_scope,
      visibility: t.visibility,
      isSubagent: t.is_subagent === 1,
      parentTopicId: t.parent_topic_id,
      createdAt: t.created_at,
      lastMessageAt: t.last_message_at,
      messageCount: counts.get(t.id) ?? 0,
      owners: owners.get(t.id) ?? [],
    }));
  const groups = new Map<string, { owner: string; scope: string | null; members: Loose[] }>();
  for (const t of otium.filter((x) => x.kind === "manager")) {
    const list = owners.get(t.id) ?? [];
    for (const owner of list.length ? list : ["<none>"]) {
      const key = JSON.stringify([owner, t.surface_scope]);
      const group = groups.get(key) ?? { owner, scope: t.surface_scope, members: [] as Loose[] };
      group.members.push({
        id: t.id,
        createdAt: t.created_at,
        mapped: mapped.has(t.id),
        otiumTopicId: mapped.get(t.id) ?? null,
        messageCount: counts.get(t.id) ?? 0,
        ...(list.length > 1 ? { owners: list } : {}),
      });
      groups.set(key, group);
    }
  }
  const d7 = [...groups.values()].map((g) => ({
    cellKey,
    owner: g.owner,
    scope: g.scope,
    n: g.members.length,
    duplicate: g.members.length > 1,
    members: g.members,
  }));
  const scopes =
    opts.scopes ??
    [...new Set(otium.map((t) => t.surface_scope).filter((s): s is string => s !== null))].sort();
  db.close();
  const snapBytes = readFileSync(snapshot);
  const c = `[${cellKey}]`;
  const json: Loose = {
    tool: "link-audit",
    reportVersion: 1,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    options: {
      limit: 0,
      includeTitles: false,
      integrity: false,
      scope: null,
      nodeIdentityProvided: true,
    },
    inputs: [
      {
        role: "hub",
        cellKey: null,
        path: "/tmp/hub-copy.db",
        sizeBytes: 1,
        sha256: "0".repeat(64),
        mtime: "",
        walHeaderPatched: false,
      },
      {
        role: "node",
        cellKey,
        path: snapshot,
        sizeBytes: snapBytes.length,
        sha256: createHash("sha256").update(snapBytes).digest("hex"),
        mtime: "",
        walHeaderPatched: false,
      },
    ],
    summary: { counts: {}, attention: [] },
    checks: {
      [`D2${c}`]: ok(`D2${c}`, d2),
      [`D3${c}`]: ok(`D3${c}`, [], {
        scopes,
        ambiguousScope: scopes.length > 1,
        candidateCount: d2.filter((r) => r.kind !== "manager").length,
        conflictingCandidateIds: [],
        byScope: {},
      }),
      [`D6.manager${c}`]: ok(
        `D6.manager${c}`,
        d6.filter((r) => r.kind === "manager"),
      ),
      [`D6.nonManager${c}`]: ok(
        `D6.nonManager${c}`,
        d6.filter((r) => r.kind !== "manager"),
      ),
      [`D7${c}`]: ok(`D7${c}`, d7, { groupCount: d7.length }),
    },
  };
  opts.mutate?.(json);
  const path = join(work, `audit-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(json, null, 2));
  const sha256 = sha256File(path);
  return {
    path,
    sha256,
    snapshot,
    json,
    args: [
      "--hub-report",
      path,
      "--report-sha256",
      sha256,
      "--audit-node-copy",
      snapshot,
      "--expect-node-id",
      NODE_ID,
      "--expect-db-epoch",
      DB_EPOCH,
      ...(cellKey ? ["--hub-cell", cellKey] : []),
    ],
  };
}

export function privateDir(name = "dir"): string {
  const dir = mkdtempSync(join(work, `${name}-`));
  chmodSync(dir, 0o700);
  return dir;
}
