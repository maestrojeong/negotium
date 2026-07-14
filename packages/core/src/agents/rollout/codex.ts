/**
 * Codex rollout encoder.
 *
 * Materializes a synthetic JSONL at
 * `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<threadId>.jsonl` so a
 * subsequent `codex.resumeThread(threadId)` continues the cross-agent
 * conversation as if it had always been native. Verified by sandbox PoC
 * test-7c: the SDK accepts these without checksum gating, requiring only the
 * captured 5-entry SDK shell (`agents/fixtures/codex-shell.jsonl`) plus
 * synthesized `response_item`/`event_msg` pairs per turn.
 *
 * Tool history is folded into assistant text as `[Tool: ...]` annotations
 * (see shared.ts:extractChatPairs) — the SDK has no fork API and synthetic
 * tool_use IDs across SDKs are too fragile to reconstruct structurally.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  assertUuidLike,
  type ChatPair,
  clone,
  ensureCwdExists,
  extractChatPairs,
  FIXTURES_DIR,
} from "#agents/rollout/shared";
import { parseJsonlText, writeJsonlFile } from "#platform/jsonl";
import { logger } from "#platform/logger";
import type { ConversationEntry } from "#storage/conversations";
import type { EffortLevel } from "#types";

interface CodexShell {
  sessionMeta: Record<string, unknown>;
  taskStarted: Record<string, unknown>;
  developerSetup: Record<string, unknown>;
  envContext: Record<string, unknown>;
  turnContext: Record<string, unknown>;
}

function codexSessionsDir(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

let _shellCache: CodexShell | null = null;
function loadCodexShell(): CodexShell {
  if (_shellCache) return _shellCache;
  const raw = readFileSync(join(FIXTURES_DIR, "codex-shell.jsonl"), "utf8");
  const lines = parseJsonlText<Record<string, unknown>>(raw);
  if (lines.length < 5) {
    throw new Error(
      `loadCodexShell: expected >=5 entries in codex-shell.jsonl, got ${lines.length}`,
    );
  }
  _shellCache = {
    sessionMeta: lines[0],
    taskStarted: lines[1],
    developerSetup: lines[2],
    envContext: lines[3],
    turnContext: lines[4],
  };
  return _shellCache;
}

/** UUIDv7 (Codex thread_id format). */
function uuidv7(): string {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, "0");
  const rand = randomBytes(10);
  rand[0] = (rand[0] & 0x0f) | 0x70; // version 7
  rand[2] = (rand[2] & 0x3f) | 0x80; // variant
  return [
    tsHex.slice(0, 8),
    tsHex.slice(8, 12),
    rand.slice(0, 2).toString("hex"),
    rand.slice(2, 4).toString("hex"),
    rand.slice(4, 10).toString("hex"),
  ].join("-");
}

/** Mutate `<environment_context>` payload to point at our cwd. */
function patchEnvContextCwd(envContext: Record<string, unknown>, cwd: string): void {
  const payload = envContext.payload as Record<string, unknown> | undefined;
  if (!payload) return;
  const content = payload.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "input_text" && typeof block.text === "string") {
      block.text = block.text.replace(/<cwd>[^<]*<\/cwd>/, `<cwd>${cwd}</cwd>`);
    }
  }
}

export interface CodexRolloutOptions {
  /** Working directory the resumed Codex thread will report. */
  cwd: string;
  /** Optional override; default = freshly generated UUIDv7. */
  threadId?: string;
  /** Override extracted pairs. */
  pairs?: ChatPair[];
  /** Source UnifiedEvent log when `pairs` is omitted. */
  entries?: ConversationEntry[];
  /** Effective model/effort that Codex will use when this thread is resumed. */
  model?: string;
  effort?: EffortLevel;
}

export interface CodexRolloutResult {
  threadId: string;
  rolloutPath: string;
}

/**
 * Materialize a Codex rollout JSONL with the provided dialogue and place it
 * at `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<threadId>.jsonl` so a
 * subsequent `codex.resumeThread(threadId)` continues the conversation.
 */
