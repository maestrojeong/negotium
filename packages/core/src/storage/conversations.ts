import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR } from "#platform/config";
import { appendJsonlLine } from "#platform/jsonl";
import { logger } from "#platform/logger";
import { sanitizeTopicName } from "#security/sanitize";
import type { AgentKind, UnifiedEvent } from "#types";

/**
 * Per-topic conversation log (UnifiedEvent stream) used as the
 * **provider-agnostic source of truth** for cross-agent portability.
 *
 * Storage layout:
 *   {DATA_DIR}/conversations/{userId}/{sanitizedTopicName}.jsonl
 *
 * Each line is a `ConversationEntry` JSON object. Append-only: every yielded
 * UnifiedEvent during a `runAgent()` turn is captured here by the recording
 * wrapper, so on agent switch we can rebuild a synthetic native rollout for
 * the target SDK and preserve the conversation across providers.
 *
 * The Claude/Codex SDK rollouts (~/.claude/projects/, ~/.codex/sessions/) are
 * intentionally treated as opaque side-effects of the SDKs only this file
 * is canonical.
 */
export interface ConversationEntry {
  ts: string;
  /**
   * Agent that produced this event, frozen at write time. A topic that has
   * been switched (via `set_agent`) will have a mixed-agent log: earlier
   * entries keep the agent that originally generated them. Replay code
   * (rollout-codec `extractChatPairs`) intentionally ignores this field —
   * the cross-agent rollout's whole point is to feed past dialogue, no
   * matter who produced it, into the *new* SDK as if it were native.
   */
  agent: AgentKind;
  event: UnifiedEvent;
}

/**
 * Validate that a userId stringifies to a safe path component. Rejects empties,
 * slashes, and traversal sequences before they touch the filesystem. The
 * conversation log is local-only so we keep this strict but simple if a
 * caller sends something unexpected it is their bug to fix, not ours to coerce.
 */
function safeUserIdComponent(userId: number | string): string {
  const str = String(userId);
  if (!str || /[/\\]|\.\./.test(str)) {
    throw new Error(`conversations: refusing unsafe userId path component: ${str}`);
  }
  return str;
}

function conversationDir(userId: number | string): string {
  return join(DATA_DIR, "conversations", safeUserIdComponent(userId));
}

function topicFilename(topicName: string): string {
  const t = sanitizeTopicName(topicName, true);
  return `${t}.jsonl`;
}

/** Compute the absolute path for a given user/topic conversation log. */
export function getConversationPath(userId: number | string, topicName: string): string {
  return join(conversationDir(userId), topicFilename(topicName));
}

/**
 * Append a single UnifiedEvent for the given topic. Creates the parent
 * directory and the file as needed. Best-effort: I/O failures are logged but
 * never throw, since recording must not break the live stream to Telegram.
 *
 * **Concurrency note (review item M2, revised):** within the bot process the
 * single-threaded event loop already serializes writes — but this module is
 * NOT single-process: the self-config MCP server (a separate stdio process,
 * via `topic-agent-switch`) and provider bridge helpers append to the same
 * topic logs.
 * Cross-process interleaving on macOS is real for lines beyond PIPE_BUF
 * (512B), and a torn line is silently dropped by `readConversation` —
 * corrupting the canonical source for cross-agent rollout reconstruction.
 * Writes therefore go through `appendJsonlLine` (sidecar `.lock` via O_EXCL,
 * stale-lock reclaim, unlocked-append fallback on timeout — interleave is
 * accepted over dropping the entry).
 *
 * The append stays SYNCHRONOUS on purpose: a previous attempt at a
 * Promise-chained per-topic queue made writes async (durability gap before a
 * synchronous `readConversation`) and broke `set_agent` in the bridge tests.
 */
export function appendConversationEvent(
  userId: number | string,
  topicName: string,
  agent: AgentKind,
  event: UnifiedEvent,
): void {
  try {
    appendConversationEventStrict(userId, topicName, agent, event);
  } catch (err) {
    logger.warn(
      { err, userId, topicName, eventType: event.type },
      "appendConversationEvent: write failed",
    );
  }
}

/**
 * Strict variant for state transitions where the conversation log is a manifest
 * rather than telemetry. Throws on I/O failure so callers can avoid committing
 * DB state that points at an unmanifested SDK session.
 */
export function appendConversationEventStrict(
  userId: number | string,
  topicName: string,
  agent: AgentKind,
  event: UnifiedEvent,
): void {
  const path = getConversationPath(userId, topicName);
  const entry: ConversationEntry = {
    ts: new Date().toISOString(),
    agent,
    event,
  };
  mkdirSync(dirname(path), { recursive: true });
  appendJsonlLine(path, JSON.stringify(entry));
}

