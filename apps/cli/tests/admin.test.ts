/**
 * `negotium admin` (PR12 v2). Every test runs on temp databases only: the
 * repo-root preload points core at a temp state dir, and "live" below means
 * that temp node DB (WAL, held open by core in this process).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  core,
  DB_EPOCH,
  freshScope,
  freshUser,
  makeReport,
  NODE_ID,
  nodeSnapshot,
  privateDir,
  type Report,
  SESSIONS_DB,
  seedTopic,
} from "./admin-fixtures";

const { runAdminCli, ADMIN_EXIT } = await import("@/commands/admin/index");
const { nodePaths, topicWorkspaceDir, sessionInboxFiles, pendingAskDir } = await import(
  "@/commands/admin/paths"
);
const { dbFileListing, createPrivateCopy } = await import("@/commands/admin/private-copy");

type Hooks = Parameters<typeof runAdminCli>[2];

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

function dirListing(dir: string): Record<string, string> {
  const listing: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    const bytes = readFileSync(join(dir, name));
    listing[name] = `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
  }
  return listing;
}

/** A messageless duplicate General with a mapped keeper in the same tuple. */
function duplicatePair(opts: { scope?: string | null } = {}) {
  const owner = freshUser();
  const scope = opts.scope === undefined ? freshScope() : opts.scope;
  const keeper = seedTopic({ owners: [owner], scope, messages: 2 });
  const dup = seedTopic({ owners: [owner], scope });
  return { owner, scope, keeper, dup };
}

describe("admin: arguments and exact ids", () => {
  test("help, unknown commands and options use the documented exit codes", async () => {
    const help = await run(["help"]);
    expect(help.code).toBe(ADMIN_EXIT.ok);
    expect(help.out).toContain("9  APPLIED, follow-up failed");
    expect((await run([])).code).toBe(ADMIN_EXIT.usage);
    expect((await run(["bulk-delete"])).code).toBe(ADMIN_EXIT.usage);
    expect((await run(["list-managers", "--nope"])).code).toBe(ADMIN_EXIT.usage);
    // Removed features stay removed.
    for (const flag of [
      "--allow-messages",
      "--export-to=x",
      "--to-scope=ws",
      "--allow-new-scope",
      "--i-know-the-node-is-running",
      "--allow-last",
    ]) {
      expect((await run(["delete-manager", "x", flag])).code).toBe(ADMIN_EXIT.usage);
    }
  });

  test("ids are exact: no lists, wildcards, whitespace, prefixes or case folding", async () => {
    const { dup } = duplicatePair();
    for (const bad of ["*", "a,b", ` ${dup}`, `${dup} `, "%"]) {
      expect((await run(["delete-manager", bad])).code).toBe(ADMIN_EXIT.usage);
    }
    expect((await run(["delete-manager", "a", "b"])).code).toBe(ADMIN_EXIT.usage);
    expect((await run(["delete-manager", dup.slice(0, 8)])).code).toBe(ADMIN_EXIT.notFound);
    expect((await run(["delete-manager", dup.toUpperCase()])).code).toBe(ADMIN_EXIT.notFound);
    expect(
      (await run(["scope-repair", "--topic", dup.slice(0, 8), "--expect-scope", "ws"])).code,
    ).toBe(ADMIN_EXIT.notFound);
  });

  test("binding flags come as a set", async () => {
    const report = makeReport();
    expect((await run(["list-managers", "--report-sha256", report.sha256])).code).toBe(
      ADMIN_EXIT.usage,
    );
    const at = report.args.indexOf("--expect-db-epoch");
    const partial = report.args.filter((_, i) => i !== at && i !== at + 1);
    expect((await run(["list-managers", ...partial])).code).toBe(ADMIN_EXIT.usage);
  });

  test("the mirrored filesystem layout equals core's own", () => {
    const paths = nodePaths();
    expect(paths.sessionsDb).toBe(resolve(SESSIONS_DB));
    expect(paths.runDir).toBe(core.RUN_DIR);
    expect(paths.sessionInboxDir).toBe(core.SESSION_INBOX_DIR);
    expect(paths.uploadsDir).toBe(join(core.DATA_DIR, "uploads"));
    const id = `weird id/${randomUUID()}`;
    expect(topicWorkspaceDir(paths, id)).toBe(core.resolveTopicWorkspaceDir(id));
    expect(sessionInboxFiles(paths, "u1", id)[0]).toBe(core.sessionInboxPath("u1", id));
    expect(pendingAskDir(paths, "u1")).toBe(join(core.RUN_DIR, "session-asks", "u1"));
  });
});

