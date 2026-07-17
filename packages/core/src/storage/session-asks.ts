import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveStorageSessionAsksDir } from "#storage/storage-host";

export const PENDING_ASK_TTL_MS = 15 * 60 * 1000;

export type PendingAskState =
  | "requested"
  | "reply_ready"
  | "queued_for_caller"
  | "injecting_to_caller";

export type PendingAskUserId = number | string;

export interface PendingAskRecord {
  userId: PendingAskUserId;
  from: string;
  to: string;
  requestId: string;
  contextId?: string;
  state: PendingAskState;
  createdAt: string;
  updatedAt: string;
}

export interface AskReplySource {
  from?: string;
  requestId?: string;
  contextId?: string;
}

export interface PendingAskKey {
  userId: PendingAskUserId;
  from: string;
  to: string;
}

export interface PendingAskIdentity extends PendingAskKey {
  requestId?: string;
}

type AskKey = PendingAskKey;
type AskIdentity = PendingAskIdentity;

function pendingAskDir(userId: PendingAskUserId): string {
  const rawUserId = String(userId);
  const safeUserId =
    /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,255}$/.test(rawUserId) && !rawUserId.includes("..")
      ? rawUserId
      : `sha256-${createHash("sha256").update(rawUserId).digest("hex")}`;
  return join(resolveStorageSessionAsksDir(), safeUserId);
}

const ASK_FILENAME_PREFIX = "v3-";
const V2_ASK_FILENAME_PREFIX = "v2-";

function encodeAskKey(key: Pick<AskKey, "from" | "to">): string {
  return JSON.stringify([key.from, key.to]);
}

function pendingAskPath(key: AskKey): string {
  const digest = createHash("sha256").update(encodeAskKey(key)).digest("hex");
  return join(pendingAskDir(key.userId), `${ASK_FILENAME_PREFIX}${digest}.pending`);
}

function v2PendingAskPath(key: AskKey): string {
  const encoded = Buffer.from(encodeAskKey(key), "utf8").toString("base64url");
  return join(pendingAskDir(key.userId), `${V2_ASK_FILENAME_PREFIX}${encoded}.pending`);
}

function legacyPendingAskPath(key: AskKey): string | null {
  if (
    key.from.includes("/") ||
    key.from.includes("\\") ||
    key.to.includes("/") ||
    key.to.includes("\\") ||
    key.from.includes("\0") ||
    key.to.includes("\0")
  ) {
    return null;
  }
  const dir = pendingAskDir(key.userId);
  const candidate = join(dir, `${key.from}___${key.to}.pending`);
  return dirname(candidate) === dir ? candidate : null;
}

function parsePendingAskFilename(fileName: string): { from: string; to: string } | null {
  if (!fileName.endsWith(".pending")) return null;
  const raw = fileName.slice(0, -".pending".length);
  if (raw.startsWith(V2_ASK_FILENAME_PREFIX)) {
    try {
      const decoded = JSON.parse(
        Buffer.from(raw.slice(V2_ASK_FILENAME_PREFIX.length), "base64url").toString("utf8"),
      ) as unknown;
      if (
        Array.isArray(decoded) &&
        decoded.length === 2 &&
        decoded.every((part) => typeof part === "string")
      ) {
        return { from: decoded[0], to: decoded[1] };
      }
    } catch {
      // A legacy caller key may itself start with "v2-". Fall through to the
      // delimiter parser when the suffix is not a valid v2 payload.
    }
  }

  // Read files created before the opaque v2 key was introduced.
  const sep = raw.indexOf("___");
  if (sep < 0) return null;
  return { from: raw.slice(0, sep), to: raw.slice(sep + 3) };
}