export function writeCodexRollout(opts: CodexRolloutOptions): CodexRolloutResult {
  const threadId = opts.threadId ?? uuidv7();
  assertUuidLike("threadId", threadId);
  ensureCwdExists(opts.cwd);
  const pairs = opts.pairs ?? extractChatPairs(opts.entries ?? []);
  const now = new Date();
  const tsIso = now.toISOString();

  // Captured 5-entry SDK shell (session_meta, task_started, developer setup,
  // environment_context, turn_context). Cloned per call so the cached
  // fixture is never mutated; only id/timestamp/cwd are patched.
  const shell = loadCodexShell();
  const sessionMeta = clone(shell.sessionMeta);
  (sessionMeta.payload as Record<string, unknown>).id = threadId;
  (sessionMeta.payload as Record<string, unknown>).timestamp = tsIso;
  (sessionMeta.payload as Record<string, unknown>).cwd = opts.cwd;
  (sessionMeta as Record<string, unknown>).timestamp = tsIso;

  const taskStarted = clone(shell.taskStarted);
  (taskStarted as Record<string, unknown>).timestamp = tsIso;

  const developerSetup = clone(shell.developerSetup);
  (developerSetup as Record<string, unknown>).timestamp = tsIso;

  const envContext = clone(shell.envContext);
  (envContext as Record<string, unknown>).timestamp = tsIso;
  patchEnvContextCwd(envContext, opts.cwd);

  const turnContext = clone(shell.turnContext);
  (turnContext as Record<string, unknown>).timestamp = tsIso;
  const turnPayload = turnContext.payload as Record<string, unknown>;
  turnPayload.cwd = opts.cwd;
  turnPayload.current_date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  turnPayload.timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "UTC";
  if (opts.model) turnPayload.model = opts.model;
  const collaborationMode = turnPayload.collaboration_mode as Record<string, unknown> | undefined;
  const collaborationSettings = collaborationMode?.settings as Record<string, unknown> | undefined;
  if (collaborationSettings) {
    if (opts.model) collaborationSettings.model = opts.model;
    if (opts.effort !== undefined) collaborationSettings.reasoning_effort = opts.effort;
  }

  const lines: unknown[] = [sessionMeta, taskStarted, developerSetup, envContext, turnContext];

  for (const pair of pairs) {
    lines.push({
      timestamp: tsIso,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: pair.userText }],
      },
    });
    lines.push({
      timestamp: tsIso,
      type: "event_msg",
      payload: {
        type: "user_message",
        message: pair.userText,
        images: [],
        local_images: [],
        text_elements: [],
      },
    });
    lines.push({
      timestamp: tsIso,
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: pair.assistantText,
        phase: "final_answer",
        memory_citation: null,
      },
    });
    lines.push({
      timestamp: tsIso,
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: pair.assistantText }],
        phase: "final_answer",
      },
    });
  }

  lines.push({
    timestamp: tsIso,
    type: "event_msg",
    payload: { type: "task_complete" },
  });

  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const tsStr = tsIso.replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(codexSessionsDir(), String(yyyy), mm, dd);
  const path = join(dir, `rollout-${tsStr}-${threadId}.jsonl`);

  // Round-trip cleanup: when the caller reused a threadId (claude→codex→...
  // or maestro→codex→... cycles via `findLastSessionIdForAgent`), the SDK's
  // original rollout for that threadId still sits at its ORIGINAL-date
  // directory (`~/.codex/sessions/<orig-yyyy>/<orig-mm>/<orig-dd>/...`).
  // Writing today's synthetic rollout next to it leaves two jsonls sharing
  // the same threadId — `codex resume <tid>` globs `~/.codex/sessions/**`
  // and the SDK has no spec for which match it picks, so behavior becomes
  // environment-/codex-version-dependent. Sweep every prior file for this
  // threadId BEFORE writing the new one so resume always reads our synth.
  //
  // Synchronous on purpose: writeCodexRollout's signature is sync (called
  // inside set_agent's DB transaction), and an async sweep would race with
  // the following `writeJsonlFile` — Bun.Glob would re-scan once the
  // microtask queue drains and could unlink the file we just wrote if today
  // and the original-write-date are the same. Sync glob/unlink completes
  // before the new file ever lands on disk.
  //
  // Only runs when `opts.threadId` was supplied; fresh-mint threadIds can't
  // have prior files. Errors are logged but non-fatal — losing the sweep on
  // a permission glitch is preferable to crashing the whole switch.
  if (opts.threadId) {
    sweepPriorRolloutsForThread(opts.threadId);
  }

  writeJsonlFile(path, lines);
  logger.info(
    { threadId, path, pairs: pairs.length },
    "writeCodexRollout: synthetic rollout placed",
  );
  return { threadId, rolloutPath: path };
}

/**
 * Synchronous unlink of every existing `rollout-*-<threadId>.jsonl` under
 * `~/.codex/sessions/**`. Same glob shape `codexRegistry.cleanupRollouts`
 * uses (kept duplicate rather than imported to avoid the registry → rollout
 * → registry cycle).
 */