describe("admin: reports and dry-runs never change the live DB files", () => {
  test("list-managers, owners-report and both dry-runs leave db/-wal/-shm byte-identical", async () => {
    const { owner, scope, keeper, dup } = duplicatePair();
    seedTopic({ owners: [owner, freshUser()], scope, kind: "agent" });
    const unscoped = seedTopic({ owners: [freshUser()], scope: null, kind: "agent" });
    const report = makeReport({
      mapped: { [keeper]: "room-k", [unscoped]: "room-u" },
      scopes: [scope as string],
    });
    const before = dbFileListing(SESSIONS_DB);
    expect(Object.keys(before)).toEqual(expect.arrayContaining(["(main)", "-wal", "-shm"]));

    const list = await run(["list-managers", ...report.args, "--json"]);
    expect(list.code).toBe(ADMIN_EXIT.ok);
    const parsed = JSON.parse(list.out);
    expect(parsed.nodeIdentity).toEqual({ nodeId: NODE_ID, dbEpoch: DB_EPOCH });
    expect((await run(["list-managers"])).out).toContain(`node_id=${NODE_ID} db_epoch=${DB_EPOCH}`);
    const group = parsed.groups.find((g: { owner: string }) => g.owner === owner);
    expect(group.duplicate).toBe(true);
    expect(group.managers.map((m: { hub: { state: string } }) => m.hub.state)).toEqual([
      "mapped",
      "unmapped",
    ]);
    expect((await run(["owners-report", ...report.args])).code).toBe(ADMIN_EXIT.ok);
    expect((await run(["delete-manager", dup, ...report.args])).code).toBe(ADMIN_EXIT.ok);
    const repair = await run([
      "scope-repair",
      "--topic",
      unscoped,
      "--expect-scope",
      scope as string,
      ...report.args,
    ]);
    expect(repair.code).toBe(ADMIN_EXIT.ok);

    expect(dbFileListing(SESSIONS_DB)).toEqual(before);
  });

  test("CLI subprocess on WAL DBs (held open, or with -shm missing) changes no file in their dirs", () => {
    const snap = nodeSnapshot();
    const coldDir = privateDir("cold");
    const cold = join(coldDir, "node.db");
    writeFileSync(cold, readFileSync(snap));
    const writer = new Database(cold);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.exec(
      "CREATE TABLE IF NOT EXISTS admin_test_marker (x INTEGER); INSERT INTO admin_test_marker VALUES (1);",
    );
    writer.close();
    if (existsSync(`${cold}-shm`)) unlinkSync(`${cold}-shm`);
    const liveDir = privateDir("live");
    const live = join(liveDir, "node.db");
    writeFileSync(live, readFileSync(snap));
    const holder = new Database(live);
    holder.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS admin_test_marker (x INTEGER); INSERT INTO admin_test_marker VALUES (2);",
    );

    const state = privateDir("state");
    for (const [target, targetDir] of [
      [cold, coldDir],
      [live, liveDir],
    ] as const) {
      const before = dirListing(targetDir);
      for (const command of ["list-managers", "owners-report"]) {
        const child = Bun.spawnSync(
          [
            "bun",
            resolve(import.meta.dir, "../src/main.ts"),
            "admin",
            command,
            "--db",
            target,
            "--json",
          ],
          {
            env: {
              ...process.env,
              NEGOTIUM_STATE_DIR: state,
              SESSIONS_DB_PATH: join(state, "x.db"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        expect(child.exitCode).toBe(0);
      }
      expect(dirListing(targetDir)).toEqual(before);
    }
    expect(existsSync(`${cold}-shm`)).toBe(false);
    holder.close();
  });

  test("a private copy of a file that keeps changing is refused, not half-read", () => {
    const dir = privateDir("moving");
    const path = join(dir, "x.db");
    writeFileSync(path, readFileSync(nodeSnapshot()));
    let n = 0;
    expect(() =>
      createPrivateCopy(path, {
        afterReadForTests: () =>
          writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from([n++])])),
      }),
    ).toThrow(/kept changing/);
  });
});

