import { claudeProvider } from "#agents/claude-provider";
import { codexProvider } from "#agents/codex-provider";
import {
  type AgentExecutionHost,
  configureAgentExecutionHost,
  resolveAgentExecutionHost,
  transformHostedQueryOptions,
  withAgentExecutionHost,
} from "#agents/execution-host";
import { maestroProvider } from "#agents/maestro-provider";
import { revokeCanonicalMcpBridgeTurn } from "#mcp/canonical-bridge-config";
import type { AgentQueryOptions, UnifiedEvent } from "#types";

export {
  buildClaudeDisallowedTools,
  claudeProvider,
  spawnClaudeCodeProcessWithTreeKill,
} from "#agents/claude-provider";
export {
  type BundledClaudeRuntime,
  inspectBundledClaudeRuntime,
} from "#agents/claude-runtime-inspection";
export { codexProvider, toCodexMcpServers } from "#agents/codex-provider";
export {
  buildMaestroDisallowedTools,
  buildMaestroToolHooks,
  maestroProvider,
} from "#agents/maestro-provider";
export type { AgentQueryOptions, UnifiedEvent };
export { type AgentExecutionHost, configureAgentExecutionHost };

/**
 * Provider-only execution entry point for embedding hosts.
 *
 * Conversation persistence, authorization, placement, and topic lifecycle are
 * deliberately not handled here; those remain the embedding host's concern.
 */
export async function* runHostedAgent(
  input: AgentQueryOptions,
  host?: Partial<AgentExecutionHost>,
): AsyncGenerator<UnifiedEvent> {
  const executionHost = resolveAgentExecutionHost(host);
  const opts = await withAgentExecutionHost(executionHost, async () =>
    transformHostedQueryOptions({ ...input }),
  );
  try {
    let events: AsyncGenerator<UnifiedEvent>;
    switch (opts.agent) {
      case "claude":
        events = claudeProvider(opts);
        break;
      case "codex":
        events = codexProvider(opts);
        break;
      case "maestro":
        events = maestroProvider(opts);
        break;
      default: {
        const exhaustive: never = opts.agent;
        throw new Error(`runHostedAgent: unknown agent '${exhaustive}'`);
      }
    }
    while (true) {
      const next = await withAgentExecutionHost(executionHost, () => events.next());
      if (next.done) return;
      yield next.value;
    }
  } finally {
    if (opts.userId && opts.topicId && opts.queryId && opts.peerBridge) {
      revokeCanonicalMcpBridgeTurn({
        userId: opts.userId,
        topicId: opts.topicId,
        queryId: opts.queryId,
        peerBridge: opts.peerBridge,
      });
    }
  }
}
