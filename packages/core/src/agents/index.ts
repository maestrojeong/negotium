import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProvider } from "#agents/claude-provider";
import { codexProvider } from "#agents/codex-provider";
import { maestroProvider } from "#agents/maestro-provider";
import { getRegistry } from "#agents/registry";
import { encodeClaudeCwd } from "#agents/rollout/claude";
import { resolveTaskEventScope, withTaskSnapshots } from "#agents/task-events";
import { logger } from "#platform/logger";
import { appendConversationEvent, readConversation } from "#storage/conversations";
import type { AgentKind, AgentQueryOptions, UnifiedEvent } from "#types";

export { isAgentKind, SUPPORTED_AGENTS } from "#types";

/**
 * Dispatch only — no recording. Used by code paths that already record
 * elsewhere or by callers that explicitly want a side-effect-free stream
 * (e.g. silent fork queries used by session-comm).
 */
async function* dispatchAgent(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  switch (opts.agent) {
    case "claude":
      yield* claudeProvider(opts);
      return;
    case "codex":
      yield* codexProvider(opts);
      return;
    case "maestro":
      yield* maestroProvider(opts);
      return;
    default: {
      const exhaustive: never = opts.agent;
      throw new Error(`runAgent: unknown agent '${exhaustive}'`);
    }
  }
}

/**
 * Single entry point for executing a query against any supported agent.
 *
 * In addition to dispatching to the right provider, this transparently
 * records every yielded UnifiedEvent into the per-topic conversation log
 * (`{DATA_DIR}/conversations/{userId}/{topic}.jsonl`). The log is the
 * provider-agnostic source of truth that powers cross-agent portability
 * (see codex-add-plan/14-cross-agent-portability.md).
 *
 * Recording is best-effort: a write failure is logged but never breaks the
 * live stream that flows to Telegram.
 *
 * Recording is *skipped* for `silent` runs (used by session-comm forks) and
 * for queries that lack identifying context (no userId or no session/topic),
 * since those calls do not represent a real user-visible conversation.
 *
 * Adding a new agent = implement a `xyzProvider(opts): AsyncGenerator<UnifiedEvent>`
 * function and add a case in `dispatchAgent`. No call sites need to change.
 */
/**
 * Decide whether the live stream should be persisted to the conversation log.
 * The narrowing helper exists so the recording branch in `runAgent` can use
 * `opts.userId`/`opts.session` without `!`-asserts: when this returns true the
 * compiler knows both are non-empty strings.
 */
function shouldRecordTurn(
  opts: AgentQueryOptions,
): opts is AgentQueryOptions & { userId: string; session: string } {
  return (
    !opts.silent &&
    typeof opts.userId === "string" &&
    opts.userId.length > 0 &&
    typeof opts.session === "string" &&
    opts.session.length > 0
  );
}

/**
 * Decide whether a query has enough topic context to repair a stale SDK-native
 * session before dispatch. Unlike recording, silent fork queries still need this
 * path so they can resume from rebuilt rollouts without writing to the log.
 */
function hasSessionRepairContext(
  opts: AgentQueryOptions,
): opts is AgentQueryOptions & { userId: string; session: string } {
  return (
    typeof opts.userId === "string" &&
    opts.userId.length > 0 &&
    typeof opts.session === "string" &&
    opts.session.length > 0
  );
}

/**
 * Check whether the SDK-native session file for the given agent / sessionId is
 * missing from disk (deleted by SDK housekeeping, stale ref, etc.).
 */
async function resolveSessionFileMissing(
  agent: AgentKind,
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  switch (agent) {
    case "claude": {
      const encodedCwd = encodeClaudeCwd(cwd);
      const path = join(homedir(), ".claude", "projects", encodedCwd, `${sessionId}.jsonl`);
      return !existsSync(path);
    }
    case "codex": {
      const sessionsDir = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
      const glob = new Bun.Glob(`**/rollout-*-${sessionId}.jsonl`);
      for await (const _rel of glob.scan({ cwd: sessionsDir, onlyFiles: true })) {
        return false; // found at least one match → session exists
      }
      return true; // no match found
    }
    case "maestro": {
      const path = join(homedir(), ".maestro", "sessions", `${sessionId}.jsonl`);
      return !existsSync(path);
    }
    default: {
      const _exhaustive: never = agent;
      return false; // unknown agent → don't block
    }
  }
}

/**
 * Rebuild a missing SDK session file from the unified conversation log, or
 * fall back to a fresh session. Returns true when the session file is confirmed
 * to exist (either pre-existing or successfully rebuilt), false when the agent
 * should start a fresh session (no entries, rebuild failed, etc.).
 */
async function maybeRebuildSession(
  opts: AgentQueryOptions & { userId: string; session: string },
): Promise<boolean> {
  if (!opts.sessionId) return true; // fresh session, nothing to rebuild

  try {
    const missing = await resolveSessionFileMissing(opts.agent, opts.sessionId, opts.cwd);
    if (!missing) return true; // file still on disk

    logger.info(
      { agent: opts.agent, sessionId: opts.sessionId, topic: opts.session },
      "session file missing — rebuilding from unified log",
    );

    const entries = readConversation(opts.userId, opts.session);
    if (entries.length === 0) {
      logger.info(
        { agent: opts.agent, sessionId: opts.sessionId },
        "no unified log entries to rebuild — starting fresh session",
      );
      return false;
    }

    const registry = getRegistry(opts.agent);
    const result = registry.writeRollout({
      cwd: opts.cwd,
      entries,
      reuseSessionId: opts.sessionId,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
    });
    logger.info(
      { agent: opts.agent, sessionId: result.sessionId, rolloutPath: result.rolloutPath },
      "session rebuilt from unified log",
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, agent: opts.agent, sessionId: opts.sessionId },
      "session rebuild failed — starting fresh session",
    );
    return false;
  }
}

export async function* runAgent(opts: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  const recording = shouldRecordTurn(opts);
  const dispatchOpts: AgentQueryOptions = { ...opts };

  if (hasSessionRepairContext(dispatchOpts)) {
    const ok = await maybeRebuildSession(dispatchOpts);
    if (!ok) {
      // Rebuild failed / no entries → clear sessionId so the agent starts
      // a fresh session instead of trying to resume a non-existent one.
      dispatchOpts.sessionId = undefined;
    }
  }

  const taskScope = resolveTaskEventScope(dispatchOpts);
  const stream = taskScope
    ? withTaskSnapshots(dispatchAgent(dispatchOpts), taskScope)
    : dispatchAgent(dispatchOpts);

  for await (const event of stream) {
    // `tasks` is an ephemeral live-UI signal — it carries no conversation
    // content and is fully reconstructable from the agent's task store, so we
    // render it (yield) but never persist it. Logging it would bloat the
    // rollout and feed a non-message event into cross-agent bridge replay.
    if (recording && event.type !== "tasks") {
      appendConversationEvent(opts.userId, opts.session, opts.agent, event);
    }
    yield event;
  }
}
