/**
 * PR7 revision 5 — the M-9 surface-scope stamp must not mark itself complete
 * while it skipped rooms (live maintenance, title conflict). Each scenario runs
 * in child processes against its own database file: the stamp is a once-per-
 * store migration and must never touch the shared in-process test store.
 *
 * The assertions read the database directly (marker row, `surface_scope`,
 * scope-move history) so they also run — and fail — against the pre-fix code.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Op =
  | { op: "seed"; rooms: Array<{ id: string; title: string; scope?: string }> }
  | { op: "fence"; id: string }
  | { op: "unfence"; id: string }
  | { op: "begin"; id: string }
  | { op: "finish"; id: string }
  | { op: "stamp"; scope: string }
  | { op: "retry"; now?: number; force?: boolean }
  | { op: "rename"; id: string; title: string }
  | { op: "sleep"; ms: number }
  | { op: "state" };

/** Opens the store through the real modules (every migration), then runs `CHILD_OPS`. */
const CHILD_SCRIPT = `
  const topics = await import("./src/storage/api-topics.ts");
  const state = await import("./src/storage/runtime-topic-state.ts");
  await import("./src/storage/topic-link-records.ts");
  const { db } = await import("./src/storage/forum-db.ts");
  const ops = JSON.parse(process.env.CHILD_OPS);
  const handles = new Map();
  const out = [];
  const snapshot = () => {
    const tables = new Set(db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    return {
      complete: Boolean(db.query("SELECT 1 FROM api_schema_migrations WHERE key = 'api_topics_surface_scope_stamp_20260809'").get()),
      scopes: Object.fromEntries(db.query("SELECT id, surface_scope FROM api_topics WHERE surface = 'otium' ORDER BY id").all().map((r) => [r.id, r.surface_scope])),
      moves: db.query("SELECT topic_id, to_scope FROM api_topic_scope_moves ORDER BY seq").all(),
      pending: tables.has("api_surface_scope_stamp_pending")
        ? db.query("SELECT topic_id, scope, reason, attempts FROM api_surface_scope_stamp_pending ORDER BY topic_id").all()
        : null,
      status: typeof topics.surfaceScopeStampStatus === "function" ? topics.surfaceScopeStampStatus() : null,
    };
  };
  for (const step of ops) {
    if (step.op === "seed") {
      const now = new Date().toISOString();
      for (const room of step.rooms) {
        db.query(
          "INSERT INTO api_topics (id, title, kind, agent, response_policy, created_at, surface, surface_scope) VALUES (?, ?, 'agent', 'codex', 'always', ?, 'otium', ?)",
        ).run(room.id, room.title, now, room.scope ?? null);
      }
      out.push(null);
    } else if (step.op === "fence") {
      // A maintenance fence held by some process (fresh heartbeat).
      db.query(
        "INSERT INTO runtime_topic_state (topic_id, epoch, maintenance, maintenance_owner, heartbeat_at) VALUES (?, 1, 1, 'other-process', ?) ON CONFLICT(topic_id) DO UPDATE SET maintenance = 1, maintenance_owner = 'other-process', heartbeat_at = excluded.heartbeat_at",
      ).run(step.id, Date.now());
      out.push(null);
    } else if (step.op === "unfence") {
      db.query("UPDATE runtime_topic_state SET maintenance = 0, maintenance_owner = NULL, heartbeat_at = NULL WHERE topic_id = ?").run(step.id);
      out.push(null);
    } else if (step.op === "begin") {
      handles.set(step.id, state.beginRuntimeTopicMaintenance(step.id));
      out.push(Boolean(handles.get(step.id)));
    } else if (step.op === "finish") {
      handles.get(step.id)?.finish();
      out.push(null);
    } else if (step.op === "stamp") {
      out.push(topics.stampUnscopedOtiumTopics(step.scope));
    } else if (step.op === "retry") {
      out.push(typeof topics.retryPendingSurfaceScopeStamp === "function"
        ? topics.retryPendingSurfaceScopeStamp({ now: step.now, force: step.force })
        : "missing");
    } else if (step.op === "rename") {
      db.query("UPDATE api_topics SET title = ? WHERE id = ?").run(step.title, step.id);
      out.push(null);
    } else if (step.op === "sleep") {
      await new Promise((resolve) => setTimeout(resolve, step.ms));
      out.push(null);
    } else {
      out.push(snapshot());
    }
  }
  console.log(JSON.stringify(out));
  process.exit(0);
`;

