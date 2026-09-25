/**
 * `negotium admin scope-repair --topic ID … --expect-scope WS` — file
 * unscoped otium rooms into the workspace the hub report proves they belong
 * to (design v2 §4.6 / §6.3 M2; review finding 3).
 *
 * - The ONLY writer is PR7's `adminRepairOtiumTopicScope` (NULL → scope, CAS
 *   on the observed row, audited in `api_topic_scope_moves`, claims NOT
 *   re-bound). This tool never writes `surface_scope` itself; PR7's
 *   `api_topics_otium_scope_immutable` trigger would refuse it anyway.
 * - The target scope is not an operator choice: the topic must be a D2 row
 *   (mapped, still unscoped) of the bound report, and the report's D3 check
 *   must name exactly one unambiguous scope. `--expect-scope` must equal it.
 * - Refused up front with the primitive's own rules mirrored: not otium,
 *   scope not NULL, title conflict (any otium room with the same
 *   LOWER(TRIM(title)) in the target scope — this includes other Generals and
 *   the retired `general` row — or between listed topics), maintenance fence.
 *   Plus: the retired `general` row itself, a non-manager room titled
 *   `general` (reserved: core resolves that title to the retired row), a
 *   manager that is not single-owner, whose report D7 entry (owner, NULL
 *   scope, mapped, message count) does not match, or whose owner already has a
 *   General in the target scope (D7 duplicate).
 * - All listed topics are repaired in ONE outer `BEGIN IMMEDIATE` transaction
 *   (the primitive joins it); any refusal rolls every topic back.
 * - Irreversible: a repaired scope is immutable. There is no revert command.
 */

import { userInfo } from "node:os";
import {
  type AuditEntry,
  assertNodeStoppedOffline,
  type CoreHandle,
  journalMarkCommitted,
  journalPrepared,
  journalSetPhase,
  newRunId,
  takeVerifiedBackup,
  writeAudit,
} from "./apply-env";
import type { ApplyFaults } from "./delete-manager";
import {
  ADMIN_EXIT,
  AdminError,
  type AdminExitCode,
  errorMessage,
  notFound,
  refuse,
} from "./errors";
import {
  fingerprint,
  GENERAL_TOPIC_ID,
  getTopicRow,
  maintenanceActive,
  readNodeIdentity,
  type SqlDb,
  type TopicFacts,
  tableExists,
  topicFacts,
} from "./facts";
import { type BoundReport, titleHash } from "./hub-report";
import type { NodePaths } from "./paths";
import type { PrivateCopy } from "./private-copy";
import type { FsSeam, SafeDir } from "./safe-fs";

function display(value: string | null): string {
  return value === null ? "NULL" : value;
}

export interface ScopeRepairItem {
  topicId: string;
  facts: TopicFacts;
  otiumTopicId: string | null;
  claimsLeft: number;
  refusals: string[];
  pin: string;
}

export interface ScopeRepairPlan {
  targetScope: string | null;
  items: ScopeRepairItem[];
  refusals: string[];
}

function titleKey(db: SqlDb, title: string): string {
  return (db.query("SELECT LOWER(TRIM(?)) AS k").get(title) as { k: string }).k;
}

