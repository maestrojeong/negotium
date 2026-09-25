/**
 * `negotium admin delete-manager TOPIC_ID` — remove ONE messageless duplicate
 * personal General (design v2 §6.3 M5; review findings 2, 4, 7).
 *
 * Eligible only if ALL hold (no flag relaxes any of them):
 * - exact id, kind `manager`, surface `otium`, not the retired `general` row;
 * - 0 messages (a topic with ≥ 1 message is never deletable), no provider
 *   session, not a child/subagent;
 * - exactly one member, and it is the owner;
 * - no other row anywhere references the topic (children, create claims,
 *   tombstones, turns/requests, cron jobs, inbox, asks, grants, visuals, …;
 *   see `topicReferences`), no live maintenance fence;
 * - no inbox/ask/upload file references it and its workspace is absent or empty;
 * - another manager of the SAME (owner, otium, scope) exists — the keeper —
 *   and the bound hub report lists the keeper as MAPPED and the target as
 *   UNMAPPED with 0 messages in that exact (owner, scope) group, and both rows
 *   are unchanged since the audit snapshot.
 *
 * The delete is one `BEGIN IMMEDIATE` transaction that re-plans against the
 * live rows, deletes config/state/member/topic rows (PR7's trigger writes the
 * `deleted` tombstone in the same statement), flips the journal row to
 * `committed` and writes the audit row. Nothing outside that transaction is
 * destructive, so a failure before COMMIT leaves the topic fully intact.
 */

import { rmdirSync } from "node:fs";
import {
  assertNodeStoppedOffline,
  type CoreHandle,
  journalMarkCommitted,
  journalPrepared,
  journalSetPhase,
  newRunId,
  takeVerifiedBackup,
  writeAudit,
} from "./apply-env";
import {
  ADMIN_EXIT,
  AdminError,
  type AdminExitCode,
  errorMessage,
  notFound,
  refuse,
} from "./errors";
import {
  DELETED_WITH_TOPIC,
  fingerprint,
  GENERAL_TOPIC_ID,
  getTopicRow,
  HISTORY_REFERENCES,
  maintenanceActive,
  ownersOf,
  readNodeIdentity,
  type SqlDb,
  type TopicFacts,
  type TopicFileState,
  tableExists,
  topicFacts,
  topicFileState,
} from "./facts";
import { type BoundReport, describeMapping, type Mapping } from "./hub-report";
import type { NodePaths } from "./paths";
import type { PrivateCopy } from "./private-copy";
import type { FsSeam, SafeDir } from "./safe-fs";

function display(value: string | null): string {
  return value === null ? "NULL" : value;
}

export interface DeletePlan {
  topicId: string;
  facts: TopicFacts;
  owner: string | null;
  scope: string | null;
  mapping: Mapping | null;
  keeper: { id: string; facts: TopicFacts; otiumTopicId: string } | null;
  otherSameTuple: string[];
  files: TopicFileState;
  blockers: string[];
  /** Fingerprints of target and keeper as seen by this plan. */
  pins: { target: string; keeper: string | null };
}

