import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  canonicalMcpBridgeEnv,
  revokeCanonicalMcpBridgeTurn,
} from "@negotium/core/canonical-mcp-bridge";
import { startCanonicalMcpBridge } from "@/canonical-mcp-bridge";

describe("canonical MCP loopback bridge", () => {
  test("issues a turn-scoped capability and rejects absent or disallowed access", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = startCanonicalMcpBridge({
      forwardTool: async (capability, request) => {
        calls.push({ ...capability, ...request });
        return { result: { content: [{ type: "text", text: "hub value" }] } };
      },
    });
    try {
      const scope = {
        surface: "task" as const,
        userId: "user-a",
        topicId: "worker-topic",
        queryId: "worker-query",
        peerBridge: {
          hubCellId: "hub-cell",
          hostTopicId: "hub-topic",
          hostQueryId: "hub-query",
          canSpawnSubagents: false,
        },
      };
      const env = canonicalMcpBridgeEnv(scope);
      expect(env).toBeDefined();
      expect((await fetch(bridge.url, { method: "POST", body: "{}" })).status).toBe(401);

      const response = await fetch(bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env?.NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool: "task_list", input: {} }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        result: { content: [{ type: "text", text: "hub value" }] },
      });
      expect(calls).toEqual([
        expect.objectContaining({
          surface: "task",
          userId: "user-a",
          hostTopicId: "hub-topic",
          hostQueryId: "hub-query",
          hubCellId: "hub-cell",
          tool: "task_list",
        }),
      ]);
      const proxyServer = `${import.meta.dir}/../../../packages/core/src/mcp/canonical-proxy-server.ts`;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["run", proxyServer, "--surface=task"],
        env: { ...process.env, ...env } as Record<string, string>,
        stderr: "pipe",
      });
      const client = new Client({ name: "canonical-bridge-test", version: "1.0.0" });
      try {
        await client.connect(transport);
        const result = await client.callTool({ name: "task_list", arguments: {} });
        expect(result.content).toEqual([{ type: "text", text: "hub value" }]);
      } finally {
        await client.close();
      }
      expect(calls).toHaveLength(2);
      const denied = await fetch(bridge.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env?.NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ tool: "skill_query", input: { question: "private" } }),
      });
      expect(denied.status).toBe(403);
      expect(revokeCanonicalMcpBridgeTurn(scope)).toBe(1);
      expect(
        (
          await fetch(bridge.url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${env?.NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ tool: "task_list", input: {} }),
          })
        ).status,
      ).toBe(401);
    } finally {
      bridge.stop();
    }
    expect(
      canonicalMcpBridgeEnv({
        surface: "task",
        userId: "u",
        topicId: "t",
        queryId: "q",
        peerBridge: {
          hubCellId: "h",
          hostTopicId: "ht",
          hostQueryId: "hq",
          canSpawnSubagents: false,
        },
      }),
    ).toBeUndefined();
  });

  test("forwards wiki_write on the wiki surface and still denies non-wiki tools", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const bridge = startCanonicalMcpBridge({
      forwardTool: async (capability, request) => {
        calls.push({ ...capability, ...request });
        return { result: { content: [{ type: "text", text: "ok" }] } };
      },
    });
    try {
      const scope = {
        surface: "wiki" as const,
        userId: "user-w",
        topicId: "worker-topic",
        queryId: "worker-query",
        peerBridge: {
          hubCellId: "hub-cell",
          hostTopicId: "hub-topic",
          hostQueryId: "hub-query",
          canSpawnSubagents: false,
        },
      };
      const env = canonicalMcpBridgeEnv(scope);
      const headers = {
        authorization: `Bearer ${env?.NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN}`,
        "content-type": "application/json",
      };

      // Regression guard: wiki_write must be allowlisted on the wiki
      // surface, otherwise a remote/placed archiver can save the summary but is
      // 403-blocked from persisting the accumulated brief.
      const allowed = await fetch(bridge.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tool: "wiki_write",
          input: { kind: "topic", content: "# brief", description: "brief" },
        }),
      });
      expect(allowed.status).toBe(200);
      expect(calls.at(-1)).toMatchObject({ surface: "wiki", tool: "wiki_write" });

      const read = await fetch(bridge.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          tool: "wiki_read",
          input: { kind: "topic", key: "persona", adopt: true },
        }),
      });
      expect(read.status).toBe(200);
      expect(calls.at(-1)).toMatchObject({
        surface: "wiki",
        hostTopicId: "hub-topic",
        tool: "wiki_read",
        input: { kind: "topic", key: "persona", adopt: true },
      });

      // A tool outside the wiki allowlist is still rejected.
      const denied = await fetch(bridge.url, {
        method: "POST",
        headers,
        body: JSON.stringify({ tool: "task_list", input: {} }),
      });
      expect(denied.status).toBe(403);

      revokeCanonicalMcpBridgeTurn(scope);
    } finally {
      bridge.stop();
    }
  });
});
