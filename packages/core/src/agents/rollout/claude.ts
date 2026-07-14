/**
 * Claude rollout encoder.
 *
 * Materializes a synthetic JSONL at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * so a subsequent `claude.query({ resume: sessionId })` continues the
 * cross-agent conversation as if it had always been native. Verified by
 * sandbox PoCs (test-7c/test-7d): the SDK accepts these without checksum
 * gating, requiring only `user`/`assistant` messages and a small per-turn
 * attachment chain captured into `agents/fixtures/claude-attachments.jsonl`.
 *
 * Tool history is folded into assistant text as `[Tool: ...]` annotations
 * (see shared.ts:extractChatPairs) — synthetic tool_use IDs across SDKs are
 * too fragile to reconstruct structurally.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

interface ClaudeAttachments {
  deferredToolsDelta: Record<string, unknown>;
  skillListing: Record<string, unknown>;
}

let _attachmentsCache: ClaudeAttachments | null = null;
function loadClaudeAttachments(): ClaudeAttachments {
  if (_attachmentsCache) return _attachmentsCache;
  const raw = readFileSync(join(FIXTURES_DIR, "claude-attachments.jsonl"), "utf8");
  const lines = parseJsonlText<Record<string, unknown>>(raw);
  if (lines.length < 2) {
    throw new Error(
      `loadClaudeAttachments: expected >=2 entries in claude-attachments.jsonl, got ${lines.length}`,
    );
  }
  _attachmentsCache = {
    deferredToolsDelta: lines[0],
    skillListing: lines[1],
  };
  return _attachmentsCache;
}

/**
 * Version strings stamped onto synthetic rollouts so they look indistinguishable
 * from a live SDK session. These do not affect resume behavior — the SDKs do
 * not gate on them — but keeping them current avoids confusion in observability
 * tooling that scans rollout files.
 */
const CLAUDE_SDK_VERSION = "2.1.126";
const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5";
const CLAUDE_DEFAULT_GIT_BRANCH = "HEAD";

/**
 * Encode a directory path the way Claude SDK expects in
 * `~/.claude/projects/<encoded-cwd>/`. macOS resolves `/tmp` to
 * `/private/tmp`, mirroring what the SDK records.
 *
 * The SDK normalizes ANY non-alphanumeric character to `-` (verified
 * empirically on disk: `/Users/maestrobot/.../user_6407801418` →
 * `-Users-...-user-6407801418`, i.e. both `/` AND `_` collapse to `-`).
 * A previous implementation only replaced `/` and left `_` intact, so
 * synthetic rollouts landed at `…-user_6407801418/` while the SDK looked
 * at `…-user-6407801418/` — every `set_agent` switch surfaced as "No
 * conversation found with session ID" on the next message.
 */