function store() {
  const dir = mkdtempSync(join(tmpdir(), "negotium-scope-stamp-"));
  tempDirs.push(dir);
  return dir;
}

function childEnv(dir: string, ops: Op[]) {
  return {
    ...process.env,
    SESSIONS_DB_PATH: join(dir, "sessions.db"),
    NEGOTIUM_STATE_DIR: join(dir, "state"),
    NEGOTIUM_NODE_ID: "stamp-node",
    NEGOTIUM_DEFAULT_SURFACE: "otium",
    LOG_LEVEL: "silent",
    CHILD_OPS: JSON.stringify(ops),
  };
}

function parse(stdout: string, stderr: string): any[] {
  const last = stdout.trim().split("\n").at(-1);
  if (!last?.startsWith("[")) throw new Error(`child failed:\n${stdout}\n${stderr}`);
  return JSON.parse(last);
}

async function run(dir: string, ops: Op[]): Promise<any[]> {
  const child = Bun.spawn([process.execPath, "-e", CHILD_SCRIPT], {
    cwd: join(import.meta.dir, "../.."),
    env: childEnv(dir, ops),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return parse(stdout, stderr);
}

describe("M-9 stamp — skipped rooms keep the migration open (revision 5)", () => {
  test("a room skipped for live maintenance is stamped after the fence is released", async () => {
    const dir = store();
    const [, , first, afterFirst] = await run(dir, [
      {
        op: "seed",
        rooms: [
          { id: "busy", title: "Busy" },
          { id: "idle", title: "Idle" },
        ],
      },
      { op: "fence", id: "busy" },
      { op: "stamp", scope: "ws-1" },
      { op: "state" },
    ]);
    expect(first).toBe(1);
    expect(afterFirst.scopes).toEqual({ busy: null, idle: "ws-1" });
    // Pre-fix: the marker was committed here and `busy` stayed NULL forever.
    expect(afterFirst.complete).toBe(false);
    expect(afterFirst.pending).toEqual([
      { topic_id: "busy", scope: "ws-1", reason: "maintenance_in_progress", attempts: 1 },
    ]);

    // Released (by another process: no in-process hook) → the next call files it.
    const [, second, afterSecond, third, afterThird] = await run(dir, [
      { op: "unfence", id: "busy" },
      { op: "stamp", scope: "ws-1" },
      { op: "state" },
      { op: "stamp", scope: "ws-1" },
      { op: "state" },
    ]);
    expect(second).toBe(1);
    expect(afterSecond.scopes).toEqual({ busy: "ws-1", idle: "ws-1" });
    expect(afterSecond.complete).toBe(true);
    expect(afterSecond.pending).toEqual([]);
    // Idempotent: complete means a no-op, no second history entry.
    expect(third).toBe(0);
    expect(afterThird.moves).toEqual([
      { topic_id: "idle", to_scope: "ws-1" },
      { topic_id: "busy", to_scope: "ws-1" },
    ]);
  });

  test("a maintenance release in this process retries at once; a retry keeps the first scope", async () => {
    const dir = store();
    const results = await run(dir, [
      { op: "seed", rooms: [{ id: "held", title: "Held" }] },
      { op: "begin", id: "held" },
      { op: "stamp", scope: "ws-1" },
      { op: "finish", id: "held" },
      { op: "sleep", ms: 50 },
      { op: "state" },
    ]);
    expect(results[1]).toBe(true);
    expect(results[2]).toBe(0);
    expect(results[5].scopes).toEqual({ held: "ws-1" });
    expect(results[5].complete).toBe(true);

    // Pinned scope: a later call naming another workspace still files the
    // pending room under the first attempt's workspace.
    const pinnedDir = store();
    const pinned = await run(pinnedDir, [
      { op: "seed", rooms: [{ id: "held", title: "Held" }] },
      { op: "fence", id: "held" },
      { op: "stamp", scope: "ws-1" },
      { op: "unfence", id: "held" },
      { op: "stamp", scope: "ws-2" },
      { op: "state" },
    ]);
    expect(pinned[4]).toBe(1);
    expect(pinned[5].scopes).toEqual({ held: "ws-1" });
    expect(pinned[5].complete).toBe(true);
  });

  test("a permanent title conflict never completes, stays reported, and does not block others", async () => {
    const dir = store();
    const results = await run(dir, [
      {
        op: "seed",
        rooms: [
          { id: "scoped", title: "Plans", scope: "ws-1" },
          { id: "clash", title: " plans " },
          { id: "free-a", title: "Alpha" },
          { id: "free-b", title: "Beta" },
        ],
      },
      { op: "stamp", scope: "ws-1" },
      { op: "stamp", scope: "ws-1" },
      { op: "stamp", scope: "ws-1" },
      { op: "state" },
    ]);
    expect(results.slice(1, 4)).toEqual([2, 0, 0]);
    const state = results[4];
    expect(state.scopes).toEqual({
      clash: null,
      "free-a": "ws-1",
      "free-b": "ws-1",
      scoped: "ws-1",
    });
    expect(state.complete).toBe(false);
    expect(state.pending).toEqual([
      { topic_id: "clash", scope: "ws-1", reason: "title_conflict", attempts: 3 },
    ]);
    expect(state.status).toMatchObject({ complete: false, pending: 1, scope: "ws-1" });
    expect(state.status.pendingTopics).toEqual([
      { topicId: "clash", reason: "title_conflict", detail: "scoped", attempts: 3 },
    ]);

    // The operator renames the room: the next attempt completes the migration.
    const [, stamped, after] = await run(dir, [
      { op: "rename", id: "clash", title: "Plans (legacy)" },
      { op: "stamp", scope: "ws-1" },
      { op: "state" },
    ]);
    expect(stamped).toBe(1);
    expect(after.scopes.clash).toBe("ws-1");
    expect(after.complete).toBe(true);
    expect(after.status).toMatchObject({ complete: true, pending: 0 });
  });

  test("unforced retries are rate-limited; a stamp never started is a no-op", async () => {
    const dir = store();
    const t0 = 10_000_000;
    const results = await run(dir, [
      { op: "seed", rooms: [{ id: "late", title: "Late" }] },
      // Nothing pending yet: the retry never starts the migration by itself.
      { op: "retry", now: t0 - 60_000 },
      { op: "state" },
      { op: "fence", id: "late" },
      { op: "stamp", scope: "ws-1" },
      { op: "unfence", id: "late" },
      { op: "retry", now: t0 },
      { op: "state" },
    ]);
    expect(results[1]).toBe(0);
    expect(results[2].scopes).toEqual({ late: null });
    expect(results[2].complete).toBe(false);
    expect(results[6]).toBe(1);
    expect(results[7].complete).toBe(true);

    const throttled = await run(store(), [
      { op: "seed", rooms: [{ id: "late", title: "Late" }] },
      { op: "fence", id: "late" },
      { op: "stamp", scope: "ws-1" },
      { op: "retry", now: t0 },
      { op: "unfence", id: "late" },
      { op: "retry", now: t0 + 1_000 },
      { op: "state" },
      { op: "retry", now: t0 + 31_000 },
      { op: "state" },
    ]);
    expect(throttled[3]).toBe(0);
    expect(throttled[5]).toBe(0);
    expect(throttled[6].scopes).toEqual({ late: null });
    expect(throttled[7]).toBe(1);
    expect(throttled[8].complete).toBe(true);
  });

  test("concurrent boots serialize: one history entry per room, marker only when nothing is left", async () => {
    const dir = store();
    const rooms = Array.from({ length: 20 }, (_, i) => ({
      id: `room-${String(i).padStart(2, "0")}`,
      title: `Room ${i}`,
    }));
    await run(dir, [
      { op: "seed", rooms: [...rooms, { id: "zz-busy", title: "Busy" }] },
      { op: "fence", id: "zz-busy" },
    ]);
    const boot = () => run(dir, [{ op: "stamp", scope: "ws-1" }]);
    const [a, b] = await Promise.all([boot(), boot()]);
    expect((a[0] as number) + (b[0] as number)).toBe(20);
    const [, mid] = await run(dir, [{ op: "sleep", ms: 0 }, { op: "state" }]);
    expect(mid.complete).toBe(false);
    expect(mid.moves).toHaveLength(20);
    expect(mid.pending).toEqual([
      expect.objectContaining({ topic_id: "zz-busy", reason: "maintenance_in_progress" }),
    ]);

    await run(dir, [{ op: "unfence", id: "zz-busy" }]);
    const [c, d] = await Promise.all([boot(), boot()]);
    expect((c[0] as number) + (d[0] as number)).toBe(1);
    const [end] = await run(dir, [{ op: "state" }]);
    expect(end.complete).toBe(true);
    expect(end.pending).toEqual([]);
    expect(end.moves).toHaveLength(21);
    expect(Object.values(end.scopes).every((scope) => scope === "ws-1")).toBe(true);
  });
});