export function planScopeRepair(
  db: SqlDb,
  topicIds: readonly string[],
  opts: { report: BoundReport | null; expectScope: string; now?: number },
): ScopeRepairPlan {
  const { report } = opts;
  const refusals: string[] = [];
  let targetScope: string | null = null;
  if (!report) {
    refusals.push(
      "--hub-report (with its binding flags) is required: it is the evidence for the target scope",
    );
  } else {
    for (const check of ["D2", "D3"]) {
      if (report.truncated(check))
        refusals.push(`report check ${check}[${report.cellKey}] is skipped or truncated`);
    }
    const d3 = report.d3();
    if (!d3 || d3.status !== "ok" || d3.scopes.length !== 1 || d3.ambiguousScope) {
      refusals.push(
        `report D3[${report.cellKey}] does not name exactly one unambiguous scope (${JSON.stringify(d3?.scopes ?? [])}); re-run the audit with --scope`,
      );
    } else {
      targetScope = d3.scopes[0] as string;
      if (targetScope !== opts.expectScope) {
        refusals.push(
          `--expect-scope ${opts.expectScope} is not the report's scope ${targetScope}`,
        );
      }
    }
  }

  const items: ScopeRepairItem[] = topicIds.map((topicId) => {
    const facts = topicFacts(db, topicId);
    if (!facts)
      notFound(
        `topic ${JSON.stringify(topicId)} not found (ids are exact: no prefix, case or trim)`,
      );
    const claimsLeft = tableExists(db, "api_topic_create_claims")
      ? Number(
          db
            .query(
              "SELECT COUNT(*) AS n FROM api_topic_create_claims WHERE topic_id = ? AND state = 'committed'",
            )
            .get(topicId)?.n ?? 0,
        )
      : 0;
    return {
      topicId,
      facts,
      otiumTopicId: null,
      claimsLeft,
      refusals: [],
      pin: fingerprint(facts),
    };
  });

  for (const item of items) {
    const { row } = item.facts;
    const r = item.refusals;
    if (item.topicId === GENERAL_TOPIC_ID)
      r.push("the retired shared `general` row is never re-scoped");
    if (row.surface !== "otium") r.push(`not_otium: surface is ${display(row.surface)}`);
    if (row.surfaceScope !== null) {
      r.push(
        `scope_not_null: already in scope ${row.surfaceScope} (an otium scope is immutable once set)`,
      );
    }
    if (maintenanceActive(db, item.topicId, opts.now))
      r.push("maintenance_in_progress: a live maintenance fence holds the topic");
    if (report) {
      const d2 = report.d2Row(item.topicId);
      if (!d2) {
        r.push(
          "no D2 evidence: the report does not list this exact id as a mapped, unscoped room (unmapped rooms have no scope evidence)",
        );
      } else {
        item.otiumTopicId = d2.otiumTopicId;
        const mismatch = [
          d2.kind !== row.kind ? `kind ${d2.kind}≠${row.kind}` : null,
          d2.createdAt !== row.createdAt ? `createdAt ${d2.createdAt}≠${row.createdAt}` : null,
          d2.parentTopicId !== row.parentTopicId ? "parentTopicId" : null,
          d2.titleHash !== null && d2.titleHash !== titleHash(row.title) ? "titleHash" : null,
        ].filter(Boolean);
        if (mismatch.length > 0)
          r.push(`report D2 row disagrees with the live row (${mismatch.join(", ")})`);
        const mapping = report.mapping(item.topicId);
        if (mapping.state !== "mapped")
          r.push(`report is inconsistent about this topic (${mapping.state})`);
        if (row.kind === "manager") {
          // A General is also a D7 member: same owner, still unscoped, mapped to
          // the same hub room, with the live message count.
          const owner = item.facts.owners.length === 1 ? item.facts.owners[0] : null;
          const member = owner
            ? report
                .d7Groups()
                .find((g) => g.owner === owner && g.scope === null)
                ?.members.find((m) => m.id === item.topicId)
            : undefined;
          if (
            !member?.mapped ||
            member.otiumTopicId !== d2.otiumTopicId ||
            member.messageCount !== item.facts.messages ||
            member.owners
          ) {
            r.push(
              `report D7 has no matching (owner ${owner ?? "?"}, scope NULL) entry for this General (mapped -> ${d2.otiumTopicId}, ${item.facts.messages} messages)`,
            );
          }
        }
      }
      if (report.d3()?.conflictingCandidateIds.includes(item.topicId)) {
        r.push("report D3 lists a title conflict for this topic in the target scope");
      }
      if (fingerprint(topicFacts(report.auditCopy.db, item.topicId)) !== item.pin) {
        r.push("topic changed since the audit snapshot; re-run the audit");
      }
    }
    if (row.kind !== "manager" && titleKey(db, row.title) === GENERAL_TOPIC_ID) {
      // Core resolves the title `general` to the retired shared row
      // (api-topics.ts findTopicTitleConflict); a room titled so would be shadowed.
      r.push("title_conflict: the title `general` is reserved for the retired shared row");
    }
    if (targetScope !== null) {
      // The primitive's own title rule: ANY otium room, any kind.
      const conflicts = (
        db
          .query(
            `SELECT id FROM api_topics
             WHERE LOWER(TRIM(title)) = LOWER(TRIM(?)) AND surface = 'otium' AND surface_scope IS ?
               AND id != ? ORDER BY id`,
          )
          .all(row.title, targetScope, item.topicId) as Array<{ id: string }>
      ).map((c) => c.id);
      for (const id of conflicts)
        r.push(`title_conflict with ${id} in scope ${targetScope} (the primitive refuses this)`);
      const key = titleKey(db, row.title);
      for (const peer of items) {
        if (peer !== item && titleKey(db, peer.facts.row.title) === key) {
          r.push(
            `title_conflict with listed topic ${peer.topicId} (both would land in ${targetScope})`,
          );
        }
      }
      if (row.kind === "manager") {
        if (item.facts.owners.length !== 1) {
          r.push(`manager has ${item.facts.owners.length} owners; exactly one is required`);
        }
        for (const owner of item.facts.owners) {
          const dup = db
            .query(
              `SELECT t.id FROM api_topics t JOIN topic_members m ON m.topic_id = t.id
               WHERE t.kind = 'manager' AND t.surface = 'otium' AND t.surface_scope IS ?
                 AND m.user_id = ? AND m.role = 'owner' AND t.id != ? LIMIT 1`,
            )
            .get(targetScope, owner, item.topicId) as { id: string } | null;
          if (dup)
            r.push(
              `owner ${owner} already has General ${dup.id} in ${targetScope} (would create a D7 duplicate)`,
            );
          for (const peer of items) {
            if (
              peer !== item &&
              peer.facts.row.kind === "manager" &&
              peer.facts.owners.includes(owner)
            ) {
              r.push(
                `owner ${owner} has another listed General ${peer.topicId}; both would land in ${targetScope}`,
              );
            }
          }
        }
      }
    }
  }
  return { targetScope, items, refusals };
}

