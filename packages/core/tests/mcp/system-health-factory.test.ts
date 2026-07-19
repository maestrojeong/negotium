import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSystemHealthMcpServer } from "#mcp/factories/system-health";

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((entry) => entry.text ?? "")
    .join("\n");
}

describe("system health MCP factory", () => {
  test("formats a host-provided snapshot without probing the process", async () => {
    const server = createSystemHealthMcpServer({
      readSystemHealth: async () => ({
        cpuLoad: [1, 2, 3],
        cpuCount: 8,
        memoryTotal: 16 * 1024 ** 3,
        memoryFree: 4 * 1024 ** 3,
        memoryPressure: "normal",
        swap: "none",
        disk: "10GB / 100GB (10%)",
        thermal: "nominal",
        processCount: 123,
      }),
    });
    const client = new Client({ name: "system-health-factory-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "get_system_health", arguments: {} });
      expect(textOf(result)).toContain("1.00 / 2.00 / 3.00");
      expect(textOf(result)).toContain("코어 8개");
      expect(textOf(result)).toContain("프로세스 수:   123개");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
