import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type HostedMcpContext,
  type HostedMcpSurface,
  issueHostedMcpToken,
  type TopicDto,
} from "@negotium/core";
import { deleteTopic, deleteTopicBrief, upsertTopic } from "@negotium/core/storage";
import { closeNegotiumMcpSessions, handleNegotiumMcpRequest } from "../src/index";

let server: ReturnType<typeof Bun.serve>;

const baseContext: HostedMcpContext = {
  userId: "hosted-test-user",
  topicTitle: "hosted-test-topic",
  topicId: "hosted-test-topic-id",
  cwd: mkdtempSync(join(tmpdir(), "negotium-hosted-mcp-")),
  agent: "codex",
};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) =>
      (await handleNegotiumMcpRequest(request)) ?? new Response("not found", { status: 404 }),
  });
});

afterAll(async () => {
  await closeNegotiumMcpSessions();
  server?.stop(true);
});

async function surfaceTools(
  surface: HostedMcpSurface,
  context: HostedMcpContext = baseContext,
): Promise<string[]> {
  const token = issueHostedMcpToken(surface, context);
  const url = new URL(
    `http://127.0.0.1:${server.port}/mcp/runtime/${surface}/mcp?token=${encodeURIComponent(token)}`,
  );
  const client = new Client({ name: `hosted-${surface}-test`, version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

describe("hosted built-in MCP surfaces", () => {
  test("isolates task, token stats, and system health tools", async () => {
    expect(await surfaceTools("task")).toEqual([
      "task_create",
      "task_delete",
      "task_get",
      "task_list",
      "task_update",
    ]);
    expect(await surfaceTools("decision")).toEqual([
      "decision_create",
      "decision_delete",
      "decision_get",
      "decision_list",
      "decision_update",
    ]);
    expect(await surfaceTools("token-stats")).toEqual(["get_usage_stats"]);
    expect(await surfaceTools("system-health")).toEqual(["get_system_health"]);
    expect(await surfaceTools("agent-health")).toEqual([
      "check_agent",
      "check_all",
      "list_active_queries",
    ]);
    expect(await surfaceTools("session-comm")).toContain("list_sessions");
    expect(await surfaceTools("session-comm")).toContain("tell_session");
  });

  test("keeps wiki and skills catalogs separate", async () => {
    const wiki = await surfaceTools("wiki");
    const skills = await surfaceTools("skills");
    expect(wiki).toContain("wiki_query");
    expect(wiki).not.toContain("skill_query");
    expect(skills).toEqual(["skill_query", "skill_save"]);
  });

  test("keeps Vault discovery-only for every provider", async () => {
    expect(await surfaceTools("vault")).toEqual(["vault_list"]);
    expect(await surfaceTools("vault", { ...baseContext, agent: "claude" })).toEqual([
      "vault_list",
    ]);
  });

  test("rejects a token issued for another surface", async () => {
    const token = issueHostedMcpToken("wiki", baseContext);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/mcp/runtime/vault/mcp?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "wrong-audience", version: "1" },
          },
        }),
      },
    );
    expect(response.status).toBe(401);
  });

  test("maps reply-only context into the hosted session-comm tool policy", async () => {
    const tools = await surfaceTools("session-comm", { ...baseContext, silent: true });
    expect(tools).toContain("list_sessions");
    expect(tools).not.toContain("ask_session");
    expect(tools).not.toContain("tell_session");
    expect(tools).not.toContain("abort_session");
  });

  test("lets a room's actor read back the memory it wrote under the room's memory key", async () => {
    // An Otium tax room: the node principal owns it, an employee drives it,
    // and its memory key is not its title.
    const employee = `otium-user-${randomUUID()}`;
    const memoryKey = `tax-agent:withholding-tax:${employee}`;
    const now = new Date().toISOString();
    const room: TopicDto = {
      id: `hosted-wiki-${randomUUID()}`,
      title: `원천세 신고 · ${employee}`,
      kind: "agent",
      agent: "claude",
      defaultModel: "sonnet",
      defaultEffort: "medium",
      aiMention: false,
      participants: [{ userId: "local", role: "owner" }],
      createdAt: now,
      lastMessageAt: now,
      memoryKey,
    };
    upsertTopic(room);
    const token = issueHostedMcpToken("wiki", {
      ...baseContext,
      userId: employee,
      topicId: room.id,
      topicTitle: room.title,
    });
    const client = new Client({ name: "hosted-wiki-memory-test", version: "1.0.0" });
    const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
      (result.content as Array<{ text?: string }>).map((entry) => entry.text ?? "").join("\n");
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${server.port}/mcp/runtime/wiki/mcp?token=${encodeURIComponent(token)}`,
          ),
        ),
      );
      const saved = await client.callTool({
        name: "wiki_write",
        arguments: {
          kind: "topic",
          topic: memoryKey,
          content: "Files on the 10th.",
          description: "Due date",
        },
      });
      expect(text(saved)).toContain("SQLite brief also updated.");
      const read = await client.callTool({
        name: "wiki_read",
        arguments: { kind: "topic", key: memoryKey },
      });
      expect(text(read)).toContain("Files on the 10th.");
      const renamed = await client.callTool({
        name: "wiki_write",
        arguments: {
          kind: "topic",
          topic: "원천세 신고",
          content: "Elsewhere.",
          description: "Due date",
        },
      });
      expect(renamed.isError).toBe(true);
    } finally {
      await client.close();
      deleteTopic(room.id);
      deleteTopicBrief(memoryKey.replaceAll(":", "-"));
    }
  });
});
