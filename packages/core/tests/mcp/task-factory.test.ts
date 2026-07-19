import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTaskMcpServer, type TaskMcpHost } from "#mcp/factories/task";
import type { StoredTask } from "#storage/tasks";

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .map((entry) => entry.text ?? "")
    .join("\n");
}

describe("task MCP factory", () => {
  test("uses caller-owned storage and exposes the canonical task contract", async () => {
    let tasks: StoredTask[] = [];
    const writes: Array<{ userId: string; scopeKey: string }> = [];
    const host: TaskMcpHost = {
      readTasks: () => tasks,
      writeTasks: (userId, scopeKey, next) => {
        writes.push({ userId, scopeKey });
        tasks = next;
      },
    };
    const server = createTaskMcpServer(
      { userId: "user-1", topic: "dev", topicId: "topic-1" },
      host,
    );
    const client = new Client({ name: "task-factory-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "task_create",
        "task_update",
        "task_list",
        "task_get",
        "task_delete",
      ]);
      const created = await client.callTool({
        name: "task_create",
        arguments: { tasks: [{ subject: "Factory test" }] },
      });
      expect(textOf(created)).toContain("1 task(s) created (#1)");
      expect(tasks).toEqual([{ id: "1", subject: "Factory test", status: "pending" }]);
      expect(writes).toEqual([{ userId: "user-1", scopeKey: "topic-1" }]);
      expect(textOf(await client.callTool({ name: "task_list", arguments: {} }))).toContain(
        "#1 Factory test",
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects calls without topic context before touching the host", async () => {
    let reads = 0;
    const server = createTaskMcpServer(
      { userId: "user-1", topic: "" },
      {
        readTasks: () => {
          reads += 1;
          return [];
        },
        writeTasks: () => {},
      },
    );
    const client = new Client({ name: "task-factory-guard-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "task_list", arguments: {} });
      expect(textOf(result)).toContain("missing userId/topic context");
      expect(result.isError).toBeTrue();
      expect(reads).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