export function scopePlanApplicable(plan: ScopeRepairPlan): boolean {
  return (
    plan.targetScope !== null &&
    plan.refusals.length === 0 &&
    plan.items.every((i) => i.refusals.length === 0)
  );
}

export function renderScopeRepairPlan(plan: ScopeRepairPlan, includeTitles: boolean): string[] {
  const lines = [
    `scope-repair plan: surface_scope NULL -> ${display(plan.targetScope)} for ${plan.items.length} topic(s), via adminRepairOtiumTopicScope only`,
    "  IRREVERSIBLE: a repaired otium scope is immutable (PR7 trigger); there is no revert command",
  ];
  for (const refusal of plan.refusals) lines.push(`  REFUSED: ${refusal}`);
  for (const item of plan.items) {
    const title = includeTitles
      ? `  title=${JSON.stringify(item.facts.row.title)}`
      : `  titleHash=${titleHash(item.facts.row.title)}`;
    lines.push(
      `  ${item.refusals.length ? "SKIP " : "WRITE"} ${item.topicId}  kind=${item.facts.row.kind}  scope ${display(item.facts.row.surfaceScope)} -> ${display(plan.targetScope)}  owners=${item.facts.owners.join(",") || "-"}  messages=${item.facts.messages}  hub=${item.otiumTopicId ?? "-"}  claimsLeft=${item.claimsLeft}${title}`,
    );
    for (const refusal of item.refusals) lines.push(`        refused: ${refusal}`);
  }
  if (plan.items.some((i) => i.claimsLeft > 0)) {
    lines.push(
      "  note: committed create claims stay on their original principal (not re-bound); replays from another scope answer 409 claim_topic_moved",
    );
  }
  return lines;
}