export function planDeleteManager(
  db: SqlDb,
  topicId: string,
  opts: { report: BoundReport | null; paths: NodePaths; now?: number },
): DeletePlan {
  const facts = topicFacts(db, topicId);
  if (!facts)
    notFound(`topic ${JSON.stringify(topicId)} not found (ids are exact: no prefix, case or trim)`);
  if (topicId === GENERAL_TOPIC_ID)
    notFound("the retired shared `general` row is not a personal General");
  if (facts.row.kind !== "manager")
    notFound(`topic ${topicId} is kind ${facts.row.kind}, not manager`);
  if (facts.row.surface !== "otium") {
    notFound(
      `topic ${topicId} is on surface ${display(facts.row.surface)}; only otium Generals are handled`,
    );
  }
  const scope = facts.row.surfaceScope;
  const blockers: string[] = [];
  const { report } = opts;

  if (facts.messages > 0) {
    blockers.push(
      `topic has ${facts.messages} message(s): a General with messages is never deletable (design M5; no flag overrides this)`,
    );
  }
  if (facts.owners.length !== 1) {
    blockers.push(
      `topic has ${facts.owners.length} owners (${facts.owners.join(",") || "-"}); exactly one is required`,
    );
  }
  if (facts.members.length !== facts.owners.length) {
    blockers.push(`topic has ${facts.members.length - facts.owners.length} non-owner member(s)`);
  }
  const owner = facts.owners.length === 1 ? (facts.owners[0] as string) : null;
  if (facts.row.sessionId !== null)
    blockers.push("topic has a provider session (it has been used)");
  if (facts.row.parentTopicId !== null || facts.row.isSubagent) {
    blockers.push("topic is a child/subagent room, not a personal General");
  }
  for (const [ref, n] of Object.entries(facts.references)) {
    if (DELETED_WITH_TOPIC.has(ref) || HISTORY_REFERENCES.has(ref)) continue;
    blockers.push(`${n} row(s) in ${ref} reference this topic`);
  }
  if ((facts.references["api_topic_config.topic_id"] ?? 0) > 1) {
    blockers.push("more than one api_topic_config row");
  }
  if (maintenanceActive(db, topicId, opts.now))
    blockers.push("a live maintenance fence holds this topic");
  const files = topicFileState(opts.paths, topicId, facts.row.title, facts.owners);
  blockers.push(...files.blockers);

  // Same (owner, otium, scope) tuple — never a surface-wide search.
  const otherSameTuple = owner
    ? (
        db
          .query(
            `SELECT t.id FROM api_topics t JOIN topic_members m ON m.topic_id = t.id
             WHERE t.kind = 'manager' AND t.surface = 'otium' AND t.surface_scope IS ?
               AND m.user_id = ? AND m.role = 'owner' AND t.id != ? AND t.id != ?
             ORDER BY t.created_at, t.id`,
          )
          .all(scope, owner, topicId, GENERAL_TOPIC_ID) as Array<{ id: string }>
      ).map((row) => row.id)
    : [];
  if (owner && otherSameTuple.length === 0) {
    blockers.push(
      `this is the only General of owner ${owner} in scope ${display(scope)}: the last manager is never deleted`,
    );
  }

  let mapping: Mapping | null = null;
  let keeper: DeletePlan["keeper"] = null;
  if (!report) {
    blockers.push("--hub-report (with its binding flags) is required: mapped-ness is unknown");
  } else {
    mapping = report.mapping(topicId);
    for (const check of ["D6.manager", "D7"]) {
      if (report.truncated(check)) {
        blockers.push(
          `report check ${check}[${report.cellKey}] is skipped or truncated; re-run the audit with --limit 0`,
        );
      }
    }
    if (mapping.state !== "unmapped") {
      blockers.push(
        `hub report: target is ${describeMapping(mapping)}; only an UNMAPPED General can be deleted`,
      );
    }
    const d6 = report.d6Row(topicId);
    if (!d6) {
      blockers.push("hub report has no D6 (unmapped) row for this exact id");
    } else {
      const want = {
        kind: "manager",
        surfaceScope: scope,
        messageCount: 0,
        owners: owner ? [owner] : facts.owners,
        isSubagent: false,
        parentTopicId: null,
        createdAt: facts.row.createdAt,
      };
      const got = {
        kind: d6.kind,
        surfaceScope: d6.surfaceScope,
        messageCount: d6.messageCount,
        owners: [...d6.owners].sort(),
        isSubagent: d6.isSubagent,
        parentTopicId: d6.parentTopicId,
        createdAt: d6.createdAt,
      };
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        blockers.push(
          `hub report D6 row disagrees with the live row: report ${JSON.stringify(got)} vs live ${JSON.stringify(want)}`,
        );
      }
    }
    const group = owner
      ? (report.d7Groups().find((g) => g.owner === owner && g.scope === scope) ?? null)
      : null;
    const self = group?.members.find((m) => m.id === topicId) ?? null;
    if (!group || !self) {
      blockers.push(
        `hub report has no D7 entry for this id in group (owner ${owner ?? "?"}, scope ${display(scope)})`,
      );
    } else if (self.mapped || self.messageCount !== 0 || self.owners) {
      blockers.push(
        `hub report D7 entry is not an unmapped, messageless, single-owner member (${JSON.stringify(self)})`,
      );
    }
    if (group && owner) {
      for (const candidate of otherSameTuple) {
        const member = group.members.find((m) => m.id === candidate);
        if (!member?.mapped || !member.otiumTopicId || member.owners) continue;
        const keeperFacts = topicFacts(db, candidate);
        if (!keeperFacts || keeperFacts.owners.length !== 1 || keeperFacts.owners[0] !== owner)
          continue;
        if (member.messageCount !== keeperFacts.messages) continue;
        keeper = { id: candidate, facts: keeperFacts, otiumTopicId: member.otiumTopicId };
        break;
      }
    }
    if (!keeper) {
      blockers.push(
        `no keeper: no other General of (owner ${owner ?? "?"}, otium, scope ${display(scope)}) is listed as MAPPED (with matching message count) in the hub report`,
      );
    }
    // Both rows must be exactly what the audit saw.
    const audit = report.auditCopy.db;
    if (fingerprint(topicFacts(audit, topicId)) !== fingerprint(facts)) {
      blockers.push(
        "target changed since the audit snapshot (row/owners/messages/references); re-run the audit",
      );
    }
    if (keeper && fingerprint(topicFacts(audit, keeper.id)) !== fingerprint(keeper.facts)) {
      blockers.push(`keeper ${keeper.id} changed since the audit snapshot; re-run the audit`);
    }
  }

  return {
    topicId,
    facts,
    owner,
    scope,
    mapping,
    keeper,
    otherSameTuple,
    files,
    blockers,
    pins: { target: fingerprint(facts), keeper: keeper ? fingerprint(keeper.facts) : null },
  };
}