describe("admin: the hub report is bound to this node, this epoch and this moment", () => {
  async function listWith(args: string[], db?: string) {
    return run(["list-managers", ...args, ...(db ? ["--db", db] : [])]);
  }
  function withFlag(report: Report, flag: string, value: string): string[] {
    const args = [...report.args];
    args[args.indexOf(flag) + 1] = value;
    return args;
  }

  test("a valid, fresh, bound report is accepted", async () => {
    expect((await listWith(makeReport().args)).code).toBe(ADMIN_EXIT.ok);
  });

  test("sha256 must be of the exact bytes that are parsed", async () => {
    const report = makeReport();
    expect((await listWith(withFlag(report, "--report-sha256", "a".repeat(64)))).code).toBe(
      ADMIN_EXIT.reportRejected,
    );
    writeFileSync(report.path, `${readFileSync(report.path, "utf8")} `);
    expect((await listWith(report.args)).code).toBe(ADMIN_EXIT.reportRejected);
  });

  test("forged year-2000 report with its own sha is stale; future dates are refused", async () => {
    const old = makeReport({ generatedAt: "2000-01-01T00:00:00.000Z" });
    const r = await listWith(old.args);
    expect(r.code).toBe(ADMIN_EXIT.reportRejected);
    expect(r.err).toContain("min old");
    const future = makeReport({ generatedAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await listWith(future.args)).code).toBe(ADMIN_EXIT.reportRejected);
    const twoHours = makeReport({
      generatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    expect((await listWith(twoHours.args)).code).toBe(ADMIN_EXIT.ok);
    expect((await listWith([...twoHours.args, "--max-report-age", "1h"])).code).toBe(
      ADMIN_EXIT.reportRejected,
    );
  });

  test("another DB's snapshot, another node id, another epoch are all refused", async () => {
    const report = makeReport();
    seedTopic({ owners: [freshUser()], scope: freshScope() });
    const other = nodeSnapshot();
    expect((await listWith(withFlag(report, "--audit-node-copy", other))).code).toBe(
      ADMIN_EXIT.reportRejected,
    );
    const forged = makeReport({
      mutate: (json) => {
        json.inputs[1].sha256 = "b".repeat(64);
      },
    });
    expect((await listWith(forged.args)).code).toBe(ADMIN_EXIT.reportRejected);
    expect((await listWith(withFlag(report, "--expect-node-id", "some-other-node"))).code).toBe(
      ADMIN_EXIT.reportRejected,
    );
    expect((await listWith(withFlag(report, "--expect-db-epoch", "f".repeat(32)))).code).toBe(
      ADMIN_EXIT.reportRejected,
    );
    // Live store of another epoch (recreated), same node id, same report.
    const recreated = join(privateDir("epoch"), "node.db");
    writeFileSync(recreated, readFileSync(nodeSnapshot()));
    const db = new Database(recreated);
    db.exec(`UPDATE api_node_identity SET epoch_id = '${"e".repeat(32)}'`);
    db.close();
    const e = await listWith(report.args, recreated);
    expect(e.code).toBe(ADMIN_EXIT.reportRejected);
    expect(e.err).toContain("live node DB identity");
  });

  test("the cell must match exactly one node input", async () => {
    const report = makeReport();
    expect((await listWith([...report.args, "--hub-cell", "cell_x"])).code).toBe(
      ADMIN_EXIT.reportRejected,
    );
    const cellReport = makeReport({ cellKey: "cell_x" });
    expect((await listWith(cellReport.args)).code).toBe(ADMIN_EXIT.ok);
    const noCellFlag = cellReport.args.slice(0, -2);
    expect((await listWith(noCellFlag)).code).toBe(ADMIN_EXIT.reportRejected);
  });

  test("an audit snapshot with sidecars next to it is refused", async () => {
    const report = makeReport();
    writeFileSync(`${report.snapshot}-wal`, "");
    expect((await listWith(report.args)).code).toBe(ADMIN_EXIT.refused);
  });

  test("mapped-ness is per exact id; absent ids are unknown", async () => {
    const owner = freshUser();
    const general = seedTopic({ owners: [owner], scope: freshScope() });
    const report = makeReport({ mapped: {} });
    const late = seedTopic({ owners: [owner], scope: freshScope() });
    const out = JSON.parse((await run(["list-managers", ...report.args, "--json"])).out);
    const states = new Map<string, string>();
    for (const group of out.groups) {
      for (const m of group.managers) states.set(m.topicId, m.hub.state);
    }
    expect(states.get(general)).toBe("unmapped");
    expect(states.get(late)).toBe("unknown");
  });
});