export interface ScopeApplyContext {
  plan: ScopeRepairPlan;
  topicIds: readonly string[];
  expectScope: string;
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

function requireSame(live: ScopeRepairPlan, planned: ScopeRepairPlan): void {
  const pins = (plan: ScopeRepairPlan) =>
    JSON.stringify([plan.targetScope, plan.items.map((i) => i.pin)]);
  if (pins(live) !== pins(planned)) {
    throw new AdminError(ADMIN_EXIT.drift, "rows changed since the plan; nothing was changed");
  }
  if (!scopePlanApplicable(live)) {
    refuse(
      `live re-check refused: ${[...live.refusals, ...live.items.flatMap((i) => i.refusals.map((r) => `${i.topicId}: ${r}`))].join("; ")}`,
    );
  }
}

export async function applyScopeRepair(ctx: ScopeApplyContext): Promise<AdminExitCode> {
  const { plan, report } = ctx;
  const target = plan.targetScope as string;
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
        `this shell's NODE_ID (${handle.nodeId}) is not --expect-node-id ${report.identity.nodeId}`,
      );
    }
    const identity = readNodeIdentity(db);
    if (
      identity.nodeId !== report.identity.nodeId ||
      identity.dbEpoch !== report.identity.dbEpoch
    ) {
      throw new AdminError(
        ADMIN_EXIT.reportRejected,
        "live node identity/epoch no longer matches the report binding",
      );
    }
    const replan = () =>
      planScopeRepair(db, ctx.topicIds, { report, expectScope: ctx.expectScope });
    requireSame(replan(), plan);

    const backup = takeVerifiedBackup(db, ctx.backupDir, "scope-repair", ctx.fsSeam, (copy) => {
      for (const item of plan.items) {
        const row = getTopicRow(copy as unknown as SqlDb, item.topicId);
        if (!row || row.surfaceScope !== null || row.createdAt !== item.facts.row.createdAt) {
          refuse(`backup does not hold ${item.topicId} as planned`);
        }
      }
    });
    ctx.out(
      `backup: ${backup.path} (sha256 ${backup.sha256}, ${backup.sizeBytes} bytes, fsynced + verified)`,
    );

    const runId = newRunId("scope-repair");
    journalPrepared(db, {
      runId,
      command: "scope-repair",
      targets: plan.items.map((i) => i.topicId),
      backup,
      reportSha256: report.sha256,
      detail: { toScope: target, reportGeneratedAt: report.generatedAt },
    });
    ctx.out(`journal: admin_operation_journal run_id=${runId} phase=prepared`);
    ctx.faults.afterPrepared?.();

    const moves: Array<{ topicId: string; moveSeq: number; claimsLeft: number }> = [];
    const actor = `negotium-admin:${safeUser()}`;
    try {
      db.transaction(() => {
        requireSame(replan(), plan);
        const audit: AuditEntry[] = [];
        for (const item of plan.items) {
          const result = handle.core.adminRepairOtiumTopicScope({
            topicId: item.topicId,
            fromScope: null,
            toScope: target,
            expectedRow: {
              surface: "otium",
              surfaceScope: null,
              createdAt: item.facts.row.createdAt,
              title: item.facts.row.title,
            },
            actor,
            reason: `negotium admin scope-repair run ${runId}; hub report sha256 ${report.sha256}; hub room ${item.otiumTopicId}`,
          });
          if (!result.ok) {
            throw new AdminError(
              ADMIN_EXIT.refused,
              `adminRepairOtiumTopicScope refused ${item.topicId}: ${result.reason}${result.detail ? ` (${result.detail})` : ""}; every topic was rolled back`,
            );
          }
          moves.push({
            topicId: item.topicId,
            moveSeq: result.moveSeq,
            claimsLeft: result.claimsLeft,
          });
          audit.push({
            runId,
            command: "scope-repair",
            entity: "api_topics",
            entityId: item.topicId,
            field: "surface_scope",
            oldValue: null,
            newValue: target,
            detail: {
              moveSeq: result.moveSeq,
              claimsLeft: result.claimsLeft,
              otiumTopicId: item.otiumTopicId,
              backup: backup.path,
            },
          });
        }
        journalMarkCommitted(db, runId);
        writeAudit(db, audit);
        ctx.faults.beforeCommit?.();
      }).immediate();
    } catch (error) {
      journalSetPhase(db, runId, "aborted", errorMessage(error));
      ctx.err(`NOT APPLIED: run ${runId} rolled back; no scope was changed`);
      throw error;
    }

    ctx.out(
      `COMMITTED run=${runId} surface_scope NULL -> ${target}: ${moves.map((m) => `${m.topicId} (move seq ${m.moveSeq}, claimsLeft ${m.claimsLeft})`).join(", ")}`,
    );
    try {
      ctx.faults.afterCommit?.();
      for (const move of moves) {
        if (getTopicRow(db, move.topicId)?.surfaceScope !== target) {
          throw new Error(`${move.topicId} does not read back scope ${target}`);
        }
      }
      release();
      journalSetPhase(db, runId, "done");
    } catch (error) {
      journalSetPhase(db, runId, "followup_failed", errorMessage(error));
      ctx.err(
        `APPLIED, follow-up failed: run ${runId}: ${errorMessage(error)}. The repair IS committed and cannot be reverted; inspect admin_operation_journal/api_topic_scope_moves for ${runId}`,
      );
      return ADMIN_EXIT.appliedFollowUpFailed;
    }
    ctx.out(
      `done: run ${runId}. The scope is now immutable; restart the node, hub full reconcile, re-audit`,
    );
    return ADMIN_EXIT.ok;
  } finally {
    try {
      release();
    } catch {
      // reported above when it mattered
    }
  }
}

function safeUser(): string {
  try {
    return userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_") || "operator";
  } catch {
    return "operator";
  }
}
