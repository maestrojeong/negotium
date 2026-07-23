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
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

/** Replace captured developer metadata with the policy used for resumed turns. */
function patchDeveloperSetup(developerSetup: Record<string, unknown>): void {
  const payload = developerSetup.payload as Record<string, unknown> | undefined;
  if (!payload) return;
  payload.content = [
    {
      type: "input_text",
      text: [
        "<permissions instructions>",
        "Filesystem sandboxing is disabled for this runtime turn (`danger-full-access`).",
        "Approval policy is `never`.",
        "</permissions instructions>",
      ].join("\n"),
    },
  ];
}

/** Mutate captured `<environment_context>` fields to the current runtime. */
function patchEnvContext(
  envContext: Record<string, unknown>,
  cwd: string,
  currentDate: string,
  timezone: string,
): void {
  const payload = envContext.payload as Record<string, unknown> | undefined;
  if (!payload) return;
  const content = payload.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type === "input_text" && typeof block.text === "string") {
      block.text = block.text
        .replace(/<cwd>[^<]*<\/cwd>/, `<cwd>${cwd}</cwd>`)
        .replace(
          /<current_date>[^<]*<\/current_date>/,
          `<current_date>${currentDate}</current_date>`,
        )
        .replace(/<timezone>[^<]*<\/timezone>/, `<timezone>${timezone}</timezone>`);
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

export interface CodexContextUsage {
  contextTokens: number;
  contextWindow: number;
}

export interface CodexPatchChangePreview {
  path: string;
  before?: string;
  after?: string;
  diffPreview?: string;
}

export interface CodexPatchPreview {
  callId: string;
  changes: CodexPatchChangePreview[];
}

function canonicalFilePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

function changedPatchLines(value: string): Omit<CodexPatchChangePreview, "path"> {
  const removed: string[] = [];
  const added: string[] = [];
  const diffPreview: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let sawHunk = false;
  for (const line of value.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      if (sawHunk) diffPreview.push("…");
      sawHunk = true;
      oldLine = Number.parseInt(hunk[1] ?? "0", 10);
      newLine = Number.parseInt(hunk[2] ?? "0", 10);
      continue;
    }
    if (!sawHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) continue;
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith("-")) {
      removed.push(line.slice(1));
      diffPreview.push(`${oldLine} -${line.slice(1)}`);
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      added.push(line.slice(1));
      diffPreview.push(`${newLine} +${line.slice(1)}`);
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      diffPreview.push(`${newLine}  ${line.slice(1)}`);
      oldLine += 1;
      newLine += 1;
    }
  }
  return {
    ...(removed.length > 0 ? { before: removed.join("\n") } : {}),
    ...(added.length > 0 ? { after: added.join("\n") } : {}),
    ...(diffPreview.length > 0 ? { diffPreview: diffPreview.join("\n") } : {}),
  };
}

/**
 * Extract the newest native apply_patch result matching a Codex file_change.
 *
 * The public SDK intentionally reduces file changes to path + kind, while the
 * native rollout keeps the exact unified diff in patch_apply_end. Reading that
 * payload preserves the real per-edit +/- lines even when the topic cwd itself
 * is not a Git repository.
 */
export function extractLatestCodexPatchPreview(
  jsonl: string,
  expectedPaths: string[],
  consumedCallIds: ReadonlySet<string> = new Set(),
  expectedCallId?: string,
): CodexPatchPreview | undefined {
  const expected = expectedPaths.map(canonicalFilePath);
  const lines = jsonl.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index] ?? "") as {
        type?: string;
        payload?: {
          type?: string;
          call_id?: string;
          changes?: Record<
            string,
            { type?: string; unified_diff?: string; content?: string; move_path?: string | null }
          >;
        };
      };
      if (entry.type !== "event_msg" || entry.payload?.type !== "patch_apply_end") continue;
      const callId = entry.payload.call_id;
      const rawChanges = entry.payload.changes;
      if (
        !callId ||
        consumedCallIds.has(callId) ||
        (expectedCallId !== undefined && callId !== expectedCallId) ||
        !rawChanges
      ) {
        continue;
      }

      const entries = Object.entries(rawChanges);
      const matched = expected.map((path) =>
        entries.find(([candidate]) => canonicalFilePath(candidate) === path),
      );
      const complete = matched.filter(
        (change): change is NonNullable<typeof change> => change !== undefined,
      );
      if (complete.length !== expected.length) continue;

      return {
        callId,
        changes: complete.map(([path, change]) => {
          if (typeof change.unified_diff === "string") {
            return { path, ...changedPatchLines(change.unified_diff) };
          }
          const content =
            typeof change.content === "string" ? change.content.replace(/\n$/, "") : undefined;
          return {
            path,
            ...(change.type === "delete" && content !== undefined ? { before: content } : {}),
            ...(change.type === "add" && content !== undefined ? { after: content } : {}),
          };
        }),
      };
    } catch {
      // A concurrently appended final line may be incomplete; keep scanning.
    }
  }
  return undefined;
}

