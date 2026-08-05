import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTokenStatsMcpServer, type TokenStatsMcpHost } from "#mcp/factories/token-stats";

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((entry) => entry.text ?? "")
    .join("\n");
}

describe("token stats MCP factory", () => {
  test("formats caller-owned usage data without global storage", async () => {
    const seen: Array<{ userId: string; from?: string; to?: string }> = [];
    const bucket = {
      inputTokens: 1_000,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      queries: 2,
      estimatedCostUsd: 0.006,
    };
    const host: TokenStatsMcpHost = {
      getStats: (userId, from, to) => {
        seen.push({ userId, from, to });
        return {
          total: bucket,
          byHour: {},
          bySession: { dev: bucket },
          currentSessions: [
            {
              timestamp: "2026-01-01T01:00:00Z",
              topicId: "topic-1",
              topicTitle: "dev",
              providerSessionId: "provider-session-1",
              agent: "codex",
              model: "gpt-5.6-luna",
              contextTokens: 25_000,
              contextWindow: 100_000,
            },
          ],
          ignoredLegacyRecords: 3,
          estimatedCostUsd: 0.006,
        };
      },
      calcCost: () => 0.006,
      extraSummaryLines: () => ["host metric"],
    };
    const server = createTokenStatsMcpServer({ userId: "user-1" }, host);
    const client = new Client({ name: "token-stats-factory-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "get_usage_stats",
      ]);
      const result = await client.callTool({
        name: "get_usage_stats",
        arguments: { from: "2026-01-01T00:00:00Z", groupBy: "session" },
      });
      expect(textOf(result)).toContain("쿼리 횟수: 2회");
      expect(textOf(result)).toContain("dev");
      expect(textOf(result)).toContain("25,000 / 100,000 (25.0%)");
      expect(textOf(result)).toContain("구형 레코드 제외: 3건");
      expect(textOf(result)).toContain("host metric");
      expect(seen).toEqual([{ userId: "user-1", from: "2026-01-01T00:00:00Z", to: undefined }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("requires a user context", () => {
    expect(() => createTokenStatsMcpServer({ userId: "" })).toThrow("requires userId");
  });
});
