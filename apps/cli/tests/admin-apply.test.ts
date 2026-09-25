/**
 * `negotium admin` apply paths (PR12 v2) on the preload's temp node DB:
 * delete-manager eligibility, backup durability order, journal/exit-9
 * semantics, and scope-repair through PR7's `adminRepairOtiumTopicScope`.
 */

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  addMessage,
  core,
  freshScope,
  freshUser,
  makeReport,
  NODE_ID,
  nodeSnapshot,
  privateDir,
  seedTopic,
  work,
} from "./admin-fixtures";

const { runAdminCli, ADMIN_EXIT } = await import("@/commands/admin/index");
const { nodePaths, topicWorkspaceDir, sessionInboxFiles, pendingAskDir } = await import(
  "@/commands/admin/paths"
);
const { loadCoreExclusive } = await import("@/commands/admin/apply-env");
const { defaultFsSeam } = await import("@/commands/admin/safe-fs");
const { ensureCronSchema } = await import("@negotium/module-cron");

type Hooks = NonNullable<Parameters<typeof runAdminCli>[2]>;

interface Run {
  code: number;
  out: string;
  err: string;
  lines: string[];
}

async function run(args: string[], hooks: Hooks = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const lines: string[] = [];
  const code = await runAdminCli(
    args,
    {
      out: (l) => {
        out.push(l);
        lines.push(`out:${l}`);
      },
      err: (l) => {
        err.push(l);
        lines.push(`err:${l}`);
      },
    },
    hooks,
  );
  return { code, out: out.join("\n"), err: err.join("\n"), lines };
}

const paths = nodePaths();

function exists(id: string): boolean {
  return Boolean(core.db.query("SELECT 1 AS x FROM api_topics WHERE id = ?").get(id));
}

function scopeOf(id: string): string | null {
  return (
    (
      core.db.query("SELECT surface_scope FROM api_topics WHERE id = ?").get(id) as {
        surface_scope: string | null;
      } | null
    )?.surface_scope ?? null
  );
}

function messages(id: string): number {
  return Number(
    (
      core.db.query("SELECT COUNT(*) AS n FROM api_messages WHERE topic_id = ?").get(id) as {
        n: number;
      }
    ).n,
  );
}

function journalPhase(runId: string): string | null {
  return (
    (
      core.db.query("SELECT phase FROM admin_operation_journal WHERE run_id = ?").get(runId) as {
        phase: string;
      } | null
    )?.phase ?? null
  );
}

function journalRowsFor(topicId: string): number {
  try {
    return Number(
      (
        core.db
          .query("SELECT COUNT(*) AS n FROM admin_operation_journal WHERE targets LIKE ?")
          .get(`%${topicId}%`) as { n: number }
      ).n,
    );
  } catch {
    return 0;
  }
}

function runIdFrom(text: string): string {
  const match = /run[= ]((?:delete-manager|scope-repair)-[0-9TZ]+-[0-9a-f]+)/.exec(text);
  if (!match) throw new Error(`no run id in: ${text}`);
  return match[1] as string;
}

function duplicatePair(opts: { scope?: string | null; keeperMessages?: number } = {}) {
  const owner = freshUser();
  const scope = opts.scope === undefined ? freshScope() : opts.scope;
  const keeper = seedTopic({ owners: [owner], scope, messages: opts.keeperMessages ?? 2 });
  const dup = seedTopic({ owners: [owner], scope });
  return { owner, scope, keeper, dup };
}

function confirm(dup: string, owner: string, scope: string | null, backupDir: string): string[] {
  return [
    "--apply",
    "--confirm-topic-id",
    dup,
    "--confirm-owner",
    owner,
    ...(scope === null ? ["--confirm-unscoped"] : ["--confirm-scope", scope]),
    "--backup-dir",
    backupDir,
  ];
}

async function deleteApply(
  pair: { owner: string; scope: string | null; keeper: string; dup: string },
  opts: { mapped?: Record<string, string>; hooks?: Hooks; backupDir?: string } = {},
): Promise<Run & { backupDir: string }> {
  const report = makeReport({ mapped: opts.mapped ?? { [pair.keeper]: "room-keeper" } });
  const backupDir = opts.backupDir ?? privateDir("backup");
  const result = await run(
    [
      "delete-manager",
      pair.dup,
      ...report.args,
      ...confirm(pair.dup, pair.owner, pair.scope, backupDir),
    ],
    opts.hooks,
  );
  return { ...result, backupDir };
}

