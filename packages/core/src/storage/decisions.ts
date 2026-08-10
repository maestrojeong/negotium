import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "#platform/logger";
import { sanitizeFileName } from "#security/sanitize";
import { resolveStorageDataDir } from "#storage/storage-host";
import type { AgentKind, DecisionSnapshot } from "#types";

export type StoredDecision = DecisionSnapshot;

export const DECISION_STATUS_VALUES = [
  "proposed",
  "accepted",
  "executed",
  "rejected",
  "superseded",
] as const;

interface DecisionFileShape {
  version: 1;
  decisions: StoredDecision[];
}

function safeDecisionScopeKey(scopeKey: string): string {
  const safe = sanitizeFileName(scopeKey);
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`decisions: refusing unsafe scope key: ${scopeKey}`);
  }
  return safe;
}

export function decisionScopeKey(opts: { topicId?: string; session: string }): string {
  return opts.topicId?.trim() || opts.session || "default";
}

export function getDecisionFilePath(userId: number | string, scopeKey: string): string {
  void userId;
  return join(resolveStorageDataDir(), "decisions", `${safeDecisionScopeKey(scopeKey)}.json`);
}

export function getDecisionGraphSvgPath(userId: number | string, scopeKey: string): string {
  void userId;
  return join(
    resolveStorageDataDir(),
    "decision-renders",
    safeDecisionScopeKey(scopeKey),
    "latest.svg",
  );
}

export function writeDecisionGraphSvg(
  userId: number | string,
  scopeKey: string,
  svg: string,
): string {
  const path = getDecisionGraphSvgPath(userId, scopeKey);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, svg, "utf-8");
  renameSync(tmp, path);
  return path;
}

export function readDecisions(userId: number | string, scopeKey: string): StoredDecision[] {
  const path = getDecisionFilePath(userId, scopeKey);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DecisionFileShape;
    return Array.isArray(parsed?.decisions) ? parsed.decisions : [];
  } catch (error) {
    logger.warn({ err: error, path }, "decisions: failed to read decision store");
    return [];
  }
}

export function writeDecisions(
  userId: number | string,
  scopeKey: string,
  decisions: StoredDecision[],
): void {
  const path = getDecisionFilePath(userId, scopeKey);
  mkdirSync(dirname(path), { recursive: true });
  const payload: DecisionFileShape = { version: 1, decisions };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  renameSync(tmp, path);
}

export interface DecisionCreateInput {
  action: string;
  reasoning: string;
  agent: AgentKind;
  model?: string;
  status?: StoredDecision["status"];
  causedBy?: string[];
  timestamp?: number;
}

export interface DecisionUpdateInput {
  id: string;
  action?: string;
  reasoning?: string;
  status?: StoredDecision["status"];
  causedBy?: string[];
}

function nextDecisionId(decisions: StoredDecision[]): number {
  let max = 0;
  for (const decision of decisions) {
    const id = Number(decision.id);
    if (Number.isInteger(id) && id > max) max = id;
  }
  return max + 1;
}

function normalizedIds(ids: string[] | undefined): string[] | undefined {
  if (!ids) return undefined;
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  return unique.length > 0 ? unique : undefined;
}

export function validateDecisionGraph(decisions: StoredDecision[]): void {
  const ids = new Set(decisions.map((decision) => decision.id));
  for (const decision of decisions) {
    for (const upstream of decision.causedBy ?? []) {
      if (!ids.has(upstream)) {
        throw new Error(`Decision #${decision.id} references missing decision #${upstream}.`);
      }
      if (upstream === decision.id) {
        throw new Error(`Decision #${decision.id} cannot cause itself.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Decision graph contains a cycle at #${id}.`);
    visiting.add(id);
    for (const upstream of byId.get(id)?.causedBy ?? []) visit(upstream);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

export function createDecisions(
  decisions: StoredDecision[],
  inputs: DecisionCreateInput[],
): { decisions: StoredDecision[]; created: StoredDecision[] } {
  const out = [...decisions];
  const created: StoredDecision[] = [];
  let id = nextDecisionId(out);
  for (const input of inputs) {
    const decision: StoredDecision = {
      id: String(id++),
      action: input.action.trim(),
      reasoning: input.reasoning.trim(),
      agent: input.agent,
      status: input.status ?? "accepted",
      timestamp: input.timestamp ?? Date.now(),
      ...(input.model ? { model: input.model } : {}),
      ...(normalizedIds(input.causedBy) ? { causedBy: normalizedIds(input.causedBy) } : {}),
    };
    out.push(decision);
    created.push(decision);
  }
  validateDecisionGraph(out);
  return { decisions: out, created };
}

export function updateDecisions(
  decisions: StoredDecision[],
  updates: DecisionUpdateInput[],
): { decisions: StoredDecision[]; missing: string[] } {
  const out = decisions.map((decision) => ({
    ...decision,
    ...(decision.causedBy ? { causedBy: [...decision.causedBy] } : {}),
  }));
  const byId = new Map(out.map((decision) => [decision.id, decision]));
  const missing: string[] = [];
  for (const update of updates) {
    const decision = byId.get(update.id);
    if (!decision) {
      missing.push(update.id);
      continue;
    }
    if (update.action !== undefined) decision.action = update.action.trim();
    if (update.reasoning !== undefined) decision.reasoning = update.reasoning.trim();
    if (update.status !== undefined) decision.status = update.status;
    if (update.causedBy !== undefined) {
      const ids = normalizedIds(update.causedBy);
      if (ids) decision.causedBy = ids;
      else delete decision.causedBy;
    }
  }
  validateDecisionGraph(out);
  return { decisions: out, missing };
}

export function deleteDecisions(
  decisions: StoredDecision[],
  opts: { ids?: string[]; all?: boolean },
): { decisions: StoredDecision[]; removed: number } {
  if (opts.all) return { decisions: [], removed: decisions.length };
  const ids = new Set(opts.ids ?? []);
  const kept = decisions
    .filter((decision) => !ids.has(decision.id))
    .map((decision) => {
      const causedBy = decision.causedBy?.filter((id) => !ids.has(id));
      const next = { ...decision };
      if (causedBy && causedBy.length > 0) next.causedBy = causedBy;
      else delete next.causedBy;
      return next;
    });
  return { decisions: kept, removed: decisions.length - kept.length };
}

export function renderDecisionList(decisions: StoredDecision[]): string {
  if (decisions.length === 0) return "Decisions (0 recorded)";
  return [
    `Decisions (${decisions.length} recorded)`,
    ...decisions.map((decision) => {
      const causes = decision.causedBy?.length
        ? ` <- ${decision.causedBy.map((id) => `#${id}`).join(", ")}`
        : "";
      return `[${decision.status}] #${decision.id} ${decision.action}${causes}\n  ${decision.reasoning}`;
    }),
  ].join("\n");
}
