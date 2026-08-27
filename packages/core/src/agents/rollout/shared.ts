/**
 * Helpers shared by every agent's rollout encoder.
 *
 * Each rollout file under `agents/rollout/<agent>.ts` materializes a
 * synthetic SDK-native JSONL from a provider-agnostic `ConversationEntry`
 * stream. The cwd validation, UUID shape check, and chat-pair extraction
 * are identical regardless of agent, so they live here.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  DM_WORKSPACE_DIR,
  PROJECT_ROOT,
  SESSION_WORKSPACE_DIR,
  TOPIC_WORKSPACE_DIR,
  WORKSPACE_DIR,
} from "#platform/config";
import { logger } from "#platform/logger";
import { renderUserPromptBatch } from "#runtime/user-turn-envelope";
import type { ConversationEntry } from "#storage/conversations";
import type { UnifiedEvent } from "#types";

export interface RolloutHostOptions {
  /** Absolute workspace roots under which synthetic provider sessions may be written. */
  workspaceRoots?: readonly string[];
  /** Directory containing the provider rollout fixture JSONL files. */
  fixturesDir?: string;
}

let trustedWorkspaceRoots = [
  WORKSPACE_DIR,
  DM_WORKSPACE_DIR,
  SESSION_WORKSPACE_DIR,
  TOPIC_WORKSPACE_DIR,
].map((root) => resolve(root));

/** Configure the embedding host's trusted workspace roots. */
export function configureRolloutHost(options: RolloutHostOptions): () => void {
  if (!options.workspaceRoots && !options.fixturesDir) {
    throw new Error("configureRolloutHost requires workspaceRoots or fixturesDir");
  }
  if (options.workspaceRoots?.length === 0) {
    throw new Error("configureRolloutHost requires at least one workspace root");
  }
  const previousRoots = trustedWorkspaceRoots;
  const previousFixturesDir = FIXTURES_DIR;
  if (options.workspaceRoots) {
    trustedWorkspaceRoots = options.workspaceRoots.map((root) => resolve(root));
  }
  if (options.fixturesDir) FIXTURES_DIR = resolve(options.fixturesDir);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    trustedWorkspaceRoots = previousRoots;
    FIXTURES_DIR = previousFixturesDir;
  };
}

/**
 * Captured fixture snapshots — `claude-attachments.jsonl`, `codex-shell.jsonl`,
 * etc. — live one level above the per-agent rollout files (under
 * `agents/fixtures/`) so each agent can pull from the same directory without
 * duplicating fixtures.
 *
 * To refresh fixtures: run any live Codex/Claude session, copy the first few
 * non-conversational entries from the resulting rollout file, and update
 * `src/agents/fixtures/{codex-shell,claude-attachments}.jsonl`.
 */
export let FIXTURES_DIR = resolve(PROJECT_ROOT, "src", "agents", "fixtures");

/** Deep-clone to avoid mutating cached fixture objects. */
export function clone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * UUID v4/v7 shape — both 36 chars with the standard 8-4-4-4-12 hex layout.
 * We do not enforce the version nibble because randomUUID (v4) and uuidv7
 * coexist; the only requirement for our caller is that the value is safe to
 * embed in a path component and that the SDK accepts it as a session/thread
 * identifier.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuidLike(label: string, value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`rollout: ${label} is not a UUID-shaped string: ${value}`);
  }
}

/**
 * Reject cwds that escape Otium-managed workspace roots. We use `path.resolve`
 * to normalize `..` traversal; symlink-based escapes are out of scope (the
 * workspace roots are not expected to contain attacker-controlled symlinks).
 */
function assertCwdInWorkspace(cwd: string): void {
  const abs = resolve(cwd);
  // Synthetic rollouts for spawn/fork must be written under the same root as
  // live topic turns or provider resume looks in a different cwd hash than the
  // one we generated.
  const ok = trustedWorkspaceRoots.some((root) => abs === root || abs.startsWith(`${root}/`));
  if (!ok) {
    throw new Error(`rollout: cwd outside trusted workspace roots: ${cwd} (resolved=${abs})`);
  }
}

/** Best-effort guarantee that the resumed cwd will exist when the SDK stats it. */
export function ensureCwdExists(cwd: string): void {
  assertCwdInWorkspace(cwd);
  try {
    mkdirSync(cwd, { recursive: true });
  } catch (err) {
    logger.warn({ err, cwd }, "rollout: ensureCwdExists failed — caller should pre-create cwd");
  }
}

/**
 * Length-bound a string by Unicode code points rather than UTF-16 units, so a
 * truncation never lands in the middle of a multi-byte sequence and produces
 * a malformed character. Used for in-line tool annotations where we only need
 * a rough preview, not the full payload.
 */
function truncate(text: string, n: number): string {
  const cps = Array.from(text);
  return cps.length > n ? `${cps.slice(0, n).join("")}…` : text;
}

/**
 * Reduce a UnifiedEvent stream to user/assistant message pairs. Tool calls and
 * tool results are inlined as bracketed annotations on the surrounding
 * assistant turn so the historical narrative is preserved when synthesizing a
 * native rollout for a different SDK. Streaming text deltas are folded into
 * their final consolidated `text` event to avoid double-counting partial
 * tokens.
 */
export type ChatPair = { userText: string; assistantText: string };

export interface ExtractOptions {
  includeToolAnnotations: boolean;
  formatToolUse?: (event: Extract<UnifiedEvent, { type: "tool_use" }>) => string;
  formatToolResult?: (event: Extract<UnifiedEvent, { type: "tool_result" }>) => string;
}