function realSame(a: string, b: string): boolean {
  return realpathSync(a) === realpathSync(b);
}

describe("delete-manager: messageful Generals are never deletable", () => {
  test("any topic with >= 1 message is refused under every flag combination", async () => {
    for (const count of [1, 7]) {
      const owner = freshUser();
      const scope = freshScope();
      const keeper = seedTopic({ owners: [owner], scope, messages: 3 });
      const target = seedTopic({ owners: [owner], scope, messages: count });
      const honest = makeReport({ mapped: { [keeper]: "room-k" } });
      // A forged report claiming 0 messages (with its own valid sha) changes nothing.
      const forged = makeReport({
        mapped: { [keeper]: "room-k" },
        mutate: (json) => {
          for (const row of json.checks["D6.manager[]"].rows)
            if (row.id === target) row.messageCount = 0;
          for (const group of json.checks["D7[]"].rows) {
            for (const m of group.members) if (m.id === target) m.messageCount = 0;
          }
        },
      });
      const backupDir = privateDir("backup");
      const variants: string[][] = [
        ["delete-manager", target],
        ["delete-manager", target, ...honest.args],
        ["delete-manager", target, ...honest.args, ...confirm(target, owner, scope, backupDir)],
        ["delete-manager", target, ...forged.args, ...confirm(target, owner, scope, backupDir)],
        [
          "delete-manager",
          target,
          ...honest.args,
          ...confirm(target, owner, scope, backupDir),
          "--json",
        ],
      ];
      for (const args of variants) {
        const r = await run(args);
        expect(r.code).toBe(ADMIN_EXIT.refused);
        expect(`${r.out}\n${r.err}`).toContain("never deletable");
      }
      expect(exists(target)).toBe(true);
      expect(messages(target)).toBe(count);
      expect(readdirSync(backupDir)).toEqual([]);
    }
  });
});