/**
 * Read all entries for a topic in chronological order. Returns an empty array
 * if the file does not exist. Malformed lines are skipped with a warning so a
 * single corrupted entry does not poison the whole conversation.
 *
 * NOTE(perf): reads the whole file each call. Topics in the kilobyte range
 * are fine; if a single topic ever grows into multi-megabyte territory,
 * consider a streaming reader (`readline`/`Bun.file().stream()`) and a
 * size-bounded tail.
 */
export function readConversation(userId: number | string, topicName: string): ConversationEntry[] {
  const path = getConversationPath(userId, topicName);
  const out: ConversationEntry[] = [];
  if (!existsSync(path)) return out;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    logger.warn({ err, path }, "readConversation: read failed");
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ConversationEntry);
    } catch (err) {
      logger.warn(
        { err, line: line.slice(0, 200) },
        "readConversation: malformed JSONL line skipped",
      );
    }
  }
  return out;
}

/** Atomically replace a provider-neutral topic log with an explicit event set. */
export function replaceConversationStrict(
  userId: number | string,
  topicName: string,
  entries: ConversationEntry[],
): void {
  const path = getConversationPath(userId, topicName);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(
      tempPath,
      entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "",
      { flag: "wx" },
    );
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

/**
 * Copy the unified conversation log of `srcTopic` into the file path that
 * `dstTopic` will read from. Used by `/fork` so a forked child topic inherits
 * the parent's full cross-agent history, not just the agent's native SDK
 * rollout. `/spawn` intentionally does not call this; it starts with no
 * conversation history. Without this copy, a fork followed immediately by
 * `/agent <other>` would feed the empty child log to `switchTopicAgent` and
 * the new agent would start from zero — see the bug report from 2026-05-24.
 *
 * Semantics:
 *   - Reads the parent via `readConversation`, matching the history an in-place
 *     `set_agent` on the parent would have seen.
 *   - Writes a single file at the child's canonical path.
 *   - Refuses to overwrite a non-empty destination (returns `{copied:false}`).
 *     `/fork`'s only caller runs this immediately after topic creation when
 *     the dst file is guaranteed empty, so a non-empty dst means a programmer
 *     error somewhere upstream — fail loud rather than silently merging.
 *   - On any I/O error: throws. The caller (`createChildTopic`) already has
 *     a rollback path that wraps this call.
 */
export function cloneConversationLog(opts: {
  userId: number | string;
  srcTopic: string;
  dstTopic: string;
}): { copied: boolean; entries: number } {
  const { userId, srcTopic, dstTopic } = opts;
  const dstPath = getConversationPath(userId, dstTopic);
  if (existsSync(dstPath) && readFileSync(dstPath, "utf8").trim().length > 0) {
    logger.warn(
      { userId, srcTopic, dstTopic, dstPath },
      "cloneConversationLog: dst already non-empty — refusing to overwrite",
    );
    return { copied: false, entries: 0 };
  }
  const entries = readConversation(userId, srcTopic);
  if (entries.length === 0) {
    return { copied: false, entries: 0 };
  }
  const body = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, body);
  return { copied: true, entries: entries.length };
}

/**
 * Walk the unified log backwards and return the most recent SDK-emitted
 * session id for the given agent — or null if that agent has never run on
 * this topic.
 *
 * Used by `set_agent` to round-trip the SAME native rollout file across
 * agent switches: when the user does claude → codex → claude, we reuse
 * the original claude sessionId so the synthetic rollout lands at the
 * same path the SDK already manages, preserving prompt-cache continuity
 * and avoiding orphan `~/.claude/projects/<dir>/<id>.jsonl` files.
 *
 * Behavior:
 *   - First-ever switch to an agent (no prior session events) → null,
 *     caller falls back to a fresh randomUUID/uuidv7. Same as before.
 *   - Roundtrip switch (prior session exists) → that sessionId.
 *
 * `session` events are emitted on every turn by claude-/codex-provider and
 * captured into the unified log by runAgent's append wrapper. The most
 * recent one for the target agent is by definition the current SDK-side
 * resume key for that agent.
 */
export function findLastSessionIdForAgent(
  entries: ConversationEntry[],
  agent: AgentKind,
): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.agent !== agent) continue;
    if (entry.event.type === "session") {
      return entry.event.sessionId;
    }
  }
  return null;
}