export function extractChatPairs(
  entries: ConversationEntry[],
  opts: ExtractOptions = { includeToolAnnotations: true },
): ChatPair[] {
  const pairs: ChatPair[] = [];
  let pendingUsers: string[] = [];
  let pendingBatchSize: number | null = null;
  let pendingBatchNextIndex = 0;
  let pendingAssistantParts: string[] = [];
  let toolBuffer: string[] = [];

  const flushAssistant = () => {
    if (pendingUsers.length === 0) return;
    const tools =
      opts.includeToolAnnotations && toolBuffer.length > 0 ? `\n\n${toolBuffer.join("\n")}` : "";
    const assistantText = pendingAssistantParts.join("").trim() + tools;
    if (assistantText.trim()) {
      pairs.push({ userText: renderUserPromptBatch(pendingUsers), assistantText });
    }
    pendingUsers = [];
    pendingBatchSize = null;
    pendingBatchNextIndex = 0;
    pendingAssistantParts = [];
    toolBuffer = [];
  };

  for (const entry of entries) {
    const ev = entry.event;
    switch (ev.type) {
      case "user_message": {
        const userEvent = ev as {
          content: string;
          consecutiveBatchSize?: number;
          consecutiveBatchIndex?: number;
        };
        if (pendingAssistantParts.length > 0 || toolBuffer.length > 0) {
          flushAssistant();
        }
        const batchSize = userEvent.consecutiveBatchSize;
        const batchIndex = userEvent.consecutiveBatchIndex;
        const marked =
          Number.isInteger(batchSize) &&
          Number.isInteger(batchIndex) &&
          (batchSize ?? 0) > 1 &&
          (batchIndex ?? -1) >= 0 &&
          (batchIndex ?? 0) < (batchSize ?? 0);
        if (!marked) {
          if (pendingUsers.length > 0) flushAssistant();
          pendingUsers.push(userEvent.content);
          pendingBatchSize = null;
          pendingBatchNextIndex = 0;
          break;
        }
        if (batchIndex === 0) {
          if (pendingUsers.length > 0) flushAssistant();
          pendingBatchSize = batchSize ?? null;
          pendingBatchNextIndex = 0;
        } else if (
          !(
            (pendingBatchSize !== null &&
              (batchSize ?? 0) >= pendingBatchSize &&
              pendingBatchNextIndex === batchIndex) ||
            (pendingBatchSize === null && pendingUsers.length === batchIndex)
          )
        ) {
          flushAssistant();
        }
        pendingUsers.push(userEvent.content);
        pendingBatchSize = batchSize ?? null;
        pendingBatchNextIndex = (batchIndex ?? 0) + 1;
        break;
      }
      case "session":
        // Session-id metadata. Provider sessions can change mid-conversation
        // (e.g. agent flip after rollout reconstruction), but the SDK normally
        // emits this *during* a turn — after the user prompt was already
        // recorded, before the assistant text arrives. Only flush when there
        // is actual assistant content in flight; otherwise we'd discard the
        // staged user prompt and the next text event would synthesize a bogus
        // "(continued)" pair.
        if (pendingAssistantParts.length > 0 || toolBuffer.length > 0) {
          flushAssistant();
        }
        break;
      case "text": {
        // Per-block assistant text. claudeProvider emits one of these per text
        // content block, so a single turn can yield multiple `text` events
        // interleaved with tool_use. Accumulate (do NOT flush yet) — the
        // turn's `result` event below carries the final concatenation and
        // is the proper boundary.
        if (pendingUsers.length === 0) {
          pendingUsers = ["(continued)"];
        }
        pendingAssistantParts.push((ev as { content: string }).content);
        break;
      }
      case "result": {
        // End-of-turn marker. `result.content` is the canonical final answer
        // produced by the provider, so prefer it over the accumulated `text`
        // chunks (which may be partial or out of order across SDKs).
        if (pendingUsers.length === 0) {
          pendingUsers = ["(continued)"];
        }
        pendingAssistantParts = [(ev as { content: string }).content];
        flushAssistant();
        break;
      }
      case "text_delta":
        // Skip — final `text`/`result` event carries the complete content.
        break;
      case "tool_use": {
        const u = ev as Extract<UnifiedEvent, { type: "tool_use" }>;
        toolBuffer.push(
          opts.formatToolUse?.(u) ??
            `<!-- Tool: ${u.name} ${truncate(JSON.stringify(u.input), 200)} -->`,
        );
        break;
      }
      case "tool_result": {
        const u = ev as Extract<UnifiedEvent, { type: "tool_result" }>;
        toolBuffer.push(
          opts.formatToolResult?.(u) ?? `<!-- Tool result: ${truncate(u.content, 200)} -->`,
        );
        break;
      }
      case "error": {
        const u = ev as { content: string };
        toolBuffer.push(`[Error: ${truncate(u.content, 200)}]`);
        break;
      }
      // Other UnifiedEvent variants (`tool_progress`, `tool_use_summary`,
      // `file`, `text_delta` already handled above) carry no conversational
      // content, so they do not contribute to a chat pair. We intentionally
      // omit a default branch — the explicit user_message variant introduced
      // by the recorder makes the previous "treat unrecognized as user" hack
      // unnecessary, and adding new UnifiedEvent variants in the future
      // should require an explicit decision here, not silent inheritance.
      case "tool_progress":
      case "tool_use_summary":
      case "file":
      case "status":
        break;
    }
  }
  flushAssistant();
  return pairs;
}
