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

export interface AgentForkHost {
  forkSession(
    agent: AgentKind,
    options: Omit<ForkAgentSessionOptions, "agent">,
  ): Promise<{ forkId: string; rolloutPath: string }>;
  exists(path: string): boolean;
  unlink(path: string): void;
  warn(details: Record<string, unknown>, message: string): void;
}

export interface AgentForkHelpers {
  forkAgentSession(options: ForkAgentSessionOptions): Promise<ForkHandle>;
  cleanupAgentFork(handle: ForkHandle): void;
}

export function createAgentForkHelpers(host: AgentForkHost): AgentForkHelpers {
  return {
    async forkAgentSession(options) {
      const { agent, ...forkOptions } = options;
      const { forkId, rolloutPath } = await host.forkSession(agent, forkOptions);
      return { agent, forkId, rolloutPath };
    },
    cleanupAgentFork(handle) {
      try {
        if (host.exists(handle.rolloutPath)) host.unlink(handle.rolloutPath);
      } catch (error) {
        host.warn(
          {
            error,
            agent: handle.agent,
            forkId: handle.forkId,
            rolloutPath: handle.rolloutPath,
          },
          "cleanupAgentFork: failed to remove rollout",
        );
      }
    },
  };
}

const defaultForkHelpers = createAgentForkHelpers({
  forkSession: (agent, options) => getRegistry(agent).forkSession(options),
  exists: existsSync,
  unlink: unlinkSync,
  warn: (details, message) => logger.warn(details, message),
});

export async function forkAgentSession(opts: ForkAgentSessionOptions): Promise<ForkHandle> {
  return defaultForkHelpers.forkAgentSession(opts);
}

/** Best-effort cleanup of a fork's rollout file. Errors are logged, never thrown. */
export function cleanupAgentFork(handle: ForkHandle): void {
  defaultForkHelpers.cleanupAgentFork(handle);
}
