import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCompactionLogMcpServer } from "#mcp/factories/compaction-log";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connect(server: ReturnType<typeof createCompactionLogMcpServer>): Promise<Client> {
  const client = new Client({ name: "compaction-log-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

describe("createCompactionLogMcpServer", () => {
  test("exposes only the bounded offset reader without a path argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "compact-log-"));
    roots.push(root);
    const filePath = join(root, "conversation.log");
    writeFileSync(filePath, ["first", "second", "third", "fourth"].join("\n"));
    const client = await connect(
      createCompactionLogMcpServer({
        filePath,
        maxCalls: 3,
        maxTotalBytes: 100,
        maxChunkBytes: 20,
      }),
    );

    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["read_compaction_log"]);
    expect(tools[0]?.inputSchema.properties).toHaveProperty("offset");
    expect(tools[0]?.inputSchema.properties).toHaveProperty("limit");
    expect(tools[0]?.inputSchema.properties).not.toHaveProperty("file_path");

    expect(
      payload(
        await client.callTool({
          name: "read_compaction_log",
          arguments: { offset: 2, limit: 2 },
        }),
      ),
    ).toMatchObject({
      content: "second\nthird",
      offset: 2,
      returned_lines: 2,
      total_lines: 4,
      next_offset: 4,
    });
    await client.close();
  });

  test("enforces call and byte budgets while clipping oversized lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "compact-log-budget-"));
    roots.push(root);
    const filePath = join(root, "conversation.log");
    writeFileSync(filePath, `start-${"x".repeat(200)}-end\nlast`);
    const client = await connect(
      createCompactionLogMcpServer({
        filePath,
        maxCalls: 1,
        maxTotalBytes: 80,
        maxChunkBytes: 80,
      }),
    );

    const first = payload(
      await client.callTool({
        name: "read_compaction_log",
        arguments: { offset: 1, limit: 10 },
      }),
    );
    expect(String(first.content)).toContain("start-");
    expect(String(first.content)).toContain("-end");
    expect(Number(first.returned_bytes)).toBeLessThanOrEqual(80);
    expect(first.note).toContain("budget exhausted");

    const exhausted = payload(
      await client.callTool({
        name: "read_compaction_log",
        arguments: { offset: 2 },
      }),
    );
    expect(exhausted.error).toContain("budget exhausted");
    await client.close();
  });
});