function sweepPriorRolloutsForThread(threadId: string): void {
  const sessionsDir = codexSessionsDir();
  const buckets = candidateDateBuckets(threadId);
  if (!buckets) {
    // Couldn't pin a date from the threadId — fall back to the safer (but
    // much slower) whole-tree scan so we still find every prior rollout.
    sweepPriorRolloutsFullTree(threadId, sessionsDir);
    return;
  }
  for (const bucket of buckets) {
    const dir = join(sessionsDir, bucket);
    if (!existsSync(dir)) continue;
    try {
      const glob = new Bun.Glob(`rollout-*-${threadId}.jsonl`);
      for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
        const fullPath = join(dir, rel);
        try {
          unlinkSync(fullPath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
            logger.warn(
              { err: e, path: fullPath },
              "writeCodexRollout: prior-rollout unlink failed (continuing)",
            );
          }
        }
      }
    } catch (e) {
      logger.warn(
        { err: e, threadId, bucket },
        "writeCodexRollout: prior-rollout bucket scan failed (continuing)",
      );
    }
  }
}

/** Legacy whole-tree scan. Used only when `candidateDateBuckets` can't pin a
 *  date set from the threadId (non-UUIDv7 ids, e.g. some test fixtures). */
function sweepPriorRolloutsFullTree(threadId: string, sessionsDir: string): void {
  try {
    const glob = new Bun.Glob(`**/rollout-*-${threadId}.jsonl`);
    for (const rel of glob.scanSync({ cwd: sessionsDir, onlyFiles: true })) {
      const fullPath = join(sessionsDir, rel);
      try {
        unlinkSync(fullPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
          logger.warn(
            { err: e, path: fullPath },
            "writeCodexRollout: prior-rollout unlink failed (continuing)",
          );
        }
      }
    }
  } catch (e) {
    logger.warn(
      { err: e, threadId },
      "writeCodexRollout: full-tree prior-rollout sweep failed (continuing)",
    );
  }
}

/**
 * UUIDv7 ids encode their creation time in the first 48 bits. `writeCodexRollout`
 * buckets new files at `<yyyy>/<mm>/<dd>/` keyed off the WRITE time, so a
 * thread's rollouts can only live between (threadId's birth date) and
 * (today's date) — typically a 0-2 day span. We enumerate every day in that
 * inclusive range so a Mon-bridge / Tue-rebridge picks up both.
 *
 * Returns null when:
 *   - threadId isn't a parseable UUIDv7 (atypical fixture / future format)
 *   - the day span exceeds MAX_DAY_SPAN (a month+-old re-bridge isn't worth
 *     per-day enumeration; safer to scan the full tree than to enumerate
 *     hundreds of dirs and still maybe miss something)
 * In both cases the caller falls back to the whole-tree sweep so safety
 * never degrades below the original implementation.
 */
const MAX_DAY_SPAN = 30;
const DAY_MS = 86_400_000;

function candidateDateBuckets(threadId: string): Set<string> | null {
  const tidMs = decodeUuidV7Timestamp(threadId);
  if (tidMs === null) return null;
  const nowMs = Date.now();
  // Day-floor each end so DST / minutes-of-day noise doesn't bloat the span.
  const tidDay = Math.floor(tidMs / DAY_MS);
  const todayDay = Math.floor(nowMs / DAY_MS);
  const minDay = Math.min(tidDay, todayDay);
  const maxDay = Math.max(tidDay, todayDay);
  const span = maxDay - minDay;
  if (span > MAX_DAY_SPAN) return null;
  const buckets = new Set<string>();
  for (let d = minDay; d <= maxDay; d++) {
    buckets.add(formatDateBucket(new Date(d * DAY_MS)));
  }
  return buckets;
}

/**
 * Decode the 48-bit unix-ms timestamp out of a UUIDv7. The first 12 hex
 * chars of the dash-separated form are the timestamp. Returns null when the
 * input doesn't look like a UUIDv7 or the decoded value is outside a
 * plausibility window (defensive: a malformed id that fits the regex but
 * decodes to year 1972 would point the sweep at a non-existent bucket —
 * better to fall back to the whole-tree scan than to silently no-op).
 *
 * Exported for tests.
 */
export function decodeUuidV7Timestamp(threadId: string): number | null {
  if (typeof threadId !== "string") return null;
  const m =
    /^([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-7[0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.exec(
      threadId,
    );
  if (!m) return null;
  const hex = `${m[1]}${m[2]}`;
  const ms = Number.parseInt(hex, 16);
  if (!Number.isFinite(ms)) return null;
  const MIN = 1577836800000; // 2020-01-01T00:00:00Z
  const MAX = 4102444800000; // 2100-01-01T00:00:00Z
  if (ms < MIN || ms > MAX) return null;
  return ms;
}

function formatDateBucket(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}/${mm}/${dd}`;
}

/** Internal export for tests. */
export const __candidateDateBuckets = candidateDateBuckets;
