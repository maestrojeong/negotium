import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDecisionMcpServer, type DecisionMcpHost } from "#mcp/factories/decision";
import type { StoredDecision } from "#storage/decisions";

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((entry) => entry.text ?? "")
    .join("\n");
}

describe("decision MCP factory", () => {
  test("records agent-owned decisions in the stable topic scope", async () => {
    let decisions: StoredDecision[] = [];
    const writes: Array<{ userId: string; scopeKey: string }> = [];
    const host: DecisionMcpHost = {
      readDecisions: () => decisions,
      writeDecisions: (userId, scopeKey, next) => {
        writes.push({ userId, scopeKey });
        decisions = next;
      },
    };
    const server = createDecisionMcpServer(
      {
        userId: "user-1",
        topic: "Architecture",
        topicId: "topic-1",
        agent: "codex",
        model: "gpt-5.6-sol",
      },
      host,
    );
    const client = new Client({ name: "decision-factory-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "decision_create",
        "decision_update",
        "decision_list",
        "decision_get",
        "decision_delete",
      ]);
      const created = await client.callTool({
        name: "decision_create",
        arguments: {
          decisions: [{ action: "Use Orchgraph", reasoning: "The relationships form a DAG" }],
        },
      });
      expect(textOf(created)).toContain("1 decision(s) recorded (#1)");
      expect(decisions[0]).toMatchObject({
        id: "1",
        action: "Use Orchgraph",
        status: "accepted",
        agent: "codex",
        model: "gpt-5.6-sol",
      });
      expect(writes).toEqual([{ userId: "user-1", scopeKey: "topic-1" }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns a tool error for a causal cycle", async () => {
    let decisions: StoredDecision[] = [
      {
        id: "1",
        action: "First",
        reasoning: "Root",
        agent: "codex",
        status: "accepted",
        timestamp: 1,
      },
      {
        id: "2",
        action: "Second",
        reasoning: "Derived",
        agent: "codex",
        status: "accepted",
        causedBy: ["1"],
        timestamp: 2,
      },
    ];
    const server = createDecisionMcpServer(
      { userId: "user-1", topic: "Architecture", topicId: "topic-1", agent: "codex" },
      {
        readDecisions: () => decisions,
        writeDecisions: (_userId, _scopeKey, next) => {
          decisions = next;
        },
      },
    );
    const client = new Client({ name: "decision-cycle-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "decision_update",
        arguments: { updates: [{ id: "1", caused_by: ["2"] }] },
      });
      expect(result.isError).toBeTrue();
      expect(textOf(result)).toContain("cycle");
      expect(decisions[0]?.causedBy).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
