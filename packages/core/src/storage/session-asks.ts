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
import { join } from "node:path";
import { SESSION_ASKS_DIR } from "#platform/config";

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

interface AskKey {
  userId: PendingAskUserId;
  from: string;
  to: string;
}

interface AskIdentity extends AskKey {
  requestId?: string;
}

function pendingAskDir(userId: PendingAskUserId): string {
  return join(SESSION_ASKS_DIR, String(userId));
}

function pendingAskPath(key: AskKey): string {
  return join(pendingAskDir(key.userId), `${key.from}___${key.to}.pending`);
}

function parsePendingAskFilename(fileName: string): { from: string; to: string } | null {
  if (!fileName.endsWith(".pending")) return null;
  const raw = fileName.slice(0, -".pending".length);
  const sep = raw.indexOf("___");
  if (sep < 0) return null;
  return {
    from: raw.slice(0, sep),
    to: raw.slice(sep + 3),
  };
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
    const now = new Date().toISOString();
    return {
      userId: parsed.userId ?? fallback.userId,
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

export function createPendingAsk(args: {
  userId: PendingAskUserId;
  from: string;
  to: string;
  requestId: string;
  contextId?: string;
}):
  | { ok: true; record: PendingAskRecord }
  | { ok: false; existing: PendingAskRecord | null; stale: boolean } {
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
  const path = pendingAskPath(args);
  const record = readPendingAskFile(path, args);
  if (!record) return null;
  if (args.requestId && record.requestId !== args.requestId) return record;
  const next = {
    ...record,
    state: args.state,
    updatedAt: new Date().toISOString(),
  };
  writePendingAsk(next);
  return next;
}

export function clearPendingAsk(args: AskIdentity): boolean {
  const path = pendingAskPath(args);
  const record = readPendingAskFile(path, args);
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

  const records: PendingAskRecord[] = [];
  for (const fileName of files) {
    const parsed = parsePendingAskFilename(fileName);
    if (!parsed || parsed.from !== args.from) continue;
    const path = join(dir, fileName);
    const record = readPendingAskFile(path, {
      userId: args.userId,
      from: parsed.from,
      to: parsed.to,
    });
    if (!record) continue;
    if (isStale(record, path)) {
      try {
        unlinkSync(path);
      } catch {
        // Best-effort stale cleanup only.
      }
      continue;
    }
    records.push(record);
  }
  return records;
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