function readPendingAskFile(path: string, fallback: AskKey): PendingAskRecord | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    if (!raw.startsWith("{")) {
      const ts = new Date(statSync(path).mtimeMs).toISOString();
      return {
        userId: fallback.userId,
        from: fallback.from,
        to: fallback.to,
        requestId: raw,
        state: "requested",
        createdAt: ts,
        updatedAt: ts,
      };
    }
    const parsed = JSON.parse(raw) as Partial<PendingAskRecord>;
    if (!parsed.requestId || !parsed.from || !parsed.to) return null;
    if (parsed.userId !== undefined && String(parsed.userId) !== String(fallback.userId))
      return null;
    if (fallback.from && parsed.from !== fallback.from) return null;
    if (fallback.to && parsed.to !== fallback.to) return null;
    const now = new Date().toISOString();
    return {
      // The directory selected by the caller is authoritative. Never let a
      // tampered record redirect a later migration/update into another user root.
      userId: fallback.userId,
      from: parsed.from,
      to: parsed.to,
      requestId: parsed.requestId,
      contextId: parsed.contextId,
      state: parsed.state ?? "requested",
      createdAt: parsed.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? now,
    };
  } catch {
    return null;
  }
}

function isStale(record: PendingAskRecord | null, path: string): boolean {
  const ts = record ? Date.parse(record.updatedAt || record.createdAt) : Number.NaN;
  if (Number.isFinite(ts)) return Date.now() - ts > PENDING_ASK_TTL_MS;
  try {
    return Date.now() - statSync(path).mtimeMs > PENDING_ASK_TTL_MS;
  } catch {
    return false;
  }
}