export function extractCodexPatchCallIds(jsonl: string): string[] {
  const callIds: string[] = [];
  for (const line of jsonl.trimEnd().split("\n")) {
    try {
      const entry = JSON.parse(line) as {
        type?: string;
        payload?: { type?: string; call_id?: string };
      };
      if (
        entry.type === "event_msg" &&
        entry.payload?.type === "patch_apply_end" &&
        typeof entry.payload.call_id === "string"
      ) {
        callIds.push(entry.payload.call_id);
      }
    } catch {
      // A concurrently appended final line may be incomplete.
    }
  }
  return callIds;
}

/** List native patch calls that already existed before a resumed turn. */
export function readCodexPatchCallIds(threadId: string): string[] {
  const path = latestCodexRolloutPath(threadId);
  if (!path) return [];
  try {
    return extractCodexPatchCallIds(readFileSync(path, "utf8"));
  } catch (error) {
    logger.debug({ error, threadId }, "codex patch ids: rollout read failed");
    return [];
  }
}

/** Resolve a thread's newest native apply_patch preview. */
export function readLatestCodexPatchPreview(
  threadId: string,
  expectedPaths: string[],
  consumedCallIds: ReadonlySet<string> = new Set(),
  expectedCallId?: string,
): CodexPatchPreview | undefined {
  const path = latestCodexRolloutPath(threadId);
  if (!path) return undefined;
  try {
    return extractLatestCodexPatchPreview(
      readFileSync(path, "utf8"),
      expectedPaths,
      consumedCallIds,
      expectedCallId,
    );
  } catch (error) {
    logger.debug({ error, threadId }, "codex patch preview: rollout read failed");
    return undefined;
  }
}

/** Read the latest per-request context measurement from a Codex rollout. */
export function extractLatestCodexContextUsage(jsonl: string): CodexContextUsage | undefined {
  const lines = jsonl.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index] ?? "") as {
        type?: string;
        payload?: {
          type?: string;
          info?: {
            last_token_usage?: { total_tokens?: number };
            model_context_window?: number;
          };
        };
      };
      if (entry.type !== "event_msg" || entry.payload?.type !== "token_count") continue;
      const contextTokens = entry.payload.info?.last_token_usage?.total_tokens;
      const contextWindow = entry.payload.info?.model_context_window;
      if (
        typeof contextTokens === "number" &&
        Number.isFinite(contextTokens) &&
        contextTokens >= 0 &&
        typeof contextWindow === "number" &&
        Number.isFinite(contextWindow) &&
        contextWindow > 0
      ) {
        return { contextTokens, contextWindow };
      }
    } catch {
      // A concurrently appended final line may be incomplete; keep scanning.
    }
  }
  return undefined;
}

/** Resolve a thread's current rollout and return its latest context measurement. */
export function readLatestCodexContextUsage(threadId: string): CodexContextUsage | undefined {
  const path = latestCodexRolloutPath(threadId);
  if (!path) return undefined;
  try {
    return extractLatestCodexContextUsage(readFileSync(path, "utf8"));
  } catch (error) {
    logger.debug({ error, threadId }, "codex context usage: rollout read failed");
    return undefined;
  }
}

/**
 * Old and metadata-free Codex rollouts resume as native multi-agent v1 even
 * when the feature flag is false. Rewrite their runtime metadata in place so
 * the same thread can resume without losing provider conversation history.
 */
