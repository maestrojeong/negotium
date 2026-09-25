/**
 * `negotium admin` — node-local maintenance for the Otium topic-link
 * migration (design v2 §6, PR12). Reports and dry-runs analyse a private copy
 * of the DB and change nothing; `--apply` requires a stopped node, a hub
 * report bound to this node's identity/epoch, explicit confirmations and a
 * verified backup. See docs/ADMIN-CLI.md.
 */

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type CoreHandle, loadCoreExclusive } from "./apply-env";
import {
  type ApplyFaults,
  applyDeleteManager,
  assertDeleteConfirmations,
  planDeleteManager,
  renderDeletePlan,
} from "./delete-manager";
import {
  ADMIN_EXIT,
  AdminError,
  type AdminExitCode,
  errorMessage,
  notFound,
  usage,
} from "./errors";
import { readNodeIdentity, requireNodeSchema } from "./facts";
import { type BoundReport, loadBoundReport, parseMaxAge } from "./hub-report";
import { type NodePaths, nodePaths } from "./paths";
import { createPrivateCopy, type PrivateCopy } from "./private-copy";
import { listManagers, ownersReport, renderListManagers, renderOwnersReport } from "./reports";
import { defaultFsSeam, type FsSeam, openSafeDir } from "./safe-fs";
import {
  applyScopeRepair,
  planScopeRepair,
  renderScopeRepairPlan,
  scopePlanApplicable,
} from "./scope-repair";

export { ADMIN_EXIT } from "./errors";

export interface AdminIo {
  out(line: string): void;
  err(line: string): void;
}

/** Test-only seams; the CLI entry point never passes them. */
export interface AdminHooks {
  fs?: FsSeam;
  faults?: ApplyFaults;
  now?: () => number;
  loadCore?: (dbPath: string) => Promise<CoreHandle>;
}

const defaultIo: AdminIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const BINDING =
  "--hub-report FILE --report-sha256 HEX --audit-node-copy NODE_SNAPSHOT.db --expect-node-id ID --expect-db-epoch EPOCH [--hub-cell KEY] [--max-report-age 24h]";

export function renderAdminHelp(): string {
  return `negotium admin — node DB maintenance for the Otium topic-link migration

usage:
  negotium admin list-managers [--surface otium|terminal|telegram|all] [BINDING] [--json] [--db PATH]
  negotium admin owners-report [BINDING] [--include-titles] [--json] [--db PATH]
  negotium admin delete-manager TOPIC_ID BINDING [--json]
      apply: --apply --confirm-topic-id TOPIC_ID --confirm-owner USER
             (--confirm-scope WS | --confirm-unscoped) --backup-dir DIR
  negotium admin scope-repair --topic ID [--topic ID ...] --expect-scope WS BINDING [--include-titles] [--json]
      apply: --apply --backup-dir DIR

BINDING (hub link-audit evidence, bound to THIS node):
  ${BINDING}

Reports and dry-runs copy the DB into a private 0700 temp dir and analyse the copy;
the live DB and its -wal/-shm are only read, never opened by SQLite.
--apply: the node must be stopped (no override), runs only on this install's own DB,
takes a verified backup and a journal row before one immediate transaction.
delete-manager never deletes a topic with messages. scope-repair is irreversible.

exit codes:
  0  report printed / dry-run plan applicable / apply committed and verified
  1  unexpected error (nothing committed)
  2  usage error
  3  refused by a safety guard (nothing changed)
  4  drift: rows changed since the plan (nothing changed)
  5  target not found / not eligible
  6  hub report rejected (hash, freshness, node id/epoch, snapshot binding)
  9  APPLIED, follow-up failed (the change IS committed; see the printed run id)`;
}

interface ParsedArgs {
  positional: string[];
  values: Map<string, string[]>;
  flags: Set<string>;
}

const VALUE_OPTIONS = new Set([
  "db",
  "surface",
  "hub-report",
  "report-sha256",
  "audit-node-copy",
  "expect-node-id",
  "expect-db-epoch",
  "hub-cell",
  "max-report-age",
  "confirm-topic-id",
  "confirm-owner",
  "confirm-scope",
  "backup-dir",
  "topic",
  "expect-scope",
]);
const FLAG_OPTIONS = new Set(["apply", "json", "include-titles", "confirm-unscoped", "help"]);
const BINDING_OPTIONS = [
  "hub-report",
  "report-sha256",
  "audit-node-copy",
  "expect-node-id",
  "expect-db-epoch",
  "hub-cell",
  "max-report-age",
];

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], values: new Map(), flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      parsed.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      if (eq >= 0) usage(`--${name} takes no value`);
      parsed.flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) usage(`unknown option --${name}`);
    const value = eq >= 0 ? arg.slice(eq + 1) : args[++i];
    if (value === undefined || (eq < 0 && value.startsWith("--"))) usage(`--${name} needs a value`);
    const list = parsed.values.get(name) ?? [];
    list.push(value);
    parsed.values.set(name, list);
  }
  return parsed;
}

