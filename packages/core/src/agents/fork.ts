import { existsSync, unlinkSync } from "node:fs";
import { getRegistry } from "#agents/registry";
import { logger } from "#platform/logger";
import type { AgentKind, EffortLevel } from "#types";

/**
 * Agent-aware fork primitives.
 *
 * Strategy lives in each agent's registry (`*-registry.ts:forkSession`).
 * Claude uses the SDK's native `forkSession` (byte-equivalent rollout copy);
 * Codex synthesizes a rollout from the provider-agnostic conversation log
 * because the SDK has no fork API. Both surfaces converge on `ForkHandle`.
 */

export interface ForkAgentSessionOptions {
  agent: AgentKind;
  /** Parent session/thread id to clone from. */
  parentSessionId: string;
  /** Workspace directory the resumed fork will report. Claude also writes
   *  the rollout file under this directory. */
  cwd: string;
  /** Used to locate the conversation log for codex synthesis. */
  userId: number | string;
  /** Used to locate the conversation log for codex synthesis. */
  topicName: string;
  /** Optional title forwarded to Claude SDK forkSession; ignored by Codex. */
  title?: string;
  /** Effective model/effort the fork will use when it resumes. */
  model?: string;
  effort?: EffortLevel;
}

export interface ForkHandle {
  agent: AgentKind;
  forkId: string;
  /** Absolute path of the rollout file to remove on cleanup. */
  rolloutPath: string;
}

export async function forkAgentSession(opts: ForkAgentSessionOptions): Promise<ForkHandle> {
  const { forkId, rolloutPath } = await getRegistry(opts.agent).forkSession({
    parentSessionId: opts.parentSessionId,
    cwd: opts.cwd,
    userId: opts.userId,
    topicName: opts.topicName,
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });
  return { agent: opts.agent, forkId, rolloutPath };
}

/** Best-effort cleanup of a fork's rollout file. Errors are logged, never thrown. */
export function cleanupAgentFork(handle: ForkHandle): void {
  try {
    if (existsSync(handle.rolloutPath)) {
      unlinkSync(handle.rolloutPath);
    }
  } catch (err) {
    logger.warn(
      { err, agent: handle.agent, forkId: handle.forkId, rolloutPath: handle.rolloutPath },
      "cleanupAgentFork: failed to remove rollout",
    );
  }
}
