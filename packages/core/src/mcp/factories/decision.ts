import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errMsg } from "#platform/error";
import {
  createDecisions,
  DECISION_STATUS_VALUES,
  decisionScopeKey,
  deleteDecisions,
  readDecisions,
  renderDecisionList,
  type StoredDecision,
  updateDecisions,
  writeDecisions,
} from "#storage/decisions";
import type { AgentKind } from "#types";
import { mcpError, mcpOk } from "../mcp-helpers";

export interface DecisionMcpContext {
  userId: string;
  topic: string;
  topicId?: string;
  agent: AgentKind;
  model?: string;
}

export interface DecisionMcpHost {
  readDecisions(userId: string, scopeKey: string): StoredDecision[];
  writeDecisions(userId: string, scopeKey: string, decisions: StoredDecision[]): void;
}

export const defaultDecisionMcpHost: DecisionMcpHost = { readDecisions, writeDecisions };

export function createDecisionMcpServer(
  context: DecisionMcpContext,
  host: DecisionMcpHost = defaultDecisionMcpHost,
): McpServer {
  const scopeKey = context.topic
    ? decisionScopeKey({ topicId: context.topicId, session: context.topic })
    : "";
  const server = new McpServer({ name: "decision", version: "1.0.0" });
  const requireContext = (): ReturnType<typeof mcpError> | null =>
    !context.userId || !scopeKey ? mcpError("Error: missing userId/topic context.") : null;
  const statusEnum = z.enum(DECISION_STATUS_VALUES);

  server.tool(
    "decision_create",
    "Record one or more durable decisions in this topic. Include the rationale and causal predecessors.",
    {
      decisions: z
        .array(
          z.object({
            action: z.string().min(1).describe("Concise statement of what was decided"),
            reasoning: z.string().min(1).describe("Why this choice was made"),
            status: statusEnum.optional().describe("Defaults to accepted"),
            caused_by: z.array(z.string()).optional().describe("Upstream decision ids"),
          }),
        )
        .min(1),
    },
    async ({ decisions: inputs }) => {
      const guard = requireContext();
      if (guard) return guard;
      try {
        const current = host.readDecisions(context.userId, scopeKey);
        const { decisions, created } = createDecisions(
          current,
          inputs.map((input) => ({
            action: input.action,
            reasoning: input.reasoning,
            status: input.status,
            causedBy: input.caused_by,
            agent: context.agent,
            model: context.model,
          })),
        );
        host.writeDecisions(context.userId, scopeKey, decisions);
        return mcpOk(
          `${created.length} decision(s) recorded (${created.map((item) => `#${item.id}`).join(", ")})\n\n${renderDecisionList(decisions)}`,
        );
      } catch (error) {
        return mcpError(`decision_create failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool(
    "decision_update",
    "Update decisions or their causal links in this topic.",
    {
      updates: z
        .array(
          z.object({
            id: z.string(),
            action: z.string().min(1).optional(),
            reasoning: z.string().min(1).optional(),
            status: statusEnum.optional(),
            caused_by: z.array(z.string()).optional().describe("Replacement upstream decision ids"),
          }),
        )
        .min(1),
    },
    async ({ updates }) => {
      const guard = requireContext();
      if (guard) return guard;
      try {
        const current = host.readDecisions(context.userId, scopeKey);
        const { decisions, missing } = updateDecisions(
          current,
          updates.map((update) => ({
            ...update,
            causedBy: update.caused_by,
          })),
        );
        host.writeDecisions(context.userId, scopeKey, decisions);
        const warning = missing.length ? `\nMissing ids ignored: ${missing.join(", ")}` : "";
        return mcpOk(`${renderDecisionList(decisions)}${warning}`);
      } catch (error) {
        return mcpError(`decision_update failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool(
    "decision_list",
    "Read this topic's decision graph as a concise list.",
    {},
    async () => {
      const guard = requireContext();
      if (guard) return guard;
      try {
        return mcpOk(renderDecisionList(host.readDecisions(context.userId, scopeKey)));
      } catch (error) {
        return mcpError(`decision_list failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool(
    "decision_get",
    "Read one topic decision as JSON.",
    { id: z.string() },
    async ({ id }) => {
      const guard = requireContext();
      if (guard) return guard;
      try {
        const decision = host
          .readDecisions(context.userId, scopeKey)
          .find((item) => item.id === id);
        return decision
          ? mcpOk(JSON.stringify(decision, null, 2))
          : mcpError(`Decision #${id} not found.`);
      } catch (error) {
        return mcpError(`decision_get failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool(
    "decision_delete",
    "Delete decisions. Downstream causal references to deleted decisions are removed.",
    { ids: z.array(z.string()).optional(), all: z.boolean().optional() },
    async ({ ids, all }) => {
      const guard = requireContext();
      if (guard) return guard;
      if (!all && (!ids || ids.length === 0)) return mcpError("Provide ids or all=true.");
      try {
        const current = host.readDecisions(context.userId, scopeKey);
        const { decisions, removed } = deleteDecisions(current, { ids, all });
        host.writeDecisions(context.userId, scopeKey, decisions);
        return mcpOk(`${removed} decision(s) deleted\n\n${renderDecisionList(decisions)}`);
      } catch (error) {
        return mcpError(`decision_delete failed: ${errMsg(error)}`);
      }
    },
  );

  return server;
}