export function encodeClaudeCwd(cwd: string): string {
  const realCwd = cwd.startsWith("/tmp/") ? cwd.replace(/^\/tmp\//, "/private/tmp/") : cwd;
  return `-${realCwd.replaceAll(/[^a-zA-Z0-9]/g, "-").replace(/^-/, "")}`;
}

export interface ClaudeRolloutOptions {
  /** Working directory the resumed Claude session will report. */
  cwd: string;
  /** Optional override; default = freshly generated UUIDv4. */
  sessionId?: string;
  /**
   * Pairs to encode. If omitted, derived from `entries` via extractChatPairs.
   * Pass explicit pairs when the caller has already shaped the dialogue.
   */
  pairs?: ChatPair[];
  /** When `pairs` is omitted, the source UnifiedEvent log to digest. */
  entries?: ConversationEntry[];
  /** Full provider model id stamped on synthesized assistant history. */
  model?: string;
}

export interface ClaudeRolloutResult {
  sessionId: string;
  rolloutPath: string;
}

/**
 * Materialize a Claude rollout JSONL with the provided dialogue and place it
 * at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` so a subsequent
 * `claude.query({ resume: sessionId })` will continue the conversation.
 */
export function writeClaudeRollout(opts: ClaudeRolloutOptions): ClaudeRolloutResult {
  const sessionId = opts.sessionId ?? randomUUID();
  assertUuidLike("sessionId", sessionId);
  ensureCwdExists(opts.cwd);
  const pairs = opts.pairs ?? extractChatPairs(opts.entries ?? []);
  const cwdReal = opts.cwd.startsWith("/tmp/")
    ? opts.cwd.replace(/^\/tmp\//, "/private/tmp/")
    : opts.cwd;

  const lines: unknown[] = [];
  const ts = () => new Date().toISOString();
  let lastUuid: string | null = null;

  // Queue-operation noise that the live SDK records around each turn. Not
  // strictly required for resume but mirrors what the SDK itself writes,
  // keeping the synthetic file indistinguishable.
  lines.push({ type: "queue-operation", operation: "enqueue", timestamp: ts(), sessionId });
  lines.push({ type: "queue-operation", operation: "dequeue", timestamp: ts(), sessionId });

  // Per-turn attachment chain captured from a real Claude rollout. claude SDK
  // emits `deferred_tools_delta` followed by `skill_listing` immediately after
  // every user message, building a parentUuid chain user → att1 → att2 →
  // assistant. PoC-7d preserved this shape; replaying it keeps the resumed
  // session indistinguishable from a native one.
  const attachments = loadClaudeAttachments();

  for (const pair of pairs) {
    const userUuid = randomUUID();
    lines.push({
      parentUuid: lastUuid,
      isSidechain: false,
      promptId: randomUUID(),
      type: "user",
      message: { role: "user", content: [{ type: "text", text: pair.userText }] },
      uuid: userUuid,
      timestamp: ts(),
      permissionMode: "bypassPermissions",
      userType: "external",
      entrypoint: "sdk-ts",
      cwd: cwdReal,
      sessionId,
      version: CLAUDE_SDK_VERSION,
      gitBranch: CLAUDE_DEFAULT_GIT_BRANCH,
    });

    // Attachment 1: deferred_tools_delta — chain from user.
    const att1Uuid = randomUUID();
    const att1 = clone(attachments.deferredToolsDelta);
    (att1 as Record<string, unknown>).parentUuid = userUuid;
    (att1 as Record<string, unknown>).uuid = att1Uuid;
    (att1 as Record<string, unknown>).timestamp = ts();
    (att1 as Record<string, unknown>).sessionId = sessionId;
    (att1 as Record<string, unknown>).cwd = cwdReal;
    lines.push(att1);

    // Attachment 2: skill_listing — chain from att1.
    const att2Uuid = randomUUID();
    const att2 = clone(attachments.skillListing);
    (att2 as Record<string, unknown>).parentUuid = att1Uuid;
    (att2 as Record<string, unknown>).uuid = att2Uuid;
    (att2 as Record<string, unknown>).timestamp = ts();
    (att2 as Record<string, unknown>).sessionId = sessionId;
    (att2 as Record<string, unknown>).cwd = cwdReal;
    lines.push(att2);

    const assistantUuid = randomUUID();
    lines.push({
      parentUuid: att2Uuid,
      isSidechain: false,
      message: {
        model: opts.model ?? CLAUDE_DEFAULT_MODEL,
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: pair.assistantText }],
        stop_reason: "end_turn",
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: "standard",
          cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
          inference_geo: "",
          iterations: [],
          speed: "standard",
        },
        diagnostics: null,
      },
      requestId: `req_${randomUUID().replace(/-/g, "").slice(0, 22)}`,
      type: "assistant",
      uuid: assistantUuid,
      timestamp: ts(),
      userType: "external",
      entrypoint: "sdk-ts",
      cwd: cwdReal,
      sessionId,
      version: CLAUDE_SDK_VERSION,
      gitBranch: CLAUDE_DEFAULT_GIT_BRANCH,
    });
    lastUuid = assistantUuid;
  }

  const projectsDir = join(homedir(), ".claude", "projects", encodeClaudeCwd(opts.cwd));
  const path = join(projectsDir, `${sessionId}.jsonl`);
  writeJsonlFile(path, lines);
  logger.info(
    { sessionId, path, pairs: pairs.length },
    "writeClaudeRollout: synthetic rollout placed",
  );
  return { sessionId, rolloutPath: path };
}

