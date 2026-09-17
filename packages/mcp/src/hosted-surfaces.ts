import { resolve } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HostedMcpContext, HostedMcpSurface } from "@negotium/core/mcp-runtime-host";

export interface HostedMcpServer {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export const ACTIVE_HOSTED_MCP_SURFACES = [
  "task",
  "decision",
  "token-stats",
  "system-health",
  "vault",
  "wiki",
  "skills",
  "agent-health",
  "session-comm",
] as const satisfies readonly HostedMcpSurface[];

export type ActiveHostedMcpSurface = (typeof ACTIVE_HOSTED_MCP_SURFACES)[number];

export function isActiveHostedMcpSurface(
  surface: HostedMcpSurface,
): surface is ActiveHostedMcpSurface {
  return (ACTIVE_HOSTED_MCP_SURFACES as readonly string[]).includes(surface);
}

/** Build one context-bound logical MCP server inside the shared runtime process. */
export async function buildHostedSurfaceServer(
  surface: ActiveHostedMcpSurface,
  context: HostedMcpContext,
): Promise<HostedMcpServer> {
  switch (surface) {
    case "task": {
      const { createTaskMcpServer } = await import("@negotium/core/mcp-factories/task");
      return createTaskMcpServer({
        userId: context.userId,
        topic: context.topicTitle,
        topicId: context.topicId,
      });
    }
    case "decision": {
      const { createDecisionMcpServer } = await import("@negotium/core/mcp-factories/decision");
      return createDecisionMcpServer({
        userId: context.userId,
        topic: context.topicTitle,
        topicId: context.topicId,
        agent: context.agent,
        model: context.model,
      });
    }
    case "token-stats": {
      const { createTokenStatsMcpServer } = await import(
        "@negotium/core/mcp-factories/token-stats"
      );
      return createTokenStatsMcpServer({ userId: context.userId });
    }
    case "system-health": {
      const { createSystemHealthMcpServer } = await import(
        "@negotium/core/mcp-factories/system-health"
      );
      return createSystemHealthMcpServer();
    }
    case "agent-health": {
      const { createAgentHealthMcpServer } = await import(
        "@negotium/core/mcp-factories/agent-health"
      );
      return createAgentHealthMcpServer({ userId: context.userId });
    }
    case "session-comm": {
      const [{ createSessionCommMcpServer }, { createDefaultSessionCommMcpHost }, core] =
        await Promise.all([
          import("@negotium/core/mcp-factories/session-comm"),
          import("@negotium/core/session-comm-host"),
          import("@negotium/core/mcp-runtime-host"),
        ]);
      return createSessionCommMcpServer(
        {
          userId: context.userId,
          currentTopic: context.topicTitle,
          currentTopicId: context.topicId,
          currentThreadRootId: context.threadRootId,
          subagentParentTopicId: context.subagentParentTopicId,
          peerHostQueryId: context.peerBridge?.hostQueryId,
          depth: context.depth ?? 0,
          replyOnly: context.silent ?? false,
          agent: context.agent,
        },
        createDefaultSessionCommMcpHost(),
        {
          requiredMcpServers: core.REQUIRED_FORUM_MCP_SERVERS,
          optionalMcpServers: core.OPTIONAL_FORUM_MCP_SERVERS,
        },
      );
    }
    case "vault": {
      const [{ createVaultMcpServer }, vault] = await Promise.all([
        import("@negotium/core/mcp-factories/vault"),
        import("@negotium/core/vault"),
      ]);
      return createVaultMcpServer({ userId: context.userId }, { list: vault.vaultList });
    }
    case "wiki":
    case "skills": {
      const [{ createWikiMcpServer }, storage, { WORKSPACE_DIR }] = await Promise.all([
        import("@negotium/core/mcp-factories/wiki"),
        import("@negotium/core/storage"),
        import("@negotium/core/mcp-runtime-host"),
      ]);
      const topicId = context.wikiTopicId ?? context.topicId;
      const accessibleTopicBrief = (selection: string) => {
        const normalized = selection.trim().toLowerCase();
        const topics = storage
          .listTopics()
          .filter(
            (topic) =>
              topic.visibility !== "hidden" &&
              topic.participants.some((participant) => participant.userId === context.userId),
          );
        const topic =
          topics.find((candidate) => candidate.id === selection) ??
          topics.find((candidate) => candidate.title.trim().toLowerCase() === normalized);
        if (!topic) return null;
        return storage.resolveTopicBrief(topic.id, topic.title)?.brief ?? null;
      };
      return createWikiMcpServer(
        {
          userId: context.userId,
          ...(topicId ? { topicId } : {}),
          surface,
        },
        {
          wikiRoot: resolve(WORKSPACE_DIR, "wiki"),
          getTopicBrief: storage.getTopicBrief,
          resolveTopicBrief: accessibleTopicBrief,
          setTopicBrief: storage.setTopicBrief,
        },
      );
    }
  }
}
