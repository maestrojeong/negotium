import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { appendJsonlEntry, readJsonlLines } from "#platform/jsonl";
import { logger } from "#platform/logger";
import { sanitizeTopicName } from "#security/sanitize";
import { resolveStorageLogDir, resolveStorageUsersLogDir } from "#storage/storage-host";
import type { TokenUsage } from "#types";

// --- Log rotation config ---
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per log file
const MAX_TOTAL_SIZE = 200 * 1024 * 1024; // 200MB total log budget
const ROTATION_CHECK_INTERVAL = 60 * 60 * 1000; // check every hour
let rotationTimer: ReturnType<typeof setInterval> | null = null;

function startLogRotation(): void {
  if (rotationTimer) return;
  rotateOldLogs();
  rotationTimer = setInterval(rotateOldLogs, ROTATION_CHECK_INTERVAL);
  rotationTimer.unref?.();
}

export interface LogEntry {
  timestamp: string;
  userId: number;
  sessionId: string | null;
  session: string;
  prompt: string;
  response: string;
  usage?: TokenUsage;
}

export function writeLog(entry: LogEntry) {
  startLogRotation();
  const logDir = resolveStorageLogDir();
  mkdirSync(logDir, { recursive: true });
  const safeSession = sanitizeTopicName(entry.session);
  const sidShort = entry.sessionId ? entry.sessionId.slice(0, 8) : "new";
  const file = join(logDir, `${entry.userId}_${safeSession}_${sidShort}.jsonl`);

  // Rotate if file is too large
  try {
    const stat = statSync(file);
    if (stat.size >= MAX_FILE_SIZE) {
      const rotated = file.replace(/\.jsonl$/, `.${Date.now()}.jsonl`);
      renameSync(file, rotated);
    }
  } catch {
    // File doesn't exist yet, fine
  }

  appendJsonlEntry(file, entry);
}

/** Remove oldest log files when total size exceeds budget */
export function rotateOldLogs() {
  const logDir = resolveStorageLogDir();
  mkdirSync(logDir, { recursive: true });
  try {
    const files = readdirSync(logDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        try {
          const stat = statSync(join(logDir, f));
          return { name: f, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize <= MAX_TOTAL_SIZE) return;

    // Delete oldest files first until under budget
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let freed = 0;
    const toFree = totalSize - MAX_TOTAL_SIZE;
    for (const file of files) {
      if (freed >= toFree) break;
      try {
        unlinkSync(join(logDir, file.name));
        freed += file.size;
        logger.info(
          { file: file.name, sizeKB: (file.size / 1024).toFixed(0) },
          "Rotated out old log",
        );
      } catch (e) {
        logger.warn({ err: e, file: file.name }, "Log rotation: failed to delete old log file");
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "Log rotation failed");
  }
}

export interface SentFileEntry {
  timestamp: string;
  userId: number;
  topicName: string;
  sessionId: string | null;
  filePath: string;
  fileName: string;
}

export function writeSentFileLog(entry: Omit<SentFileEntry, "fileName">) {
  const dir = join(resolveStorageUsersLogDir(), String(entry.userId));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sent-files.jsonl");
  try {
    appendJsonlEntry(file, { ...entry, fileName: basename(entry.filePath) });
  } catch (e) {
    logger.warn({ err: e, entry }, "Failed to write sent-file log");
  }
}

function entryMatchesTopic(e: SentFileEntry, topicName: string): boolean {
  return e.topicName === topicName;
}

export function readSentFilesForTopic(userId: number, topicName: string): SentFileEntry[] {
  const file = join(resolveStorageUsersLogDir(), String(userId), "sent-files.jsonl");
  if (!existsSync(file)) return [];
  try {
    return readJsonlLines(file)
      .map((line) => JSON.parse(line) as SentFileEntry)
      .filter((e) => entryMatchesTopic(e, topicName));
  } catch (e) {
    logger.warn({ err: e, userId, topicName }, "Failed to read sent-files log");
    return [];
  }
}

/** 토픽 삭제 후 JSONL에서 해당 토픽 항목 제거 */
export function removeSentFilesForTopic(userId: number, topicName: string): void {
  const file = join(resolveStorageUsersLogDir(), String(userId), "sent-files.jsonl");
  if (!existsSync(file)) return;
  try {
    const remaining = readJsonlLines(file).filter((line) => {
      try {
        return !entryMatchesTopic(JSON.parse(line) as SentFileEntry, topicName);
      } catch {
        return true;
      }
    });
    if (remaining.length > 0) {
      writeFileSync(file, `${remaining.join("\n")}\n`);
    } else {
      unlinkSync(file);
    }
  } catch (e) {
    logger.warn({ err: e, userId, topicName }, "Failed to remove sent-files for topic");
  }
}