function writePendingAsk(record: PendingAskRecord): void {
  const path = pendingAskPath(record);
  mkdirSync(pendingAskDir(record.userId), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

function writePendingAskIfAbsent(record: PendingAskRecord): boolean {
  const path = pendingAskPath(record);
  mkdirSync(pendingAskDir(record.userId), { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx");
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readPendingAsk(key: AskKey): { path: string; record: PendingAskRecord } | null {
  const canonicalPath = pendingAskPath(key);
  const canonical = readPendingAskFile(canonicalPath, key);
  if (canonical && canonical.from === key.from && canonical.to === key.to) {
    return { path: canonicalPath, record: canonical };
  }

  for (const compatibilityPath of [v2PendingAskPath(key), legacyPendingAskPath(key)]) {
    if (!compatibilityPath) continue;
    const legacy = readPendingAskFile(compatibilityPath, key);
    if (!legacy || legacy.from !== key.from || legacy.to !== key.to) continue;

    const migrated = writePendingAskIfAbsent(legacy);
    const next = migrated ? legacy : readPendingAskFile(canonicalPath, key);
    if (next && next.from === key.from && next.to === key.to) {
      try {
        unlinkSync(compatibilityPath);
      } catch {
        // The canonical record is durable; concurrent cleanup may win.
      }
      return { path: canonicalPath, record: next };
    }

    // Never discard a valid compatibility record when a corrupt or racing
    // canonical file cannot be trusted.
    return { path: compatibilityPath, record: legacy };
  }

  return null;
}

export function createPendingAsk(args: {
  userId: PendingAskUserId;
  from: string;
  to: string;
  requestId: string;
  contextId?: string;
}):
  | { ok: true; record: PendingAskRecord }
  | { ok: false; existing: PendingAskRecord | null; stale: boolean } {
  const migrated = readPendingAsk(args);
  if (migrated && !isStale(migrated.record, migrated.path)) {
    return { ok: false, existing: migrated.record, stale: false };
  }
  if (migrated) {
    try {
      unlinkSync(migrated.path);
    } catch {
      return { ok: false, existing: migrated.record, stale: true };
    }
  }
  const path = pendingAskPath(args);
  const now = new Date().toISOString();
  const record: PendingAskRecord = {
    userId: args.userId,
    from: args.from,
    to: args.to,
    requestId: args.requestId,
    contextId: args.contextId,
    state: "requested",
    createdAt: now,
    updatedAt: now,
  };

  mkdirSync(pendingAskDir(args.userId), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "wx");
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      return { ok: true, record };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = readPendingAskFile(path, args);
      if (!isStale(existing, path)) return { ok: false, existing, stale: false };
      try {
        unlinkSync(path);
      } catch {
        return { ok: false, existing, stale: true };
      }
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }

  return { ok: false, existing: readPendingAskFile(path, args), stale: true };
}

export function markPendingAskState(
  args: AskIdentity & { state: PendingAskState },
): PendingAskRecord | null {
  const pending = readPendingAsk(args);
  if (!pending) return null;
  const record = pending.record;
  if (args.requestId && record.requestId !== args.requestId) return record;
  const next = {
    ...record,
    state: args.state,
    updatedAt: new Date().toISOString(),
  };
  writePendingAsk(next);
  if (pending.path !== pendingAskPath(next)) {
    try {
      unlinkSync(pending.path);
    } catch {
      // The canonical v3 record already contains the update.
    }
  }
  return next;
}

export function clearPendingAsk(args: AskIdentity): boolean {
  const pending = readPendingAsk(args);
  const path = pending?.path ?? pendingAskPath(args);
  const record = pending?.record ?? null;
  if (args.requestId && record && record.requestId !== args.requestId) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function markPendingAskSources(args: {
  userId: PendingAskUserId;
  callerTopic: string;
  sources?: AskReplySource[];
  state: PendingAskState;
}): void {
  for (const source of args.sources ?? []) {
    if (!source.from) continue;
    markPendingAskState({
      userId: args.userId,
      from: args.callerTopic,
      to: source.from,
      requestId: source.requestId,
      state: args.state,
    });
  }
}

export function clearPendingAskSources(args: {
  userId: PendingAskUserId;
  callerTopic: string;
  sources?: AskReplySource[];
}): void {
  for (const source of args.sources ?? []) {
    if (!source.from) continue;
    clearPendingAsk({
      userId: args.userId,
      from: args.callerTopic,
      to: source.from,
      requestId: source.requestId,
    });
  }
}

export function listPendingAsksForCaller(args: {
  userId: PendingAskUserId;
  from: string;
}): PendingAskRecord[] {
  const dir = pendingAskDir(args.userId);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  const records = new Map<string, PendingAskRecord>();
  for (const fileName of files) {
    const isV3 = fileName.startsWith(ASK_FILENAME_PREFIX);
    const parsed = isV3 ? { from: args.from, to: "" } : parsePendingAskFilename(fileName);
    if (!parsed) continue;
    const path = join(dir, fileName);
    const record = readPendingAskFile(path, {
      userId: args.userId,
      from: parsed.from,
      to: parsed.to,
    });
    if (!record || record.from !== args.from) continue;
    if (isStale(record, path)) {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort stale cleanup only.
      }
      continue;
    }
    const canonical = readPendingAsk(record);
    if (!canonical || canonical.record.from !== args.from) continue;
    if (path !== canonical.path) {
      try {
        unlinkSync(path);
      } catch {
        // Canonical record wins; duplicate compatibility cleanup is best effort.
      }
    }
    if (isStale(canonical.record, canonical.path)) {
      try {
        unlinkSync(canonical.path);
      } catch {
        // Best-effort stale cleanup only.
      }
      continue;
    }
    records.set(encodeAskKey(canonical.record), canonical.record);
  }
  return [...records.values()];
}

/** Remove durable ask edges to or from a topic that no longer exists. */
export function deletePendingAsksForTopic(args: {
  userId: PendingAskUserId;
  topicName: string;
}): number {
  const dir = pendingAskDir(args.userId);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return 0;
  }

  let deleted = 0;
  for (const fileName of files) {
    const path = join(dir, fileName);
    const parsed = parsePendingAskFilename(fileName);
    const record = readPendingAskFile(path, {
      userId: args.userId,
      from: parsed?.from ?? "",
      to: parsed?.to ?? "",
    });
    const from = record?.from ?? parsed?.from;
    const to = record?.to ?? parsed?.to;
    if (from !== args.topicName && to !== args.topicName) continue;
    try {
      unlinkSync(path);
      deleted++;
    } catch {
      // Best-effort teardown; stale cleanup will retry any file that survives.
    }
  }
  return deleted;
}

export function describePendingAskState(state: PendingAskState): string {
  switch (state) {
    case "requested":
      return "대상 세션 처리 중";
    case "reply_ready":
      return "응답 생성 완료, 이 세션 주입 준비 중";
    case "queued_for_caller":
      return "응답 생성 완료, 이 세션 실행 종료 후 주입 대기 중";
    case "injecting_to_caller":
      return "응답을 이 세션에 주입 중";
  }
}
