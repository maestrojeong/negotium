import { listActiveMemoryArchiverSessions } from "#agents/archiver";
import { getTopic } from "#storage/api-topics";
import { listRecentRuntimeEventsForTopic } from "#storage/runtime-events";
import { listRuntimeTurnLeases } from "#storage/runtime-leases";
import { isParticipant } from "#topics/derive";
import type { BackgroundSessionDto } from "#types/api";
import { COMPLETED_BACKGROUND_SESSION_RETENTION_MS } from "./background-session-policy";

export type BackgroundSessionProvider = (userId: string) => BackgroundSessionDto[];

const providers = new Set<BackgroundSessionProvider>();
interface TransientBackgroundSessionRecord extends BackgroundSessionDto {
  userId: string;
  expiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

const transientSessions = new Map<string, TransientBackgroundSessionRecord>();

export interface TransientBackgroundSessionHandle {
  id: string;
  update(status: string, step?: string): void;
  setOutput(output: string): void;
  finish(status?: string, step?: string): void;
}

export function beginTransientBackgroundSession(
  userId: string,
  session: Omit<BackgroundSessionDto, "id" | "startedAt" | "steps"> & {
    id: string;
    steps?: string[];
    retentionMs?: number;
  },
): TransientBackgroundSessionHandle {
  const { retentionMs = COMPLETED_BACKGROUND_SESSION_RETENTION_MS, ...sessionFields } = session;
  const record = {
    ...sessionFields,
    userId,
    startedAt: new Date().toISOString(),
    active: true,
    steps: [...(session.steps ?? [])],
  };
  const previous = transientSessions.get(record.id);
  if (previous?.expiryTimer) clearTimeout(previous.expiryTimer);
  transientSessions.set(record.id, record);
  let finished = false;
  return {
    id: record.id,
    update(status, step) {
      if (finished) return;
      const current = transientSessions.get(record.id);
      if (current !== record) return;
      const nextStatus = text(status, 160);
      if (nextStatus) current.status = nextStatus;
      const nextStep = text(step);
      if (nextStep && current.steps.at(-1) !== nextStep) {
        current.steps.push(nextStep);
      }
    },
    setOutput(output) {
      if (finished) return;
      const current = transientSessions.get(record.id);
      if (current !== record) return;
      current.output = output;
    },
    finish(status, step) {
      if (finished) return;
      this.update(status ?? record.status, step);
      finished = true;
      const current = transientSessions.get(record.id);
      if (current !== record) return;
      current.active = false;
      current.expiresAt = Date.now() + Math.max(0, retentionMs);
      current.expiryTimer = setTimeout(
        () => {
          if (transientSessions.get(record.id) === record) transientSessions.delete(record.id);
        },
        Math.max(0, retentionMs),
      );
      current.expiryTimer.unref?.();
    },
  };
}

export function registerBackgroundSessionProvider(provider: BackgroundSessionProvider): () => void {
  providers.add(provider);
  return () => providers.delete(provider);
}

function text(value: unknown, maxLen?: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return maxLen === undefined ? normalized : normalized.slice(0, maxLen);
}

function byteSize(value: unknown): string {
  const bytes = Buffer.byteLength(typeof value === "string" ? value : "");
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function compactPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const normalized = value.trim().replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : normalized;
}

function compactToolLabel(value: string): string {
  const match = value.match(/^([^()]+)\((.*)\)$/);
  return match ? `${match[1]} · ${match[2]}` : value;
}

/**
 * Build a richer single-line tool step, mirroring the detail level of
 * `toolTimelineText` in the terminal adapter.
 */
function detailedToolStep(payload: Record<string, unknown>): string {
  const name = String(payload.name ?? "tool");
  const shortName = name.split("__").at(-1)?.toLowerCase() ?? name.toLowerCase();
  const input =
    payload.input && typeof payload.input === "object"
      ? (payload.input as Record<string, unknown>)
      : {};
  const path = compactPath(input.file_path ?? input.path ?? input.file_id);
  const label = compactToolLabel(String(payload.label ?? name));

  if (shortName === "ask_session" || shortName === "tell_session") {
    const target = typeof input.to === "string" && input.to.trim() ? input.to.trim() : "session";
    const msg = typeof input.message === "string" ? text(input.message) : "";
    const action = shortName === "ask_session" ? "Ask" : "Tell";
    return `${action} ${target}${msg ? ` — ${msg}` : ""}`;
  }
  if (shortName === "edit" || shortName === "write" || shortName === "delete") {
    const action = shortName === "edit" ? "Edit" : shortName === "write" ? "Write" : "Delete";
    if (path) {
      const before = typeof input.before === "string" ? input.before : "";
      const after = typeof input.after === "string" ? input.after : "";
      if (before || after) {
        const added = after.split("\n").filter(Boolean).length;
        const removed = before.split("\n").filter(Boolean).length;
        return `${action} ${path} (+${added} -${removed})`;
      }
      return `${action} ${path}`;
    }
  }
  if (shortName === "read" || shortName === "view") {
    const action = shortName === "read" ? "Read" : "View";
    if (path) return `${action} ${path}`;
    return `${action} file`;
  }
  if (shortName === "grep" || shortName === "glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const action = shortName === "grep" ? "Grep" : "Glob";
    if (pattern) return `${action} '${text(pattern)}'${path ? ` in ${path}` : ""}`;
    if (path) return `${action} ${path}`;
  }
  if (shortName === "bash") {
    const cmd = typeof input.command === "string" ? text(input.command) : "";
    return cmd ? `Bash: ${cmd}` : "Bash";
  }
  if (shortName === "webfetch" || shortName === "url_fetch") {
    const url = typeof input.url === "string" ? text(input.url) : "";
    return url ? `Fetch ${url}` : "WebFetch";
  }
  return label;
}

export function backgroundSessionProgress(
  topicId: string,
  queryId: string,
): { status: string; steps: string[] } {
  let status = "Running";
  const steps: string[] = [];
  const toolNames = new Map<string, string>();
  for (const event of listRecentRuntimeEventsForTopic(topicId, 2_000)) {
    if (event.type !== "ai-status") continue;
    const payload = event.payload as Record<string, unknown>;
    if (payload.queryId !== queryId) continue;
    const kind = payload.kind;
    let step = "";
    if (kind === "ai_active") step = "Scheduled turn started";
    else if (kind === "reasoning") step = `Reasoning: ${text(payload.content)}`;
    else if (kind === "tool_call") {
      const toolUseId = text(payload.toolUseId);
      const toolName = text(payload.name) || "Tool";
      if (toolUseId) toolNames.set(toolUseId, toolName.split("__").at(-1) ?? toolName);
      step = detailedToolStep(payload);
    } else if (kind === "tool_status") step = text(payload.content);
    else if (kind === "tool_output") {
      const toolName = toolNames.get(text(payload.toolUseId)) ?? "Tool";
      step = payload.isError
        ? `${toolName} failed: ${text(payload.content) || "unknown error"}`
        : `${toolName} result · ${byteSize(payload.content)}`;
    } else if (kind === "ai_done") {
      const usage =
        payload.usage && typeof payload.usage === "object"
          ? (payload.usage as Record<string, unknown>)
          : undefined;
      const input = typeof usage?.input === "number" ? usage.input.toLocaleString() : "";
      const output = typeof usage?.output === "number" ? usage.output.toLocaleString() : "";
      step =
        input || output
          ? `Scheduled turn completed · ${input || "0"} in / ${output || "0"} out`
          : "Scheduled turn completed";
      status = "Completed";
    } else if (kind === "ai_error") {
      step = `Scheduled turn failed: ${text(payload.error) || "unknown error"}`;
      status = "Failed";
    } else if (kind === "ai_aborted") {
      const reason = text(payload.reason);
      step = `Scheduled turn stopped${reason ? ` · ${reason}` : ""}`;
      status = "Stopped";
    }
    if (step && steps.at(-1) !== step) steps.push(step);
    if (step && kind !== "ai_done" && kind !== "ai_error" && kind !== "ai_aborted") status = step;
  }
  return { status, steps };
}

export function listBackgroundSessionsForUser(userId: string): BackgroundSessionDto[] {
  const memory = listActiveMemoryArchiverSessions(userId);
  const now = Date.now();
  for (const [id, session] of transientSessions) {
    if (session.expiresAt !== undefined && session.expiresAt <= now) {
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      transientSessions.delete(id);
    }
  }
  const transient = [...transientSessions.values()]
    .filter((session) => session.userId === userId)
    .map(({ userId: _userId, expiresAt: _expiresAt, expiryTimer: _expiryTimer, ...session }) => ({
      ...session,
      steps: [...session.steps],
    }));
  const provided = [...providers].flatMap((provider) => provider(userId));
  const providedCronTopicIds = new Set(
    provided
      .filter((session) => session.kind === "cron")
      .map((session) => session.topicId)
      .filter((topicId): topicId is string => Boolean(topicId)),
  );
  const cron = listRuntimeTurnLeases()
    .filter((lease) => lease.origin.startsWith("cron:"))
    .flatMap((lease): BackgroundSessionDto[] => {
      const topic = getTopic(lease.topicId);
      if (!topic || !isParticipant(topic, userId) || providedCronTopicIds.has(lease.topicId)) {
        return [];
      }
      const progress = backgroundSessionProgress(lease.topicId, lease.queryId);
      return [
        {
          id: `cron:${lease.queryId}`,
          kind: "cron",
          title: topic.title,
          topicId: topic.id,
          startedAt: new Date(lease.startedAt).toISOString(),
          status: lease.abortRequested ? "Stopping" : progress.status,
          active: true,
          agent: topic.agent,
          model: topic.effectiveModel ?? topic.defaultModel,
          effort: topic.effectiveEffort ?? topic.defaultEffort,
          steps: progress.steps,
        },
      ];
    });
  return [...memory, ...transient, ...provided, ...cron].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
}
