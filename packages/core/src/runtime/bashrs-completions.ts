/**
 * bash-rs completion watcher — turns `result.json` files written by the Rust
 * `bash-rs` background-bash daemon into session-inbox `tell`s, the same way
 * `background-bash-server.ts` used to call `injectMessage()` directly.
 *
 * Why a watcher instead of bash-rs calling back into negotium: bash-rs is a
 * standalone project (github.com/maestrojeong/bash-rs-mcp, sibling of
 * browser-rs-mcp) that knows nothing about topics/session-inbox/turns — it
 * only ever appends `{bash_id}/meta.json` (on spawn) and `{bash_id}/result.json`
 * (on completion) under `BASHRS_SPILL_ROOT`, and never reads or deletes
 * either. Any consumer, negotium or otherwise, watches that directory the
 * same way `runtime/inbox.ts` already watches the session-inbox itself:
 * `fs.watch` + a fallback poll, at-least-once, dedup by a stable id.
 *
 * `owner` on the wire is `${userId}\0${topicId}` — see
 * `platform/mcp-config.ts::backgroundBashTransport` for what negotium sends
 * as `X-Background-Bash-User`/`X-Background-Bash-Topic`, and bash-rs's own
 * `security.rs::resolve_identity` for the matching NUL-join on the other end.
 */

import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { debouncedFlush, FALLBACK_INTERVAL_MS, watchDir } from "#outbox/utils";
import { BASHRS_SPILL_ROOT } from "#platform/config";
import { appendJsonlEntry } from "#platform/jsonl";
import { logger } from "#platform/logger";
import { sessionInboxPath } from "#query/session-inbox-path";
import {
  acquireRuntimeProcessLease,
  PROCESS_LEASE_HEARTBEAT_MS,
  type RuntimeProcessLeaseHandle,
} from "#storage/runtime-process-leases";

/**
 * Where a finished background job's turn is delivered.
 *
 * The default appends to negotium's own session inbox. An embedding host that
 * owns a different inbox installs its own sink here — otium, for one, resolves
 * `RUN_DIR` to its own state dir and runs its own inbox worker, so writing to
 * negotium's path would drop the turn on the floor rather than deliver it.
 * Mirrors the `setFileHooks()` seam in `runtime/file-hooks.ts`.
 *
 * A sink must throw to signal failure: the caller leaves `result.json` in
 * place so the next sweep retries, which is what keeps delivery at-least-once.
 */
export interface BashrsCompletion {
  userId: string;
  topicId: string;
  /** Stable per-job id; use it to collapse a retried delivery into one turn. */
  bashId: string;
  message: string;
}

export type BashrsCompletionSink = (completion: BashrsCompletion) => void;

const defaultSink: BashrsCompletionSink = ({ userId, topicId, bashId, message }) => {
  appendJsonlEntry(sessionInboxPath(userId, topicId), {
    type: "tell",
    from: "__bg_bash__",
    message,
    depth: 0,
    requestId: bashId,
    timestamp: new Date().toISOString(),
  });
};

let completionSink: BashrsCompletionSink = defaultSink;

/** Install a host's delivery sink, or pass null to restore the default. */
export function setBashrsCompletionSink(sink: BashrsCompletionSink | null): void {
  completionSink = sink ?? defaultSink;
}

const PROCESS_ROLE = "worker:bashrs-completions";
/** How long a delivered job's spill dir (logs + result.json.injected) is kept
 * around before being swept — mirrors the TS server's own
 * `COMPLETED_RETENTION_MS`, for the same reason: a reader might still be
 * mid-way through fetching a spill path out of the injected message. */
const RETENTION_MS = 15 * 60_000;
/** Read at most this many trailing bytes of stdout.log/stderr.log into the
 * injected message — full output stays on disk at the path we report. */
const TAIL_BYTES = 8 * 1024;

interface JobResult {
  bash_id: string;
  owner: string;
  exit_code: number | null;
  finished_at_ms: number;
  matched_line: string | null;
  /**
   * Which arm ended a watch. Absent for a plain background run, and absent
   * from results written by bash-rs before v0.1.4 — those fall back to the
   * generic completion notice.
   */
  watch_outcome?: "matched" | "timeout" | "exited";
  unknown: boolean;
}

function isJobResult(value: unknown): value is JobResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.bash_id === "string" && typeof v.owner === "string";
}

