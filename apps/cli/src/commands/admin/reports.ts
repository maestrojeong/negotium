/**
 * Read-only reports: `list-managers` and `owners-report`. Both run on a
 * private copy of the DB (see private-copy.ts) and never touch the live files.
 */

import { GENERAL_TOPIC_ID, messageCount, ownersOf, type SqlDb, tableExists } from "./facts";
import { type BoundReport, describeMapping, type Mapping } from "./hub-report";

const NO_OWNER = "<none>";

function display(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : value;
}

export interface ManagerEntry {
  topicId: string;
  owners: string[];
  surface: string | null;
  surfaceScope: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  hub: Mapping | null;
  /** What `getManagerTopicForUser(owner, surface, {surfaceScope})` returns (created_at ASC). */
  resolvesForGroup: boolean;
}

export interface ManagerGroup {
  owner: string;
  surface: string | null;
  surfaceScope: string | null;
  managers: ManagerEntry[];
  duplicate: boolean;
  ownerHasOtherScopes: boolean;
}

export interface ListManagersReport {
  surface: string;
  groups: ManagerGroup[];
  totals: {
    managers: number;
    unscoped: number;
    multiOwner: number;
    unmapped: number;
    unmappedWithMessages: number;
    duplicateGroups: number;
  };
}

export function listManagers(
  db: SqlDb,
  opts: { surface: string; report: BoundReport | null },
): ListManagersReport {
  const filter = opts.surface === "all" ? "" : " AND surface = ?";
  const rows = db
    .query(
      `SELECT id, surface, surface_scope, created_at, last_message_at FROM api_topics
       WHERE kind = 'manager' AND id != ?${filter} ORDER BY created_at, id`,
    )
    .all(
      ...(opts.surface === "all" ? [GENERAL_TOPIC_ID] : [GENERAL_TOPIC_ID, opts.surface]),
    ) as Array<{
    id: string;
    surface: string | null;
    surface_scope: string | null;
    created_at: string;
    last_message_at: string | null;
  }>;
  const groups = new Map<string, ManagerGroup>();
  const managers: ManagerEntry[] = [];
  for (const row of rows) {
    const owners = ownersOf(db, row.id);
    const entry: ManagerEntry = {
      topicId: row.id,
      owners,
      surface: row.surface,
      surfaceScope: row.surface_scope,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      messageCount: messageCount(db, row.id),
      hub: opts.report ? opts.report.mapping(row.id) : null,
      resolvesForGroup: false,
    };
    managers.push(entry);
    for (const owner of owners.length > 0 ? owners : [NO_OWNER]) {
      const key = JSON.stringify([owner, row.surface, row.surface_scope]);
      const group = groups.get(key) ?? {
        owner,
        surface: row.surface,
        surfaceScope: row.surface_scope,
        managers: [],
        duplicate: false,
        ownerHasOtherScopes: false,
      };
      group.managers.push(entry);
      groups.set(key, group);
    }
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      a.owner.localeCompare(b.owner) ||
      display(a.surface).localeCompare(display(b.surface)) ||
      display(a.surfaceScope).localeCompare(display(b.surfaceScope)),
  );
  for (const group of ordered) {
    group.duplicate = group.managers.length > 1;
    const first = group.managers[0];
    if (first && group.owner !== NO_OWNER) first.resolvesForGroup = true;
    group.ownerHasOtherScopes = ordered.some(
      (other) =>
        other !== group &&
        other.owner === group.owner &&
        other.surface === group.surface &&
        other.surfaceScope !== group.surfaceScope,
    );
  }
  const unmapped = managers.filter((m) => m.hub?.state === "unmapped");
  return {
    surface: opts.surface,
    groups: ordered,
    totals: {
      managers: managers.length,
      unscoped: managers.filter((m) => m.surfaceScope === null).length,
      multiOwner: managers.filter((m) => m.owners.length !== 1).length,
      unmapped: unmapped.length,
      unmappedWithMessages: unmapped.filter((m) => m.messageCount > 0).length,
      duplicateGroups: ordered.filter((g) => g.duplicate).length,
    },
  };
}