export function renderDeletePlan(plan: DeletePlan): string[] {
  const f = plan.facts;
  const lines = [
    `delete-manager plan for ${plan.topicId}`,
    `  owner=${plan.owner ?? f.owners.join(",")}  surface=otium  scope=${display(plan.scope)}  created=${f.row.createdAt}  messages=${f.messages}`,
    `  hub=${describeMapping(plan.mapping)}`,
    `  same (owner, otium, scope) Generals: ${plan.otherSameTuple.join(", ") || "none"}`,
    `  keeper: ${plan.keeper ? `${plan.keeper.id} (mapped -> ${plan.keeper.otiumTopicId}, ${plan.keeper.facts.messages} messages)` : "none"}`,
    "  will change, in ONE immediate transaction:",
  ];
  for (const ref of [...DELETED_WITH_TOPIC]) {
    const n = f.references[ref] ?? 0;
    if (n > 0) lines.push(`    DELETE ${n} row(s) from ${ref.split(".")[0]}`);
  }
  lines.push(
    "    DELETE 1 row from api_topics -> PR7 trigger INSERTs the `deleted` tombstone",
    "    UPDATE admin_operation_journal (prepared -> committed), INSERT 1 admin_audit_log row",
  );
  for (const ref of Object.keys(f.references).filter((r) => HISTORY_REFERENCES.has(r))) {
    lines.push(`    keep ${f.references[ref]} history row(s) in ${ref.split(".")[0]}`);
  }
  if (plan.files.workspaceExists)
    lines.push(`  after commit: rmdir empty ${plan.files.workspaceDir}`);
  for (const blocker of plan.blockers) lines.push(`  REFUSED: ${blocker}`);
  return lines;
}

export interface DeleteConfirm {
  confirmTopicId?: string;
  confirmOwner?: string;
  confirmScope?: string;
  confirmUnscoped: boolean;
  backupDir?: string;
}

