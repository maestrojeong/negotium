/**
 * The hub's offline link-audit report (otium `scripts/link-audit`,
 * `reportVersion: 1`) as delete/repair EVIDENCE — bound to this node's live
 * store and to one moment (review finding 1).
 *
 * The report itself names no node id or dbEpoch (only `inputs[]` with the
 * sha256 of each input copy and `options.nodeIdentityProvided`). So the
 * binding chain is:
 *
 *   report bytes ── sha256 == --report-sha256 (the SAME bytes are parsed)
 *     └ inputs[role=node, cellKey=--hub-cell].sha256/sizeBytes
 *         == sha256/size of --audit-node-copy (the snapshot the audit read)
 *           └ api_node_identity(node_id, epoch_id) of that snapshot
 *               == --expect-node-id / --expect-db-epoch
 *               == api_node_identity of the LIVE DB
 *
 * plus freshness (`generatedAt` within --max-report-age, not in the future).
 * Mapped-ness is only ever read from the report entry for that exact topic id;
 * a topic the report does not list is `unknown`, which every guard refuses.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { reportRejected, usage } from "./errors";
import { type NodeIdentity, readNodeIdentity, requireNodeSchema } from "./facts";
import { createPrivateCopy, type PrivateCopy } from "./private-copy";

export const DEFAULT_MAX_REPORT_AGE_MS = 24 * 60 * 60_000;
const MAX_REPORT_AGE_CAP_MS = 7 * 24 * 60 * 60_000;
/** Tolerated clock skew for a `generatedAt` slightly in the future. */
const FUTURE_SKEW_MS = 5 * 60_000;
const MAX_REPORT_BYTES = 256 * 1024 * 1024;

export interface ReportBindingOptions {
  reportPath: string;
  reportSha256: string;
  auditNodeCopy: string;
  expectNodeId: string;
  expectDbEpoch: string;
  hubCell: string;
  maxAgeMs: number;
  now?: number;
}

