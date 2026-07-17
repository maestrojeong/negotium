import { claudeProvider } from "#agents/claude-provider";
import { codexProvider } from "#agents/codex-provider";
import {
  type AgentExecutionHost,
  configureAgentExecutionHost,
  transformHostedQueryOptions,
} from "#agents/execution-host";
import { maestroProvider } from "#agents/maestro-provider";
import type { AgentQueryOptions, UnifiedEvent } from "#types";

export { type AgentExecutionHost, configureAgentExecutionHost };

/**
 * Provider-only execution entry point for embedding hosts.
 *
 * Conversation persistence, authorization, placement, and topic lifecycle are
 * deliberately not handled here; those remain the embedding host's concern.
 */
export async function* runHostedAgent(input: AgentQueryOptions): AsyncGenerator<UnifiedEvent> {
  const opts = transformHostedQueryOptions({ ...input });
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
      throw new Error(`runHostedAgent: unknown agent '${exhaustive}'`);
    }
  }
}
