import { existsSync, unlinkSync } from "node:fs";
import type { ForkRegistryResult } from "#agents/contracts";
import { getRegistryOperations } from "#agents/registry";
import { logger } from "#platform/logger";
import type { AgentKind, EffortLevel } from "#types";

/**
 * Agent-aware fork primitives.
 *
 * Strategy lives in each agent's registry (`*-registry.ts:forkSession`).
 * Claude uses the SDK's native `forkSession`, Codex uses App Server's native
 * `thread/fork`, and Maestro uses the SDK's `forkSessionAt`. Providers without
 * a native branch primitive synthesize from the provider-agnostic conversation
 * log. All surfaces converge on ForkHandle.
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
  /** Additional provider-owned files removed with the primary rollout. */
  cleanupPaths?: string[];
}

export interface AgentForkHost {
  forkSession(
    agent: AgentKind,
    options: Omit<ForkAgentSessionOptions, "agent">,
  ): Promise<ForkRegistryResult>;
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
      const { forkId, rolloutPath, cleanupPaths } = await host.forkSession(agent, forkOptions);
      return { agent, forkId, rolloutPath, ...(cleanupPaths?.length ? { cleanupPaths } : {}) };
    },
    cleanupAgentFork(handle) {
      for (const path of [handle.rolloutPath, ...(handle.cleanupPaths ?? [])]) {
        try {
          if (host.exists(path)) host.unlink(path);
        } catch (error) {
          host.warn(
            {
              error,
              agent: handle.agent,
              forkId: handle.forkId,
              path,
            },
            "cleanupAgentFork: failed to remove rollout",
          );
        }
      }
    },
  };
}

const defaultForkHelpers = createAgentForkHelpers({
  forkSession: (agent, options) => getRegistryOperations(agent).forkSession(options),
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