export function renderListManagers(report: ListManagersReport, hub: BoundReport | null): string[] {
  const t = report.totals;
  const lines = [
    `manager topics (surface=${report.surface}): ${t.managers} total, ${t.unscoped} unscoped (surface_scope NULL), ${t.duplicateGroups} duplicate group(s), ${t.multiOwner} not single-owner`,
    hub
      ? `hub mapping from ${hub.path} (sha256 ${hub.sha256.slice(0, 16)}…, generated ${hub.generatedAt}, cell ${JSON.stringify(hub.cellKey)}, node ${hub.identity.nodeId}): ${t.unmapped} unmapped, ${t.unmappedWithMessages} unmapped WITH messages (never deletable)`
      : "hub mapping: unknown (pass --hub-report with its binding flags)",
  ];
  for (const group of report.groups) {
    const flags = [
      group.duplicate ? "DUPLICATE" : null,
      group.ownerHasOtherScopes ? "OWNER-HAS-OTHER-SCOPE" : null,
    ]
      .filter(Boolean)
      .join(",");
    lines.push("");
    lines.push(
      `owner=${group.owner} surface=${display(group.surface)} scope=${display(group.surfaceScope)}${flags ? `  [${flags}]` : ""}`,
    );
    for (const m of group.managers) {
      lines.push(
        `  ${m.topicId}  created=${m.createdAt}  messages=${m.messageCount}  last=${m.lastMessageAt ?? "-"}  hub=${describeMapping(m.hub)}${m.resolvesForGroup ? "  <- resolves" : ""}${m.owners.length > 1 ? `  owners=${m.owners.join(",")}` : ""}`,
      );
    }
  }
  return lines;
}

export interface OwnersEntry {
  topicId: string;
  kind: string;
  surface: string | null;
  surfaceScope: string | null;
  title?: string;
  owners: string[];
  memberCount: number;
  messageCount: number;
  createdAt: string;
  hub: Mapping | null;
}

export function ownersReport(
  db: SqlDb,
  opts: { report: BoundReport | null; includeTitles: boolean },
): OwnersEntry[] {
  if (!tableExists(db, "topic_members")) return [];
  const rows = db
    .query(
      `SELECT t.id, t.title, t.kind, t.surface, t.surface_scope, t.created_at,
              SUM(CASE WHEN m.role = 'owner' THEN 1 ELSE 0 END) AS owner_count,
              COUNT(*) AS member_count
       FROM api_topics t JOIN topic_members m ON m.topic_id = t.id
       GROUP BY t.id HAVING owner_count > 1
       ORDER BY t.surface, t.surface_scope, t.created_at, t.id`,
    )
    .all() as Array<{
    id: string;
    title: string;
    kind: string;
    surface: string | null;
    surface_scope: string | null;
    created_at: string;
    member_count: number;
  }>;
  return rows.map((row) => ({
    topicId: row.id,
    kind: row.kind,
    surface: row.surface,
    surfaceScope: row.surface_scope,
    ...(opts.includeTitles ? { title: row.title } : {}),
    owners: ownersOf(db, row.id),
    memberCount: Number(row.member_count),
    messageCount: messageCount(db, row.id),
    createdAt: row.created_at,
    hub: opts.report ? opts.report.mapping(row.id) : null,
  }));
}

export function renderOwnersReport(entries: OwnersEntry[]): string[] {
  const lines = [`topics with more than one owner: ${entries.length}`];
  const byOwners = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.owners.join(" + ");
    byOwners.set(key, (byOwners.get(key) ?? 0) + 1);
  }
  for (const [owners, n] of byOwners) lines.push(`  ${n} x owners {${owners}}`);
  for (const entry of entries) {
    lines.push(
      `  ${entry.topicId}  kind=${entry.kind}  surface=${display(entry.surface)}  scope=${display(entry.surfaceScope)}  owners=${entry.owners.join(",")}  members=${entry.memberCount}  messages=${entry.messageCount}  hub=${describeMapping(entry.hub)}${entry.title !== undefined ? `  title=${JSON.stringify(entry.title)}` : ""}`,
    );
  }
  return lines;
}