export function assertDeleteConfirmations(plan: DeletePlan, confirm: DeleteConfirm): void {
  if (plan.blockers.length > 0) refuse(plan.blockers.join("; "));
  if (confirm.confirmTopicId !== plan.topicId)
    refuse(`--apply requires --confirm-topic-id ${plan.topicId}`);
  if (confirm.confirmOwner !== plan.owner) refuse(`--apply requires --confirm-owner ${plan.owner}`);
  const scopeOk =
    plan.scope === null
      ? confirm.confirmUnscoped && confirm.confirmScope === undefined
      : !confirm.confirmUnscoped && confirm.confirmScope === plan.scope;
  if (!scopeOk) {
    refuse(
      plan.scope === null
        ? "--apply requires --confirm-unscoped (the topic's scope is NULL)"
        : `--apply requires --confirm-scope ${plan.scope}`,
    );
  }
  if (!confirm.backupDir)
    refuse("--apply requires --backup-dir DIR (a verified backup is taken first)");
}

export interface ApplyFaults {
  afterPrepared?(): void;
  beforeCommit?(): void;
  afterCommit?(): void;
}

export interface DeleteApplyContext {
  plan: DeletePlan;
  report: BoundReport;
  paths: NodePaths;
  liveCopy: PrivateCopy;
  backupDir: SafeDir;
  fsSeam: FsSeam;
  faults: ApplyFaults;
  loadCore(): Promise<CoreHandle>;
  out(line: string): void;
  err(line: string): void;
}

function requireSamePlan(live: DeletePlan, planned: DeletePlan): void {
  if (
    live.pins.target !== planned.pins.target ||
    live.pins.keeper !== planned.pins.keeper ||
    live.keeper?.id !== planned.keeper?.id
  ) {
    throw new AdminError(
      ADMIN_EXIT.drift,
      "target or keeper changed since the plan; nothing was changed",
    );
  }
  if (live.blockers.length > 0) refuse(`live re-check refused: ${live.blockers.join("; ")}`);
}