export function migrateCodexRolloutNativeMultiAgentMetadata(threadId: string): boolean {
  const path = latestCodexRolloutPath(threadId);
  if (!path) return false;
  try {
    const entries = parseJsonlText<{
      type?: string;
      payload?: Record<string, unknown>;
    }>(readFileSync(path, "utf8"));
    let changed = false;
    for (const entry of entries) {
      if (entry.type !== "session_meta" && entry.type !== "turn_context") continue;
      if (!entry.payload) entry.payload = {};
      if (entry.payload.multi_agent_version !== "disabled") {
        entry.payload.multi_agent_version = "disabled";
        changed = true;
      }
    }
    if (changed) {
      writeJsonlFile(path, entries);
      logger.info({ threadId, path }, "codex rollout native multi-agent metadata disabled");
    }
    return changed;
  } catch (error) {
    logger.error({ error, threadId, path }, "codex rollout native multi-agent migration failed");
    throw new Error(`Failed to migrate Codex rollout '${threadId}'`, { cause: error });
  }
}

function latestCodexRolloutPath(threadId: string): string | undefined {
  const sessionsDir = codexSessionsDir();
  const candidates: string[] = [];
  const buckets = candidateDateBuckets(threadId);
  try {
    if (buckets) {
      for (const bucket of buckets) {
        const dir = join(sessionsDir, bucket);
        if (!existsSync(dir)) continue;
        const glob = new Bun.Glob(`rollout-*-${threadId}.jsonl`);
        for (const rel of glob.scanSync({ cwd: dir, onlyFiles: true })) {
          candidates.push(join(dir, rel));
        }
      }
    }
    // The UUIDv7 timestamp is UTC, but Codex names session directories by the
    // local date, so a session opened in the evening of a negative-offset
    // timezone lands in the previous day's bucket. When the date-derived
    // buckets miss (or none were computed), fall back to a whole-tree scan so
    // that skew never silently drops the rollout.
    if (candidates.length === 0) {
      const glob = new Bun.Glob(`**/rollout-*-${threadId}.jsonl`);
      for (const rel of glob.scanSync({ cwd: sessionsDir, onlyFiles: true })) {
        candidates.push(join(sessionsDir, rel));
      }
    }
    return candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch (error) {
    logger.debug({ error, threadId }, "codex rollout lookup failed");
    return undefined;
  }
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
  const currentDate = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || process.env.TZ || "UTC";

  // Captured 5-entry SDK shell (session_meta, task_started, developer setup,
  // environment_context, turn_context). Cloned per call so the cached
  // fixture is never mutated; only id/timestamp/cwd are patched.
  const shell = loadCodexShell();
  const sessionMeta = clone(shell.sessionMeta);
  (sessionMeta.payload as Record<string, unknown>).id = threadId;
  (sessionMeta.payload as Record<string, unknown>).timestamp = tsIso;
  (sessionMeta.payload as Record<string, unknown>).cwd = opts.cwd;
  (sessionMeta.payload as Record<string, unknown>).multi_agent_version = "disabled";
  (sessionMeta as Record<string, unknown>).timestamp = tsIso;

  const taskStarted = clone(shell.taskStarted);
  (taskStarted as Record<string, unknown>).timestamp = tsIso;

  const developerSetup = clone(shell.developerSetup);
  (developerSetup as Record<string, unknown>).timestamp = tsIso;
  patchDeveloperSetup(developerSetup);

  const envContext = clone(shell.envContext);
  (envContext as Record<string, unknown>).timestamp = tsIso;
  patchEnvContext(envContext, opts.cwd, currentDate, timezone);

  const turnContext = clone(shell.turnContext);
  (turnContext as Record<string, unknown>).timestamp = tsIso;
  const turnPayload = turnContext.payload as Record<string, unknown>;
  turnPayload.cwd = opts.cwd;
  turnPayload.current_date = currentDate;
  turnPayload.timezone = timezone;
  turnPayload.approval_policy = "never";
  turnPayload.sandbox_policy = { type: "danger-full-access" };
  turnPayload.multi_agent_version = "disabled";
  delete turnPayload.permission_profile;
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
const LOCAL_DATE_SKEW_DAYS = 1;

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
  // Codex buckets sessions by local calendar date while UUIDv7 timestamps are
  // UTC. Include one day on each edge so every date-bucketed caller (context
  // usage, migration, and prior-rollout cleanup) covers timezone skew without
  // falling back to a whole-tree scan.
  for (let d = minDay - LOCAL_DATE_SKEW_DAYS; d <= maxDay + LOCAL_DATE_SKEW_DAYS; d++) {
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
