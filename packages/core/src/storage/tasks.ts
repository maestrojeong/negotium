import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "#platform/config";
import { logger } from "#platform/logger";
import { sanitizeFileName } from "#security/sanitize";
import type { TaskSnapshot } from "#types";

/**
 * Otium-owned task store, shared by every agent backend.
 *
 * Provider-native task/todo stores are not authoritative because they live
 * inside one SDK session. This store is keyed by Otium topic context so task
 * state survives agent switches and feeds the same live task panel for
 * claude/codex/maestro.
 */
export type StoredTask = TaskSnapshot;

export const TASK_STATUS_VALUES = ["pending", "in_progress", "completed"] as const;

interface TaskFileShape {
  version: 1;
  tasks: StoredTask[];
}

function safeUserIdComponent(userId: number | string): string {
  const str = String(userId);
  if (!str || /[/\\]|\.\./.test(str)) {
    throw new Error(`tasks: refusing unsafe userId path component: ${str}`);
  }
  return str;
}

function safeTaskScopeKey(scopeKey: string): string {
  const safe = sanitizeFileName(scopeKey);
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`tasks: refusing unsafe scope key: ${scopeKey}`);
  }
  return safe;
}

export function taskScopeKey(opts: { topicId?: string; session: string }): string {
  return opts.topicId?.trim() || opts.session || "default";
}

export function getTaskFilePath(userId: number | string, scopeKey: string): string {
  return join(DATA_DIR, "tasks", safeUserIdComponent(userId), `${safeTaskScopeKey(scopeKey)}.json`);
}

export function readTasks(userId: number | string, scopeKey: string): StoredTask[] {
  const path = getTaskFilePath(userId, scopeKey);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as TaskFileShape;
    return Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  } catch (e) {
    logger.warn({ err: e, path }, "tasks: failed to read task store");
    return [];
  }
}

export function writeTasks(userId: number | string, scopeKey: string, tasks: StoredTask[]): void {
  const path = getTaskFilePath(userId, scopeKey);
  mkdirSync(dirname(path), { recursive: true });
  const payload: TaskFileShape = { version: 1, tasks };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function taskFileMtimeNs(userId: number | string, scopeKey: string): bigint | null {
  try {
    return statSync(getTaskFilePath(userId, scopeKey), { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}

export interface TaskCreateInput {
  subject: string;
  activeForm?: string;
  blockedBy?: string[];
  owner?: string;
}

export interface TaskUpdateInput {
  id: string;
  status?: StoredTask["status"];
  subject?: string;
  activeForm?: string;
  blockedBy?: string[];
  owner?: string;
}

function nextTaskId(tasks: StoredTask[]): number {
  let max = 0;
  for (const task of tasks) {
    const n = Number(task.id);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

export function createTasks(
  tasks: StoredTask[],
  inputs: TaskCreateInput[],
): { tasks: StoredTask[]; created: StoredTask[] } {
  const out = [...tasks];
  const created: StoredTask[] = [];
  let id = nextTaskId(out);
  for (const input of inputs) {
    const task: StoredTask = {
      id: String(id++),
      subject: input.subject,
      status: "pending",
      ...(input.blockedBy && input.blockedBy.length > 0 ? { blockedBy: input.blockedBy } : {}),
      ...(input.activeForm ? { activeForm: input.activeForm } : {}),
      ...(input.owner ? { owner: input.owner } : {}),
    };
    out.push(task);
    created.push(task);
  }
  return { tasks: out, created };
}

export function updateTasks(
  tasks: StoredTask[],
  updates: TaskUpdateInput[],
): { tasks: StoredTask[]; missing: string[] } {
  const out = tasks.map((task) => ({ ...task }));
  const byId = new Map(out.map((task) => [task.id, task]));
  const missing: string[] = [];
  for (const update of updates) {
    const task = byId.get(update.id);
    if (!task) {
      missing.push(update.id);
      continue;
    }
    if (update.status !== undefined) task.status = update.status;
    if (update.subject !== undefined) task.subject = update.subject;
    if (update.activeForm !== undefined) {
      if (update.activeForm) task.activeForm = update.activeForm;
      else delete task.activeForm;
    }
    if (update.owner !== undefined) {
      if (update.owner) task.owner = update.owner;
      else delete task.owner;
    }
    if (update.blockedBy !== undefined) {
      if (update.blockedBy.length > 0) task.blockedBy = update.blockedBy;
      else delete task.blockedBy;
    }
  }
  return { tasks: out, missing };
}

export function deleteTasks(
  tasks: StoredTask[],
  opts: { ids?: string[]; all?: boolean },
): { tasks: StoredTask[]; removed: number } {
  if (opts.all) return { tasks: [], removed: tasks.length };
  const ids = new Set(opts.ids ?? []);
  const kept = tasks.filter((task) => !ids.has(task.id));
  return { tasks: kept, removed: tasks.length - kept.length };
}

export function renderTaskList(tasks: StoredTask[]): string {
  if (tasks.length === 0) return "작업 목록이 비어 있습니다.";
  const mark = { pending: "[ ]", in_progress: "[->]", completed: "[x]" } as const;
  const lines = tasks.map((task) => {
    const deps =
      task.blockedBy && task.blockedBy.length > 0
        ? ` (blocked by #${task.blockedBy.join(", #")})`
        : "";
    const owner = task.owner ? ` @${task.owner}` : "";
    return `${mark[task.status]} #${task.id} ${task.subject}${deps}${owner}`;
  });
  const done = tasks.filter((task) => task.status === "completed").length;
  return [`Tasks (${done}/${tasks.length} 완료)`, ...lines].join("\n");
}
