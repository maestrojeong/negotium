import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type HostedMcpContext, type HostedMcpSurface, issueHostedMcpToken } from "@negotium/core";
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

  test("keeps Vault mutation tools limited to Codex", async () => {
    expect(await surfaceTools("vault")).toEqual(["vault_http_request", "vault_list", "vault_run"]);
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
});