/**
 * Remove the latest poisoned thinking turn and everything after it from the
 * session JSONL.
 *
 * When a turn ends with stop_reason="max_tokens" while extended thinking is
 * active, the Claude CLI writes the truncated thinking block verbatim to the
 * rollout file. The Anthropic API rejects any subsequent resume that replays
 * this incomplete block with 400 "thinking/redacted_thinking blocks cannot be
 * modified". Dropping the entire poisoned turn (user entry + attachments +
 * truncated assistant) leaves the JSONL in a clean state so the next
 * claude.query({ resume }) can proceed without a 400.
 *
 * Returns true when the JSONL was found and repaired, false otherwise
 * (file missing, no poisoned assistant turn found, I/O error). Error-path
 * callers fall back to clearing the session ID when false is returned.
 */
export function repairPoisonedRollout(sessionId: string, cwd: string): boolean {
  try {
    const path = join(homedir(), ".claude", "projects", encodeClaudeCwd(cwd), `${sessionId}.jsonl`);
    if (!existsSync(path)) return false;

    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim());

    // Walk backwards to find the latest assistant turn that actually contains
    // the poisoned shape: max_tokens plus a thinking/redacted_thinking block.
    // A resume failure can append a fresh user entry after the poisoned turn;
    // trimming the last user would remove only the retry and leave the bad
    // assistant in place.
    let poisonedAssistantIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const entry = parseClaudeRolloutLine(lines[i]);
      if (entry && isPoisonedAssistantEntry(entry)) {
        poisonedAssistantIdx = i;
        break;
      }
    }

    if (poisonedAssistantIdx < 0) {
      logger.warn({ sessionId, path }, "repairPoisonedRollout: no poisoned assistant entry found");
      return false;
    }

    let turnStartIdx = -1;
    for (let i = poisonedAssistantIdx - 1; i >= 0; i--) {
      const entry = parseClaudeRolloutLine(lines[i]);
      if (entry?.type === "user") {
        turnStartIdx = i;
        break;
      }
    }

    if (turnStartIdx < 0) {
      logger.warn(
        { sessionId, path, poisonedAssistantIdx },
        "repairPoisonedRollout: poisoned assistant has no preceding user entry",
      );
      return false;
    }

    const kept = lines.slice(0, turnStartIdx);
    writeFileSync(path, kept.length ? `${kept.join("\n")}\n` : "");
    logger.warn(
      {
        sessionId,
        path,
        poisonedAssistantIdx,
        turnStartIdx,
        droppedEntries: lines.length - turnStartIdx,
        keptEntries: kept.length,
      },
      "repairPoisonedRollout: truncated turn removed from rollout JSONL",
    );
    return true;
  } catch (err) {
    logger.warn({ err, sessionId, cwd }, "repairPoisonedRollout: I/O error");
    return false;
  }
}

type ClaudeRolloutEntry = {
  type?: string;
  message?: {
    stop_reason?: string | null;
    content?: unknown;
  };
};

function parseClaudeRolloutLine(line: string): ClaudeRolloutEntry | null {
  try {
    return JSON.parse(line) as ClaudeRolloutEntry;
  } catch {
    return null;
  }
}

function isPoisonedAssistantEntry(entry: ClaudeRolloutEntry): boolean {
  if (entry.type !== "assistant") return false;
  if (entry.message?.stop_reason !== "max_tokens") return false;
  const content = entry.message.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const type = (block as { type?: unknown }).type;
    return type === "thinking" || type === "redacted_thinking";
  });
}