describe("delete-manager: eligibility", () => {
  test("happy path: one transaction, PR7 tombstone, journal, audit, verified 0600 backup", async () => {
    const pair = duplicatePair();
    const dryRun = await run([
      "delete-manager",
      pair.dup,
      ...makeReport({ mapped: { [pair.keeper]: "r" } }).args,
    ]);
    expect(dryRun.code).toBe(ADMIN_EXIT.ok);
    const r = await deleteApply(pair);
    expect(r.code).toBe(ADMIN_EXIT.ok);
    expect(exists(pair.dup)).toBe(false);
    expect(exists(pair.keeper)).toBe(true);
    const tombstone = core.getTopicTombstone(pair.dup);
    expect(tombstone?.reason).toBe("deleted");
    expect(tombstone?.nodeId).toBe(NODE_ID);
    expect(tombstone?.surfaceScope).toBe(pair.scope);
    const runId = runIdFrom(r.out);
    expect(journalPhase(runId)).toBe("done");
    const audit = core.db
      .query("SELECT entity_id, new_value FROM admin_audit_log WHERE run_id = ?")
      .all(runId) as Array<{ entity_id: string; new_value: string }>;
    expect(audit).toEqual([{ entity_id: pair.dup, new_value: "deleted" }]);
    const files = readdirSync(r.backupDir);
    expect(files).toHaveLength(1);
    const backup = join(r.backupDir, files[0] as string);
    expect(files[0]).not.toContain(pair.dup);
    expect(statSync(backup).mode & 0o777).toBe(0o600);
    const { Database } = await import("bun:sqlite");
    const copy = new Database(`file:${backup}?immutable=1`, { readonly: true });
    expect(copy.query("SELECT id FROM api_topics WHERE id = ?").get(pair.dup)).toBeTruthy();
    copy.close();
    // The keeper is what the owner's General resolves to now.
    const resolves = core.db
      .query(
        `SELECT t.id FROM api_topics t JOIN topic_members m ON m.topic_id = t.id
         WHERE t.kind = 'manager' AND t.surface = 'otium' AND t.surface_scope IS ?
           AND m.user_id = ? AND m.role = 'owner' ORDER BY t.created_at LIMIT 1`,
      )
      .get(pair.scope, pair.owner) as { id: string };
    expect(resolves.id).toBe(pair.keeper);
  });

  test("an unscoped duplicate needs --confirm-unscoped", async () => {
    const pair = duplicatePair({ scope: null });
    const report = makeReport({ mapped: { [pair.keeper]: "r" } });
    const wrong = await run([
      "delete-manager",
      pair.dup,
      ...report.args,
      ...confirm(pair.dup, pair.owner, "NULL", privateDir("b")),
    ]);
    expect(wrong.code).toBe(ADMIN_EXIT.refused);
    expect((await deleteApply(pair)).code).toBe(ADMIN_EXIT.ok);
  });

  test("the keeper must be MAPPED in the report, in the same (owner, otium, scope)", async () => {
    const unmappedKeeper = duplicatePair();
    const r = await deleteApply(unmappedKeeper, { mapped: {} });
    expect(r.code).toBe(ADMIN_EXIT.refused);
    expect(r.err).toContain("no keeper");
    // A mapped General of the same owner in ANOTHER scope does not count.
    const owner = freshUser();
    const scope = freshScope();
    const elsewhere = seedTopic({ owners: [owner], scope: freshScope() });
    const lonely = seedTopic({ owners: [owner], scope });
    const r2 = await deleteApply({ owner, scope, keeper: elsewhere, dup: lonely });
    expect(r2.code).toBe(ADMIN_EXIT.refused);
    expect(r2.err).toContain("last manager is never deleted");
    expect(exists(lonely)).toBe(true);
  });

  test("a mapped target and a multi-owner target are refused", async () => {
    const pair = duplicatePair();
    const mapped = await deleteApply(pair, { mapped: { [pair.keeper]: "a", [pair.dup]: "b" } });
    expect(mapped.code).toBe(ADMIN_EXIT.refused);
    expect(mapped.err).toContain("only an UNMAPPED General");
    const owner = freshUser();
    const scope = freshScope();
    const keeper = seedTopic({ owners: [owner], scope });
    const shared = seedTopic({ owners: [owner, freshUser()], scope });
    const multi = await deleteApply({ owner, scope, keeper, dup: shared });
    expect(multi.code).toBe(ADMIN_EXIT.refused);
    expect(multi.err).toContain("exactly one is required");
    expect(exists(shared)).toBe(true);
  });

  test("children, claims, cron, turns, inbox, asks, uploads and workspace files all block", async () => {
    ensureCronSchema();
    const now = new Date().toISOString();
    const cases: Array<[string, (pair: ReturnType<typeof duplicatePair>) => void]> = [
      [
        "child",
        (p) =>
          void seedTopic({
            owners: [p.owner],
            scope: p.scope,
            kind: "agent",
            parentTopicId: p.dup,
            isSubagent: true,
          }),
      ],
      [
        "claim",
        (p) =>
          core.db
            .query(
              `INSERT INTO api_topic_create_claims (principal_key, request_id, op, payload_hash, topic_id, state, created_at, updated_at)
               VALUES ('loopback', ?, 'create', 'h', ?, 'committed', ?, ?)`,
            )
            .run(randomUUID(), p.dup, now, now),
      ],
      [
        "cron",
        (p) =>
          core.db
            .query(
              `INSERT INTO negotium_cron_jobs (id, name, owner_user_id, topic_id, prompt, schedule, next_run_at, created_at, updated_at)
               VALUES (?, ?, ?, ?, 'p', '* * * * *', ?, ?, ?)`,
            )
            .run(randomUUID(), `job-${randomUUID()}`, p.owner, p.dup, now, now, now),
      ],
      [
        "queued turn",
        (p) =>
          core.db
            .query(
              `INSERT INTO runtime_user_turn_requests (request_id, topic_id, user_id, prompt, created_at)
               VALUES (?, ?, ?, 'hi', ?)`,
            )
            .run(randomUUID(), p.dup, p.owner, Date.now()),
      ],
      [
        "inbox",
        (p) => {
          const file = sessionInboxFiles(paths, p.owner, p.dup)[0] as string;
          mkdirSync(join(file, ".."), { recursive: true });
          writeFileSync(file, "{}\n");
        },
      ],
      [
        "ask",
        (p) => {
          const dir = pendingAskDir(paths, p.owner);
          mkdirSync(dir, { recursive: true });
          writeFileSync(
            join(dir, `v3-${randomUUID()}.pending`),
            JSON.stringify({ from: p.dup, to: "x" }),
          );
        },
      ],
      [
        "upload",
        (p) => {
          mkdirSync(paths.uploadsDir, { recursive: true });
          writeFileSync(
            join(paths.uploadsDir, `${randomUUID()}.meta.json`),
            JSON.stringify({ topicId: p.dup }),
          );
        },
      ],
      [
        "workspace",
        (p) => {
          const dir = topicWorkspaceDir(paths, p.dup);
          mkdirSync(join(dir, "attachments"), { recursive: true });
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      const pair = duplicatePair();
      arrange(pair);
      const r = await deleteApply(pair);
      if (r.code !== ADMIN_EXIT.refused)
        throw new Error(`${name}: expected refusal, got ${r.code}\n${r.out}\n${r.err}`);
      expect(exists(pair.dup)).toBe(true);
    }
  });

  test("wrong confirmations, another DB file, or a running node are refused", async () => {
    const pair = duplicatePair();
    const report = makeReport({ mapped: { [pair.keeper]: "r" } });
    const b = privateDir("b");
    const base = ["delete-manager", pair.dup, ...report.args];
    const good = confirm(pair.dup, pair.owner, pair.scope, b);
    for (const [flag, value] of [
      ["--confirm-topic-id", pair.keeper],
      ["--confirm-owner", freshUser()],
      ["--confirm-scope", freshScope()],
    ] as const) {
      const args = [...good];
      args[args.indexOf(flag) + 1] = value;
      expect((await run([...base, ...args])).code).toBe(ADMIN_EXIT.refused);
    }
    expect(
      (
        await run([
          ...base,
          ...good.filter((a, i) => a !== "--backup-dir" && good[i - 1] !== "--backup-dir"),
        ])
      ).code,
    ).toBe(ADMIN_EXIT.refused);
    // Same rows, but a different DB file: apply only runs on this install's DB.
    const copyDir = privateDir("copy");
    const copy = join(copyDir, "node.db");
    writeFileSync(copy, readFileSync(nodeSnapshot()));
    const other = await run([...base, "--db", copy, ...good]);
    expect(other.code).toBe(ADMIN_EXIT.refused);
    expect(other.err).toContain("this install's own DB");

    // Running node: daemon info with a live pid.
    mkdirSync(paths.runDir, { recursive: true });
    writeFileSync(paths.nodeDaemonInfo, JSON.stringify({ pid: process.pid, port: 1 }));
    try {
      const running = await run([...base, ...good]);
      expect(running.code).toBe(ADMIN_EXIT.refused);
      expect(running.err).toContain("node daemon is running");
    } finally {
      unlinkSync(paths.nodeDaemonInfo);
    }
    // Running adapter: a live process lease on the DB.
    core.db
      .query(
        "INSERT INTO runtime_process_leases (role, owner_id, pid, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("otium-adapter-test", `owner-${randomUUID()}`, process.pid, Date.now(), Date.now());
    try {
      const leased = await run([...base, ...good]);
      expect(leased.code).toBe(ADMIN_EXIT.refused);
      expect(leased.err).toContain("otium-adapter-test");
    } finally {
      core.db.query("DELETE FROM runtime_process_leases WHERE role = 'otium-adapter-test'").run();
    }
    expect(exists(pair.dup)).toBe(true);
    expect(readdirSync(b)).toEqual([]);
    expect((await run([...base, ...good])).code).toBe(ADMIN_EXIT.ok);
  });

  test("backup dir: symlink, group/other bits and a missing parent are refused", async () => {
    const pair = duplicatePair();
    const real = privateDir("real");
    const link = join(work, `link-${randomUUID()}`);
    symlinkSync(real, link);
    expect((await deleteApply(pair, { backupDir: link })).code).toBe(ADMIN_EXIT.refused);
    const open = privateDir("open");
    chmodSync(open, 0o770);
    expect((await deleteApply(pair, { backupDir: open })).code).toBe(ADMIN_EXIT.refused);
    expect((await deleteApply(pair, { backupDir: join(work, "no", "such", "parent") })).code).toBe(
      ADMIN_EXIT.refused,
    );
    const fresh = join(work, `fresh-${randomUUID()}`);
    expect((await deleteApply(pair, { backupDir: fresh })).code).toBe(ADMIN_EXIT.ok);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
  });
});

describe("delete-manager: durability order, journal and exit 9", () => {
  test("fsync(file) -> verify -> rename -> fsync(dir) -> journal -> delete, in that order", async () => {
    const pair = duplicatePair();
    const events: string[] = [];
    // The durable steps are recorded from the seam CALLS themselves; the
    // informational `event` hook only contributes the non-seam steps.
    const seam = {
      fsyncFile: (fd: number, path: string) => {
        events.push("fsync-file");
        defaultFsSeam.fsyncFile(fd, path);
      },
      fsyncDir: (dir: string) => {
        events.push("fsync-dir");
        defaultFsSeam.fsyncDir(dir);
      },
      renameNoClobber: (from: string, to: string) => {
        events.push("rename");
        defaultFsSeam.renameNoClobber(from, to);
      },
      event: (step: string) => {
        if (["create", "vacuum-into", "verify"].includes(step)) events.push(step);
      },
    };
    const r = await deleteApply(pair, {
      hooks: {
        fs: seam,
        faults: {
          afterPrepared: () => events.push("journal-prepared"),
          beforeCommit: () =>
            events.push(exists(pair.dup) ? "delete-not-done" : "delete-in-transaction"),
        },
      },
    });
    expect(r.code).toBe(ADMIN_EXIT.ok);
    expect(events).toEqual([
      "create",
      "vacuum-into",
      "fsync-file",
      "verify",
      "rename",
      "fsync-dir",
      "journal-prepared",
      "delete-in-transaction",
    ]);
  });

  test("a failing fsync(dir) stops everything before the journal and the delete", async () => {
    const pair = duplicatePair();
    const r = await deleteApply(pair, {
      hooks: {
        fs: {
          ...defaultFsSeam,
          fsyncDir: () => {
            throw new Error("injected EIO");
          },
        },
      },
    });
    expect(r.code).toBe(ADMIN_EXIT.error);
    expect(exists(pair.dup)).toBe(true);
    expect(journalRowsFor(pair.dup)).toBe(0);
  });

  test("a fault before COMMIT rolls back: topic intact, journal aborted, not exit 9", async () => {
    const pair = duplicatePair();
    const r = await deleteApply(pair, {
      hooks: {
        faults: {
          beforeCommit: () => {
            throw new Error("injected before commit");
          },
        },
      },
    });
    expect(r.code).toBe(ADMIN_EXIT.error);
    expect(r.err).toContain("NOT APPLIED");
    expect(exists(pair.dup)).toBe(true);
    expect(core.getTopicTombstone(pair.dup)).toBeNull();
    expect(
      core.db.query("SELECT COUNT(*) AS n FROM topic_members WHERE topic_id = ?").get(pair.dup),
    ).toEqual({ n: 1 });
    expect(journalPhase(runIdFrom(r.err))).toBe("aborted");
  });

  test("a fault after COMMIT is exit 9 'APPLIED, follow-up failed' with the run id, COMMITTED first", async () => {
    const pair = duplicatePair();
    const r = await deleteApply(pair, {
      hooks: {
        faults: {
          afterCommit: () => {
            throw new Error("injected after commit");
          },
        },
      },
    });
    expect(r.code).toBe(ADMIN_EXIT.appliedFollowUpFailed);
    const committed = r.lines.findIndex((l) => l.startsWith("out:COMMITTED run="));
    const followUp = r.lines.findIndex((l) => l.startsWith("err:APPLIED, follow-up failed"));
    expect(committed).toBeGreaterThanOrEqual(0);
    expect(followUp).toBeGreaterThan(committed);
    const runId = runIdFrom(r.lines[committed] as string);
    expect(r.lines[followUp]).toContain(runId);
    expect(exists(pair.dup)).toBe(false);
    expect(journalPhase(runId)).toBe("followup_failed");
  });

  test("rows changed between the private-copy plan and the live re-check: drift, nothing changed", async () => {
    const pair = duplicatePair();
    const r = await deleteApply(pair, {
      hooks: {
        loadCore: async (dbPath) => {
          core.db
            .query("UPDATE api_topics SET title = 'General (renamed)' WHERE id = ?")
            .run(pair.dup);
          return loadCoreExclusive(dbPath, realSame);
        },
      },
    });
    expect(r.code).toBe(ADMIN_EXIT.drift);
    expect(exists(pair.dup)).toBe(true);
    // A message arriving after the plan is caught the same way.
    const pair2 = duplicatePair();
    const r2 = await deleteApply(pair2, {
      hooks: {
        loadCore: async (dbPath) => {
          addMessage(pair2.dup, pair2.owner);
          return loadCoreExclusive(dbPath, realSame);
        },
      },
    });
    expect(r2.code).toBe(ADMIN_EXIT.drift);
    expect(exists(pair2.dup)).toBe(true);
  });
});

describe("scope-repair: only through adminRepairOtiumTopicScope, justified by the report", () => {
  function repairArgs(
    topics: string[],
    scope: string,
    report: { args: string[] },
    extra: string[] = [],
  ) {
    return [
      "scope-repair",
      ...topics.flatMap((t) => ["--topic", t]),
      "--expect-scope",
      scope,
      ...report.args,
      ...extra,
    ];
  }

  test("PR7's trigger still refuses a direct surface_scope write", () => {
    const room = seedTopic({ owners: [freshUser()], scope: null, kind: "agent" });
    expect(() =>
      core.db.query("UPDATE api_topics SET surface_scope = ? WHERE id = ?").run(freshScope(), room),
    ).toThrow(/otium_topic_scope_immutable/);
    expect(scopeOf(room)).toBeNull();
  });

  test("repairs a mapped unscoped room and a mapped unscoped General; audited, journaled", async () => {
    const scope = freshScope();
    const owner = freshUser();
    const room = seedTopic({ owners: [owner], scope: null, kind: "agent", messages: 3 });
    const general = seedTopic({ owners: [owner], scope: null, messages: 52 });
    const report = makeReport({
      mapped: { [room]: "hub-room", [general]: "hub-general" },
      scopes: [scope],
    });
    const dry = await run(repairArgs([room, general], scope, report));
    expect(dry.code).toBe(ADMIN_EXIT.ok);
    expect(dry.out).toContain("IRREVERSIBLE");
    expect(dry.out).not.toMatch(/revert with|roll back with/i);
    const r = await run(
      repairArgs([room, general], scope, report, ["--apply", "--backup-dir", privateDir("b")]),
    );
    expect(r.code).toBe(ADMIN_EXIT.ok);
    expect(scopeOf(room)).toBe(scope);
    expect(scopeOf(general)).toBe(scope);
    expect(messages(general)).toBe(52);
    const moves = core.db
      .query(
        "SELECT topic_id, from_scope, to_scope, actor FROM api_topic_scope_moves WHERE topic_id IN (?, ?) ORDER BY seq",
      )
      .all(room, general) as Array<{
      topic_id: string;
      from_scope: string | null;
      to_scope: string;
      actor: string;
    }>;
    expect(moves.map((m) => [m.topic_id, m.from_scope, m.to_scope])).toEqual([
      [room, null, scope],
      [general, null, scope],
    ]);
    expect(moves[0]?.actor).toStartWith("negotium-admin:");
    expect(journalPhase(runIdFrom(r.out))).toBe("done");
    // Immutable afterwards: the tool refuses a second repair.
    const again = makeReport({ mapped: { [room]: "hub-room" }, scopes: [freshScope()] });
    expect((await run(repairArgs([room], again.json.checks["D3[]"].scopes[0], again))).code).toBe(
      ADMIN_EXIT.refused,
    );
  });

  test("refuses: no D2 evidence, wrong/ambiguous scope, D7 duplicate, title conflicts, general row", async () => {
    const scope = freshScope();
    const owner = freshUser();
    const unmapped = seedTopic({ owners: [owner], scope: null });
    const r1 = await run(repairArgs([unmapped], scope, makeReport({ scopes: [scope] })));
    expect(r1.code).toBe(ADMIN_EXIT.refused);
    expect(r1.out).toContain("no D2 evidence");

    const room = seedTopic({ owners: [owner], scope: null, kind: "agent" });
    const mapped = { [room]: "hub-room" };
    expect(
      (await run(repairArgs([room], freshScope(), makeReport({ mapped, scopes: [scope] })))).code,
    ).toBe(ADMIN_EXIT.refused);
    expect(
      (await run(repairArgs([room], scope, makeReport({ mapped, scopes: [scope, freshScope()] }))))
        .code,
    ).toBe(ADMIN_EXIT.refused);

    // D7 duplicate: this owner already has a General in the target scope.
    const dupScope = freshScope();
    const owner2 = freshUser();
    seedTopic({ owners: [owner2], scope: dupScope });
    const unscopedGeneral = seedTopic({ owners: [owner2], scope: null });
    const d7 = await run(
      repairArgs(
        [unscopedGeneral],
        dupScope,
        makeReport({ mapped: { [unscopedGeneral]: "g" }, scopes: [dupScope] }),
      ),
    );
    expect(d7.code).toBe(ADMIN_EXIT.refused);
    expect(d7.out).toContain("D7 duplicate");

    // The primitive's title rule covers ANY otium room of the scope, incl. another user's General.
    const titleScope = freshScope();
    seedTopic({ owners: [freshUser()], scope: titleScope });
    const g3 = seedTopic({ owners: [freshUser()], scope: null });
    const t = await run(
      repairArgs([g3], titleScope, makeReport({ mapped: { [g3]: "g3" }, scopes: [titleScope] })),
    );
    expect(t.code).toBe(ADMIN_EXIT.refused);
    expect(t.out).toContain("title_conflict");

    // Two listed rooms with the same title key.
    const s4 = freshScope();
    const a = seedTopic({ owners: [owner], scope: null, kind: "agent", title: "Plans" });
    const b = seedTopic({ owners: [owner], scope: null, kind: "agent", title: " plans " });
    const pair = await run(
      repairArgs([a, b], s4, makeReport({ mapped: { [a]: "a", [b]: "b" }, scopes: [s4] })),
    );
    expect(pair.code).toBe(ADMIN_EXIT.refused);
    expect(scopeOf(a)).toBeNull();

    expect(
      (await run(repairArgs(["general"], scope, makeReport({ scopes: [scope] })))).code,
    ).not.toBe(ADMIN_EXIT.ok);
  });

  test("all-or-nothing: a fault after both primitive calls rolls both back", async () => {
    const scope = freshScope();
    const owner = freshUser();
    const a = seedTopic({ owners: [owner], scope: null, kind: "agent" });
    const b = seedTopic({ owners: [owner], scope: null, kind: "agent" });
    const report = makeReport({ mapped: { [a]: "a", [b]: "b" }, scopes: [scope] });
    const r = await run(
      repairArgs([a, b], scope, report, ["--apply", "--backup-dir", privateDir("b")]),
      {
        faults: {
          beforeCommit: () => {
            expect(scopeOf(a)).toBe(scope);
            throw new Error("injected");
          },
        },
      },
    );
    expect(r.code).toBe(ADMIN_EXIT.error);
    expect(scopeOf(a)).toBeNull();
    expect(scopeOf(b)).toBeNull();
    expect(
      core.db
        .query("SELECT COUNT(*) AS n FROM api_topic_scope_moves WHERE topic_id IN (?, ?)")
        .get(a, b),
    ).toEqual({ n: 0 });
    expect(journalPhase(runIdFrom(r.err))).toBe("aborted");
  });

  test("a fault after COMMIT is exit 9 and the scope stays repaired", async () => {
    const scope = freshScope();
    const room = seedTopic({ owners: [freshUser()], scope: null, kind: "agent" });
    const report = makeReport({ mapped: { [room]: "r" }, scopes: [scope] });
    const r = await run(
      repairArgs([room], scope, report, ["--apply", "--backup-dir", privateDir("b")]),
      {
        faults: {
          afterCommit: () => {
            throw new Error("injected");
          },
        },
      },
    );
    expect(r.code).toBe(ADMIN_EXIT.appliedFollowUpFailed);
    expect(r.lines.findIndex((l) => l.startsWith("out:COMMITTED"))).toBeLessThan(
      r.lines.findIndex((l) => l.startsWith("err:APPLIED, follow-up failed")),
    );
    expect(scopeOf(room)).toBe(scope);
  });

  test("apply without --backup-dir is refused", async () => {
    const scope = freshScope();
    const room = seedTopic({ owners: [freshUser()], scope: null, kind: "agent" });
    const report = makeReport({ mapped: { [room]: "r" }, scopes: [scope] });
    expect((await run(repairArgs([room], scope, report, ["--apply"]))).code).toBe(
      ADMIN_EXIT.refused,
    );
    expect(scopeOf(room)).toBeNull();
    expect(existsSync(join(work, "none"))).toBe(false);
  });
});