function readTail(filePath: string): { text: string; truncated: boolean } {
  try {
    const { size } = statSync(filePath);
    const fd = openSync(filePath, "r");
    try {
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return { text: buf.toString("utf8"), truncated: start > 0 };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { text: "", truncated: false };
  }
}

function buildMessage(dir: string, result: JobResult): string {
  const stdout = readTail(join(dir, "stdout.log"));
  const stderr = readTail(join(dir, "stderr.log"));
  const parts: string[] = [];
  if (stdout.text.trim() || stdout.truncated) {
    parts.push(
      `stdout${stdout.truncated ? ` (truncated, full output: ${join(dir, "stdout.log")})` : ""}:\n${stdout.text.trim()}`,
    );
  }
  if (stderr.text.trim() || stderr.truncated) {
    parts.push(
      `stderr${stderr.truncated ? ` (truncated, full output: ${join(dir, "stderr.log")})` : ""}:\n${stderr.text.trim()}`,
    );
  }
  const header = watchHeader(result) ?? `[background_bash ${result.bash_id} finished]`;
  const exitLine = result.unknown
    ? "exit code: unknown (bash-rs restarted while this job was running)"
    : `exit code: ${result.exit_code ?? "unknown"}`;
  return `${header}\n${exitLine}\n${parts.join("\n") || "(no output)"}`;
}

/**
 * A watch promises exactly one turn, and which outcome produced it is the
 * whole point of the notice: "timed out" and "exited before matching" mean
 * opposite things about whether the condition is still coming.
 */
function watchHeader(result: JobResult): string | null {
  if (result.matched_line) {
    return `[background_bash_watch ${result.bash_id} matched]\nmatched line: ${result.matched_line.slice(0, 500)}`;
  }
  if (result.watch_outcome === "timeout") {
    return `[background_bash_watch ${result.bash_id} timed out without a match]`;
  }
  if (result.watch_outcome === "exited") {
    return `[background_bash_watch ${result.bash_id} exited before matching]`;
  }
  return null;
}

function parseOwner(owner: string): { userId: string; topicId: string } | null {
  const nul = owner.indexOf("\0");
  if (nul < 0) return null;
  const userId = owner.slice(0, nul);
  const topicId = owner.slice(nul + 1);
  if (!userId || !topicId) return null;
  return { userId, topicId };
}

function injectedMarker(dir: string): string {
  return join(dir, "result.json.injected");
}

/** One sweep: deliver any new `result.json`, then reap old delivered jobs. */
export async function flushBashrsCompletions(): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(BASHRS_SPILL_ROOT);
  } catch {
    return; // Nothing spawned yet.
  }

  const now = Date.now();
  for (const bashId of entries) {
    const dir = join(BASHRS_SPILL_ROOT, bashId);
    const resultPath = join(dir, "result.json");
    const marker = injectedMarker(dir);

    // Already delivered: sweep once the retention window has passed.
    try {
      const markerStat = statSync(marker);
      if (now - markerStat.mtimeMs > RETENTION_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
      continue;
    } catch {
      // No marker yet — fall through to try delivering it.
    }

    let raw: string;
    try {
      raw = readFileSync(resultPath, "utf8");
    } catch {
      continue; // Job still running, or not a bash-rs dir at all.
    }

    let result: unknown;
    try {
      result = JSON.parse(raw);
    } catch (err) {
      logger.warn({ err, dir }, "bashrs-completions: corrupt result.json, skipping");
      continue;
    }
    if (!isJobResult(result)) {
      logger.warn({ dir }, "bashrs-completions: result.json missing bash_id/owner, skipping");
      continue;
    }

    const parsed = parseOwner(result.owner);
    if (!parsed) {
      // Not negotium's convention (e.g. clawgram's bare-topic owner, or a
      // standalone curl user) — nothing for this watcher to do with it.
      continue;
    }

    try {
      // The stable bash_id is carried through so at-least-once delivery on
      // either side — this watcher crashing before the rename, or the sink's
      // own retry semantics — collapses to one turn rather than several.
      completionSink({
        userId: parsed.userId,
        topicId: parsed.topicId,
        bashId: result.bash_id,
        message: buildMessage(dir, result),
      });
      renameSync(resultPath, marker);
      logger.info(
        { bashId: result.bash_id, userId: parsed.userId, topicId: parsed.topicId },
        "bashrs-completions: delivered",
      );
    } catch (err) {
      // Leave result.json in place — the next sweep retries. At-least-once,
      // same as every other outbox in this codebase.
      logger.warn({ err, dir }, "bashrs-completions: delivery failed, will retry");
    }
  }
}

let watcher: ReturnType<typeof watchDir> | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let debouncedTrigger: (() => void) | null = null;
let leadershipTimer: ReturnType<typeof setInterval> | null = null;
let workerLease: RuntimeProcessLeaseHandle | null = null;
let workerStarted = false;

function stopLeaderResources(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  debouncedTrigger = null;
}

function tryBecomeLeader(): void {
  if (!workerStarted || workerLease) return;
  const acquired = acquireRuntimeProcessLease(PROCESS_ROLE, {
    onLost: () => {
      if (workerLease !== acquired) return;
      workerLease = null;
      stopLeaderResources();
      logger.warn("bashrs-completions: worker leadership lost");
    },
  });
  if (!acquired) return;

  workerLease = acquired;
  debouncedTrigger = debouncedFlush(flushBashrsCompletions, "bashrs-completions", 200);
  watcher = watchDir(BASHRS_SPILL_ROOT, () => debouncedTrigger?.());
  fallbackTimer = setInterval(() => debouncedTrigger?.(), FALLBACK_INTERVAL_MS);
  fallbackTimer.unref?.();

  logger.info(
    { dir: BASHRS_SPILL_ROOT, role: PROCESS_ROLE },
    "bashrs-completions: worker leadership acquired",
  );
  void flushBashrsCompletions();
}

/**
 * Join the bashrs-completions worker election — same one-leader-per-role
 * lease as `startSessionInboxWorker`, so exactly one runtime process watches
 * `BASHRS_SPILL_ROOT` regardless of how many are up. Returns a cleanup
 * function for graceful shutdown.
 */
export function startBashrsCompletionsWorker(): () => void {
  if (workerStarted) return () => {};
  workerStarted = true;

  tryBecomeLeader();
  leadershipTimer = setInterval(tryBecomeLeader, PROCESS_LEASE_HEARTBEAT_MS);
  leadershipTimer.unref?.();

  return () => {
    if (!workerStarted) return;
    workerStarted = false;
    if (leadershipTimer) {
      clearInterval(leadershipTimer);
      leadershipTimer = null;
    }
    stopLeaderResources();
    workerLease?.stop();
    workerLease = null;
    logger.info("bashrs-completions: worker stopped");
  };
}