export function parseMaxAge(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_REPORT_AGE_MS;
  const match = /^([1-9]\d{0,6})(s|m|h|d)$/.exec(value);
  if (!match) usage(`--max-report-age must look like 90m, 24h or 2d (got ${value})`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s"];
  const ms = Number(match[1]) * unit;
  if (ms > MAX_REPORT_AGE_CAP_MS) usage("--max-report-age may be at most 7d");
  return ms;
}

export interface D7Member {
  id: string;
  createdAt?: string;
  mapped: boolean;
  otiumTopicId: string | null;
  messageCount: number | null;
  owners?: string[];
}

export interface D7Group {
  owner: string;
  scope: string | null;
  members: D7Member[];
}

export interface D6Row {
  id: string;
  kind: string;
  surfaceScope: string | null;
  isSubagent: boolean;
  parentTopicId: string | null;
  createdAt: string;
  messageCount: number | null;
  owners: string[];
  titleHash: string | null;
}

export interface D2Row {
  id: string;
  kind: string;
  createdAt: string;
  parentTopicId: string | null;
  otiumTopicId: string;
  titleHash: string | null;
}

export interface D3Summary {
  status: string;
  scopes: string[];
  ambiguousScope: boolean;
  conflictingCandidateIds: string[];
}

export type Mapping =
  | { state: "mapped"; otiumTopicId: string }
  | { state: "unmapped" }
  | { state: "unknown"; reason: string };

export interface BoundReport {
  path: string;
  sha256: string;
  generatedAt: string;
  ageMs: number;
  cellKey: string;
  identity: { nodeId: string; dbEpoch: string };
  /** Private copy of --audit-node-copy (the exact snapshot the audit analysed). */
  auditCopy: PrivateCopy;
  truncated: (check: string) => boolean;
  d7Groups(): D7Group[];
  d7GroupsFor(topicId: string): D7Group[];
  d6Row(topicId: string): D6Row | null;
  d2Row(topicId: string): D2Row | null;
  d3(): D3Summary | null;
  mapping(topicId: string): Mapping;
  close(): void;
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Read the whole file once through one descriptor (no symlink, regular file). */
function readReportBytes(path: string): Buffer {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    return reportRejected(
      `cannot open --hub-report ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) reportRejected(`--hub-report ${path} is not a regular file`);
    if (stat.size > MAX_REPORT_BYTES) reportRejected(`--hub-report ${path} is too large`);
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    if (offset !== bytes.length) reportRejected(`--hub-report ${path} changed while being read`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function loadBoundReport(opts: ReportBindingOptions, live: NodeIdentity): BoundReport {
  if (!isHex64(opts.reportSha256)) {
    usage("--report-sha256 must be the 64-char lowercase sha256 of the report file");
  }
  if (!opts.expectNodeId || !opts.expectDbEpoch) {
    usage("--expect-node-id and --expect-db-epoch are required with --hub-report");
  }
  const path = resolve(opts.reportPath);
  const bytes = readReportBytes(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== opts.reportSha256) {
    reportRejected(`--hub-report sha256 is ${sha256}, not --report-sha256 ${opts.reportSha256}`);
  }
  let parsed: Json;
  try {
    parsed = asObject(JSON.parse(bytes.toString("utf8"))) ?? {};
  } catch (error) {
    return reportRejected(
      `--hub-report is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.tool !== "link-audit" || parsed.reportVersion !== 1) {
    reportRejected("--hub-report is not a link-audit reportVersion 1 file");
  }
  const generatedAt = str(parsed.generatedAt);
  const generatedMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (!generatedAt || Number.isNaN(generatedMs)) reportRejected("report has no valid generatedAt");
  const now = opts.now ?? Date.now();
  const ageMs = now - generatedMs;
  if (ageMs < -FUTURE_SKEW_MS) reportRejected(`report generatedAt ${generatedAt} is in the future`);
  if (ageMs > opts.maxAgeMs) {
    reportRejected(
      `report generatedAt ${generatedAt} is ${Math.round(ageMs / 60_000)} min old (> --max-report-age); run a fresh audit`,
    );
  }

  const inputs = Array.isArray(parsed.inputs) ? parsed.inputs.map(asObject) : [];
  const nodeInputs = inputs.filter(
    (input): input is Json => input?.role === "node" && str(input.cellKey) === opts.hubCell,
  );
  if (nodeInputs.length !== 1) {
    reportRejected(
      `report has ${nodeInputs.length} node input(s) for cell ${JSON.stringify(opts.hubCell)}; expected exactly 1 (--hub-cell)`,
    );
  }
  const nodeInput = nodeInputs[0] as Json;
  const inputSha = str(nodeInput.sha256);
  if (!inputSha || !isHex64(inputSha)) reportRejected("report node input has no sha256");

  const auditCopy = createPrivateCopy(resolve(opts.auditNodeCopy), { requireNoSidecars: true });
  try {
    if (auditCopy.mainSha256 !== inputSha || auditCopy.mainSize !== nodeInput.sizeBytes) {
      reportRejected(
        `--audit-node-copy (sha256 ${auditCopy.mainSha256}) is not the node snapshot this report was generated from (${inputSha})`,
      );
    }
    requireNodeSchema(auditCopy.db, "--audit-node-copy");
    const audited = readNodeIdentity(auditCopy.db);
    const expect = { nodeId: opts.expectNodeId, dbEpoch: opts.expectDbEpoch };
    for (const [label, identity] of [
      ["audit node snapshot", audited],
      ["live node DB", live],
    ] as const) {
      if (identity.nodeId !== expect.nodeId || identity.dbEpoch !== expect.dbEpoch) {
        reportRejected(
          `${label} identity (node ${identity.nodeId ?? "NULL"}, epoch ${identity.dbEpoch ?? "NULL"}) != --expect-node-id ${expect.nodeId} / --expect-db-epoch ${expect.dbEpoch}`,
        );
      }
    }
  } catch (error) {
    auditCopy.close();
    throw error;
  }

  const checks = asObject(parsed.checks) ?? {};
  const cellSuffix = `[${opts.hubCell}]`;
  const check = (id: string): Json | null => asObject(checks[`${id}${cellSuffix}`]);
  const rows = (id: string): Json[] => {
    const value = check(id);
    const list = Array.isArray(value?.rows) ? (value.rows as unknown[]) : [];
    return list
      .map(asObject)
      .filter((row): row is Json => row !== null && str(row.cellKey) === opts.hubCell);
  };
  const truncated = (id: string): boolean => {
    const value = check(id);
    return !value || value.status !== "ok" || value.truncated !== false;
  };

  const d7: D7Group[] = rows("D7").map((group) => ({
    owner: str(group.owner) ?? "",
    scope: str(group.scope),
    members: (Array.isArray(group.members) ? group.members : [])
      .map(asObject)
      .filter((member): member is Json => member !== null && str(member.id) !== null)
      .map((member) => ({
        id: member.id as string,
        createdAt: str(member.createdAt) ?? undefined,
        mapped: member.mapped === true,
        otiumTopicId: str(member.otiumTopicId),
        messageCount: numOrNull(member.messageCount),
        ...(Array.isArray(member.owners)
          ? {
              owners: (member.owners as unknown[]).filter(
                (o): o is string => typeof o === "string",
              ),
            }
          : {}),
      })),
  }));
  const d6 = new Map<string, D6Row>();
  for (const id of ["D6.manager", "D6.nonManager"]) {
    for (const row of rows(id)) {
      const topicId = str(row.id);
      if (!topicId) continue;
      d6.set(topicId, {
        id: topicId,
        kind: str(row.kind) ?? "",
        surfaceScope: str(row.surfaceScope),
        isSubagent: row.isSubagent === true,
        parentTopicId: str(row.parentTopicId),
        createdAt: str(row.createdAt) ?? "",
        messageCount: numOrNull(row.messageCount),
        owners: Array.isArray(row.owners)
          ? (row.owners as unknown[]).filter((o): o is string => typeof o === "string")
          : [],
        titleHash: str(row.titleHash),
      });
    }
  }
  const d2 = new Map<string, D2Row>();
  for (const row of rows("D2")) {
    const topicId = str(row.id);
    const otiumTopicId = str(row.otiumTopicId);
    if (!topicId || !otiumTopicId) continue;
    d2.set(topicId, {
      id: topicId,
      kind: str(row.kind) ?? "",
      createdAt: str(row.createdAt) ?? "",
      parentTopicId: str(row.parentTopicId),
      otiumTopicId,
      titleHash: str(row.titleHash),
    });
  }
  const d3check = check("D3");

  return {
    path,
    sha256,
    generatedAt: generatedAt as string,
    ageMs,
    cellKey: opts.hubCell,
    identity: { nodeId: opts.expectNodeId, dbEpoch: opts.expectDbEpoch },
    auditCopy,
    truncated,
    d7Groups: () => d7,
    d7GroupsFor: (topicId) => d7.filter((group) => group.members.some((m) => m.id === topicId)),
    d6Row: (topicId) => d6.get(topicId) ?? null,
    d2Row: (topicId) => d2.get(topicId) ?? null,
    d3: () =>
      d3check
        ? {
            status: str(d3check.status) ?? "",
            scopes: Array.isArray(d3check.scopes)
              ? (d3check.scopes as unknown[]).filter((s): s is string => typeof s === "string")
              : [],
            ambiguousScope: d3check.ambiguousScope !== false,
            conflictingCandidateIds: Array.isArray(d3check.conflictingCandidateIds)
              ? (d3check.conflictingCandidateIds as unknown[]).filter(
                  (s): s is string => typeof s === "string",
                )
              : [],
          }
        : null,
    mapping(topicId) {
      const members = d7.flatMap((group) => group.members.filter((m) => m.id === topicId));
      const says = new Set<string>();
      for (const member of members) {
        says.add(
          member.mapped && member.otiumTopicId ? `mapped:${member.otiumTopicId}` : "unmapped",
        );
      }
      if (d2.has(topicId)) says.add(`mapped:${d2.get(topicId)?.otiumTopicId}`);
      if (d6.has(topicId)) says.add("unmapped");
      if (says.size === 0) {
        return { state: "unknown", reason: "the report has no entry for this exact topic id" };
      }
      if (says.size > 1) {
        return {
          state: "unknown",
          reason: `the report is inconsistent (${[...says].join(" vs ")})`,
        };
      }
      const only = [...says][0] as string;
      return only === "unmapped"
        ? { state: "unmapped" }
        : { state: "mapped", otiumTopicId: only.slice("mapped:".length) };
    },
    close: () => auditCopy.close(),
  };
}

export function describeMapping(mapping: Mapping | null): string {
  if (!mapping) return "unknown (no --hub-report)";
  if (mapping.state === "mapped") return `mapped -> ${mapping.otiumTopicId}`;
  if (mapping.state === "unmapped") return "unmapped";
  return `unknown (${mapping.reason})`;
}

/** Report titles are hashed (`sha256(title)[:12]`, link-audit `titleHash`). */
export function titleHash(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 12);
}

export { readNodeIdentity };