export async function applyDeleteManager(ctx: DeleteApplyContext): Promise<AdminExitCode> {
  const { plan, report } = ctx;
  assertNodeStoppedOffline(ctx.paths, ctx.liveCopy.db);
  const handle = await ctx.loadCore();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    handle.release();
  };
  try {
    const db = handle.db;
    if (handle.nodeId !== report.identity.nodeId) {
      refuse(
        `this shell's NODE_ID (${handle.nodeId}) is not --expect-node-id ${report.identity.nodeId}; use the node's own env`,
      );
    }
    const liveIdentity = readNodeIdentity(db);
    if (
      liveIdentity.nodeId !== report.identity.nodeId ||
      liveIdentity.dbEpoch !== report.identity.dbEpoch
    ) {
      throw new AdminError(
        ADMIN_EXIT.reportRejected,
        "live node identity/epoch no longer matches the report binding",
      );
    }
    requireSamePlan(planDeleteManager(db, plan.topicId, { report, paths: ctx.paths }), plan);

    const backup = takeVerifiedBackup(db, ctx.backupDir, "delete-manager", ctx.fsSeam, (copy) => {
      const inBackup = topicFacts(copy as unknown as SqlDb, plan.topicId);
      if (!inBackup) refuse("backup does not contain the target topic");
      // safeIntegers copy: normalise bigint counts before comparing.
      if (fingerprint(normalise(inBackup)) !== plan.pins.target)
        refuse("backup row differs from the plan");
      const identity = readNodeIdentity(copy as unknown as SqlDb);
      if (
        identity.nodeId !== report.identity.nodeId ||
        identity.dbEpoch !== report.identity.dbEpoch
      ) {
        refuse("backup node identity differs");
      }
    });
    ctx.out(
      `backup: ${backup.path} (sha256 ${backup.sha256}, ${backup.sizeBytes} bytes, fsynced + verified)`,
    );

    const runId = newRunId("delete-manager");
    journalPrepared(db, {
      runId,
      command: "delete-manager",
      targets: [plan.topicId],
      backup,
      reportSha256: report.sha256,
      detail: {
        owner: plan.owner,
        scope: plan.scope,
        keeper: plan.keeper?.id,
        reportGeneratedAt: report.generatedAt,
      },
    });
    ctx.out(`journal: admin_operation_journal run_id=${runId} phase=prepared`);
    ctx.faults.afterPrepared?.();

    let tombstoneSeq = 0;
    try {
      db.transaction(() => {
        requireSamePlan(planDeleteManager(db, plan.topicId, { report, paths: ctx.paths }), plan);
        if (tableExists(db, "api_topic_config")) {
          db.query("DELETE FROM api_topic_config WHERE topic_id = ?").run(plan.topicId);
        }
        if (tableExists(db, "runtime_topic_state")) {
          db.query("DELETE FROM runtime_topic_state WHERE topic_id = ?").run(plan.topicId);
        }
        db.query("DELETE FROM topic_members WHERE topic_id = ?").run(plan.topicId);
        const removed = db
          .query(
            `DELETE FROM api_topics WHERE id = ? AND kind = 'manager' AND surface = 'otium'
               AND surface_scope IS ?`,
          )
          .run(plan.topicId, plan.scope);
        // `changes` also counts the tombstone trigger's rows: re-read instead.
        if (Number(removed?.changes ?? 0) < 1 || getTopicRow(db, plan.topicId) !== null) {
          throw new AdminError(ADMIN_EXIT.drift, "the topic row was not deleted (CAS lost)");
        }
        const tombstone = db
          .query(
            "SELECT seq, node_id, reason, surface_scope FROM api_topic_tombstones WHERE topic_id = ?",
          )
          .get(plan.topicId) as {
          seq: number;
          node_id: string | null;
          reason: string;
          surface_scope: string | null;
        } | null;
        if (
          !tombstone ||
          tombstone.reason !== "deleted" ||
          tombstone.node_id !== report.identity.nodeId ||
          tombstone.surface_scope !== plan.scope
        ) {
          throw new AdminError(
            ADMIN_EXIT.error,
            `PR7 tombstone missing or wrong (${JSON.stringify(tombstone)})`,
          );
        }
        tombstoneSeq = Number(tombstone.seq);
        journalMarkCommitted(db, runId);
        writeAudit(db, [
          {
            runId,
            command: "delete-manager",
            entity: "api_topics",
            entityId: plan.topicId,
            field: "row",
            oldValue: "present",
            newValue: "deleted",
            detail: {
              owner: plan.owner,
              scope: plan.scope,
              keeper: plan.keeper?.id,
              keeperOtiumTopicId: plan.keeper?.otiumTopicId,
              tombstoneSeq,
              backup: backup.path,
              backupSha256: backup.sha256,
              reportSha256: report.sha256,
              reportGeneratedAt: report.generatedAt,
            },
          },
        ]);
        ctx.faults.beforeCommit?.();
      }).immediate();
    } catch (error) {
      journalSetPhase(db, runId, "aborted", errorMessage(error));
      ctx.err(`NOT APPLIED: run ${runId} rolled back; ${plan.topicId} is intact`);
      throw error;
    }

    ctx.out(
      `COMMITTED run=${runId} deleted ${plan.topicId} (tombstone seq ${tombstoneSeq}); keeper ${plan.keeper?.id}`,
    );
    try {
      ctx.faults.afterCommit?.();
      if (getTopicRow(db, plan.topicId)) throw new Error("topic row still present after commit");
      if (ownersOf(db, plan.topicId).length > 0)
        throw new Error("member rows still present after commit");
      if (plan.files.workspaceExists) rmdirSync(plan.files.workspaceDir);
      release();
      journalSetPhase(db, runId, "done");
    } catch (error) {
      journalSetPhase(db, runId, "followup_failed", errorMessage(error));
      ctx.err(
        `APPLIED, follow-up failed: run ${runId}: ${errorMessage(error)}. The delete IS committed (tombstone written); do not re-run it — inspect admin_operation_journal/admin_audit_log for ${runId}`,
      );
      return ADMIN_EXIT.appliedFollowUpFailed;
    }
    ctx.out(`done: run ${runId}; restart the node, then run a hub full reconcile and re-audit`);
    return ADMIN_EXIT.ok;
  } finally {
    try {
      release();
    } catch {
      // reported above when it mattered
    }
  }
}

/** Convert safeIntegers bigints back to numbers for fingerprint comparison. */
function normalise(facts: TopicFacts): TopicFacts {
  return JSON.parse(
    JSON.stringify(facts, (_key, value) => (typeof value === "bigint" ? Number(value) : value)),
  ) as TopicFacts;
}