function single(parsed: ParsedArgs, name: string): string | undefined {
  const list = parsed.values.get(name);
  if (!list) return undefined;
  if (list.length > 1) usage(`--${name} may be given only once`);
  return list[0];
}

function allowOnly(parsed: ParsedArgs, command: string, allowed: string[]): void {
  const permitted = new Set(allowed);
  for (const name of [...parsed.values.keys(), ...parsed.flags]) {
    if (!permitted.has(name)) usage(`${command} does not accept --${name}`);
  }
}

/** Exact ids only: no wildcard, list, whitespace (and no trimming). */
function exactId(value: string, what: string): string {
  if (!value || /[\s*%?,]/.test(value))
    usage(`${what} must be one exact topic id (got ${JSON.stringify(value)})`);
  return value;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sameFile(a: string, b: string): boolean {
  return realpathOr(a) === realpathOr(b);
}

interface Session {
  paths: NodePaths;
  dbPath: string;
  copy: PrivateCopy;
  report: BoundReport | null;
  close(): void;
}

function openSession(parsed: ParsedArgs, hooks: AdminHooks): Session {
  const paths = nodePaths();
  const dbPath = resolve(single(parsed, "db") ?? paths.sessionsDb);
  if (!existsSync(dbPath)) notFound(`database not found: ${dbPath}`);
  const hubReport = single(parsed, "hub-report");
  if (!hubReport) {
    const stray = BINDING_OPTIONS.filter((name) => parsed.values.has(name));
    if (stray.length > 0) usage(`--${stray[0]} needs --hub-report`);
  } else {
    for (const name of ["report-sha256", "audit-node-copy", "expect-node-id", "expect-db-epoch"]) {
      if (!single(parsed, name)) usage(`--hub-report requires --${name}`);
    }
  }
  const maxAgeMs = parseMaxAge(single(parsed, "max-report-age"));
  const copy = createPrivateCopy(realpathOr(dbPath));
  let report: BoundReport | null = null;
  try {
    requireNodeSchema(copy.db, dbPath);
    if (hubReport) {
      report = loadBoundReport(
        {
          reportPath: hubReport,
          reportSha256: single(parsed, "report-sha256") as string,
          auditNodeCopy: single(parsed, "audit-node-copy") as string,
          expectNodeId: single(parsed, "expect-node-id") as string,
          expectDbEpoch: single(parsed, "expect-db-epoch") as string,
          hubCell: single(parsed, "hub-cell") ?? "",
          maxAgeMs,
          now: hooks.now?.(),
        },
        readNodeIdentity(copy.db),
      );
    }
  } catch (error) {
    copy.close();
    throw error;
  }
  return {
    paths,
    dbPath: realpathOr(dbPath),
    copy,
    report,
    close() {
      report?.close();
      copy.close();
    },
  };
}

function printJson(io: AdminIo, value: unknown): void {
  io.out(JSON.stringify(value, null, 2));
}

function reportHeader(session: Session): Record<string, unknown> {
  return {
    dbPath: session.dbPath,
    analysedCopy: true,
    hubReport: session.report
      ? {
          path: session.report.path,
          sha256: session.report.sha256,
          generatedAt: session.report.generatedAt,
          cellKey: session.report.cellKey,
          nodeId: session.report.identity.nodeId,
          dbEpoch: session.report.identity.dbEpoch,
        }
      : null,
  };
}

async function runListManagers(
  parsed: ParsedArgs,
  io: AdminIo,
  hooks: AdminHooks,
): Promise<AdminExitCode> {
  allowOnly(parsed, "list-managers", ["db", "surface", "json", ...BINDING_OPTIONS]);
  if (parsed.positional.length > 0) usage("list-managers takes no positional arguments");
  const surface = single(parsed, "surface") ?? "otium";
  if (!["otium", "terminal", "telegram", "all"].includes(surface))
    usage(`bad --surface ${surface}`);
  const session = openSession(parsed, hooks);
  try {
    const report = listManagers(session.copy.db, { surface, report: session.report });
    if (parsed.flags.has("json")) printJson(io, { ...reportHeader(session), ...report });
    else {
      io.out(`db: ${session.dbPath} (analysed on a private copy)`);
      for (const line of renderListManagers(report, session.report)) io.out(line);
    }
    return ADMIN_EXIT.ok;
  } finally {
    session.close();
  }
}

async function runOwnersReport(
  parsed: ParsedArgs,
  io: AdminIo,
  hooks: AdminHooks,
): Promise<AdminExitCode> {
  allowOnly(parsed, "owners-report", ["db", "json", "include-titles", ...BINDING_OPTIONS]);
  if (parsed.positional.length > 0) usage("owners-report takes no positional arguments");
  const session = openSession(parsed, hooks);
  try {
    const entries = ownersReport(session.copy.db, {
      report: session.report,
      includeTitles: parsed.flags.has("include-titles"),
    });
    if (parsed.flags.has("json"))
      printJson(io, { ...reportHeader(session), count: entries.length, topics: entries });
    else {
      io.out(`db: ${session.dbPath} (analysed on a private copy)`);
      for (const line of renderOwnersReport(entries)) io.out(line);
    }
    return ADMIN_EXIT.ok;
  } finally {
    session.close();
  }
}

function assertApplyTarget(session: Session): void {
  const own = nodePaths().sessionsDb;
  if (!sameFile(session.dbPath, own)) {
    throw new AdminError(
      ADMIN_EXIT.refused,
      `--apply only runs against this install's own DB (${own}); ${session.dbPath} is a different file`,
    );
  }
}

async function defaultLoadCore(dbPath: string): Promise<CoreHandle> {
  return loadCoreExclusive(dbPath, sameFile);
}

async function runDeleteManager(
  parsed: ParsedArgs,
  io: AdminIo,
  hooks: AdminHooks,
): Promise<AdminExitCode> {
  allowOnly(parsed, "delete-manager", [
    "db",
    "json",
    "apply",
    "confirm-topic-id",
    "confirm-owner",
    "confirm-scope",
    "confirm-unscoped",
    "backup-dir",
    ...BINDING_OPTIONS,
  ]);
  if (parsed.positional.length !== 1) usage("delete-manager takes exactly one TOPIC_ID");
  const topicId = exactId(parsed.positional[0] as string, "TOPIC_ID");
  const apply = parsed.flags.has("apply");
  if (!apply) {
    const applyOnly = ["confirm-topic-id", "confirm-owner", "confirm-scope", "backup-dir"].filter(
      (n) => parsed.values.has(n),
    );
    if (applyOnly.length > 0 || parsed.flags.has("confirm-unscoped")) {
      usage("--confirm-*/--backup-dir only apply with --apply");
    }
  }
  const session = openSession(parsed, hooks);
  try {
    const plan = planDeleteManager(session.copy.db, topicId, {
      report: session.report,
      paths: session.paths,
      now: hooks.now?.(),
    });
    if (parsed.flags.has("json") && !apply) {
      printJson(io, {
        ...reportHeader(session),
        mode: "dry-run",
        applicable: plan.blockers.length === 0,
        topicId,
        owner: plan.owner,
        scope: plan.scope,
        messages: plan.facts.messages,
        mapping: plan.mapping,
        keeper: plan.keeper ? { id: plan.keeper.id, otiumTopicId: plan.keeper.otiumTopicId } : null,
        references: plan.facts.references,
        blockers: plan.blockers,
      });
    } else {
      io.out(`db: ${session.dbPath} (planned on a private copy)`);
      io.out(apply ? "mode: APPLY" : "mode: dry-run (nothing will be written; add --apply)");
      for (const line of renderDeletePlan(plan)) io.out(line);
    }
    if (!apply) {
      if (plan.blockers.length > 0) {
        io.err("delete-manager: an apply would be refused (see REFUSED above)");
        return ADMIN_EXIT.refused;
      }
      return ADMIN_EXIT.ok;
    }
    assertDeleteConfirmations(plan, {
      confirmTopicId: single(parsed, "confirm-topic-id"),
      confirmOwner: single(parsed, "confirm-owner"),
      confirmScope: single(parsed, "confirm-scope"),
      confirmUnscoped: parsed.flags.has("confirm-unscoped"),
      backupDir: single(parsed, "backup-dir"),
    });
    assertApplyTarget(session);
    const backupDir = openSafeDir(single(parsed, "backup-dir") as string);
    return await applyDeleteManager({
      plan,
      report: session.report as BoundReport,
      paths: session.paths,
      liveCopy: session.copy,
      backupDir,
      fsSeam: hooks.fs ?? defaultFsSeam,
      faults: hooks.faults ?? {},
      loadCore: () => (hooks.loadCore ?? defaultLoadCore)(session.dbPath),
      out: io.out,
      err: io.err,
    });
  } finally {
    session.close();
  }
}

async function runScopeRepair(
  parsed: ParsedArgs,
  io: AdminIo,
  hooks: AdminHooks,
): Promise<AdminExitCode> {
  allowOnly(parsed, "scope-repair", [
    "db",
    "topic",
    "expect-scope",
    "include-titles",
    "json",
    "apply",
    "backup-dir",
    ...BINDING_OPTIONS,
  ]);
  if (parsed.positional.length > 0) usage("scope-repair takes topic ids only via --topic");
  const topics = (parsed.values.get("topic") ?? []).map((id) => exactId(id, "--topic"));
  if (topics.length === 0) usage("scope-repair requires at least one --topic ID");
  if (new Set(topics).size !== topics.length) usage("duplicate --topic");
  const expectScope = single(parsed, "expect-scope");
  if (!expectScope || expectScope !== expectScope.trim()) {
    usage("scope-repair requires --expect-scope WS (the scope the hub report names)");
  }
  const apply = parsed.flags.has("apply");
  if (!apply && parsed.values.has("backup-dir")) usage("--backup-dir only applies with --apply");
  const session = openSession(parsed, hooks);
  try {
    const plan = planScopeRepair(session.copy.db, topics, {
      report: session.report,
      expectScope,
      now: hooks.now?.(),
    });
    const applicable = scopePlanApplicable(plan);
    if (parsed.flags.has("json") && !apply) {
      printJson(io, {
        ...reportHeader(session),
        mode: "dry-run",
        applicable,
        targetScope: plan.targetScope,
        refusals: plan.refusals,
        items: plan.items.map((item) => ({
          topicId: item.topicId,
          kind: item.facts.row.kind,
          owners: item.facts.owners,
          messages: item.facts.messages,
          otiumTopicId: item.otiumTopicId,
          claimsLeft: item.claimsLeft,
          refusals: item.refusals,
        })),
      });
    } else {
      io.out(`db: ${session.dbPath} (planned on a private copy)`);
      io.out(apply ? "mode: APPLY" : "mode: dry-run (nothing will be written; add --apply)");
      for (const line of renderScopeRepairPlan(plan, parsed.flags.has("include-titles")))
        io.out(line);
    }
    if (!applicable) {
      io.err("scope-repair: refused — nothing was written");
      return ADMIN_EXIT.refused;
    }
    if (!apply) return ADMIN_EXIT.ok;
    const backupDirOption = single(parsed, "backup-dir");
    if (!backupDirOption) {
      throw new AdminError(
        ADMIN_EXIT.refused,
        "--apply requires --backup-dir DIR (a verified backup is taken first)",
      );
    }
    assertApplyTarget(session);
    const backupDir = openSafeDir(backupDirOption);
    return await applyScopeRepair({
      plan,
      topicIds: topics,
      expectScope,
      report: session.report as BoundReport,
      paths: session.paths,
      liveCopy: session.copy,
      backupDir,
      fsSeam: hooks.fs ?? defaultFsSeam,
      faults: hooks.faults ?? {},
      loadCore: () => (hooks.loadCore ?? defaultLoadCore)(session.dbPath),
      out: io.out,
      err: io.err,
    });
  } finally {
    session.close();
  }
}

export async function runAdminCli(
  args: string[],
  io: AdminIo = defaultIo,
  hooks: AdminHooks = {},
): Promise<AdminExitCode> {
  const [command, ...rest] = args;
  try {
    if (!command || command === "help" || command === "--help") {
      io.out(renderAdminHelp());
      return command ? ADMIN_EXIT.ok : ADMIN_EXIT.usage;
    }
    const parsed = parseArgs(rest);
    if (parsed.flags.has("help")) {
      io.out(renderAdminHelp());
      return ADMIN_EXIT.ok;
    }
    switch (command) {
      case "list-managers":
        return await runListManagers(parsed, io, hooks);
      case "owners-report":
        return await runOwnersReport(parsed, io, hooks);
      case "delete-manager":
        return await runDeleteManager(parsed, io, hooks);
      case "scope-repair":
        return await runScopeRepair(parsed, io, hooks);
      default:
        usage(`unknown admin command ${command}`);
    }
  } catch (error) {
    if (error instanceof AdminError) {
      io.err(`negotium admin ${command}: ${error.message}`);
      return error.exitCode;
    }
    io.err(`negotium admin ${command}: ${errorMessage(error)}`);
    return ADMIN_EXIT.error;
  }
}
