import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  issueRuntimeMcpToken,
  type PeerRuntimeSpawnRequest,
  type RuntimeMcpContext,
  registerPeerRuntimeBridge,
  registerTopic,
  textResult,
} from "@negotium/core";
import { handleNegotiumMcpRequest } from "../src/index";

function resultText(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ text?: string }>;
  return content.map((entry) => entry.text ?? "").join("\n");
}

describe("placed-room runtime bridge", () => {
  test("spawn_subagent is exposed for a placed mirror and forwards instead of spawning locally", async () => {
    const topic = registerTopic({
      title: `peer-mirror-${crypto.randomUUID()}`,
      userId: "peer-user",
      agent: "claude",
    });
    const calls: PeerRuntimeSpawnRequest[] = [];
    const unregister = registerPeerRuntimeBridge({
      async spawnSubagent(request) {
        calls.push(request);
        return textResult("spawned by canonical hub");
      },
    });
    const ctx: RuntimeMcpContext = {
      userId: "peer-user",
      topicId: topic.id,
      topicTitle: topic.title,
      cwd: mkdtempSync(join(tmpdir(), "negotium-peer-mcp-")),
      agent: "claude",
      model: "sonnet",
      peerBridge: {
        hubCellId: "hub-cell",
        hostTopicId: "host-topic",
        hostQueryId: "host-query",
        canSpawnSubagents: true,
      },
    };
    const server = Bun.serve({
      port: 0,
      fetch: async (req) =>
        (await handleNegotiumMcpRequest(req)) ?? new Response("not found", { status: 404 }),
    });
    const token = issueRuntimeMcpToken(ctx);
    const client = new Client({ name: "peer-bridge-test", version: "1.0.0" });

    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
          ),
        ),
      );
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("spawn_subagent");
      expect(names).not.toContain("spawn_topic");
      expect(names).not.toContain("fork_topic");

      const result = await client.callTool({
        name: "spawn_subagent",
        arguments: { task: "remote task", name: "remote-child" },
      });
      expect(result.isError).toBeFalsy();
      expect(resultText(result)).toBe("spawned by canonical hub");
      expect(calls).toEqual([
        {
          bridge: ctx.peerBridge!,
          userId: "peer-user",
          agent: "claude",
          model: "sonnet",
          input: { task: "remote task", name: "remote-child" },
        },
      ]);
    } finally {
      await client.close();
      server.stop(true);
      unregister();
    }
  });

  test("the hub execution spec can deny spawn_subagent on a shared top-level topic", async () => {
    const topic = registerTopic({
      title: `peer-shared-${crypto.randomUUID()}`,
      userId: "peer-user-denied",
      agent: "claude",
    });
    const ctx: RuntimeMcpContext = {
      userId: "peer-user-denied",
      topicId: topic.id,
      topicTitle: topic.title,
      cwd: mkdtempSync(join(tmpdir(), "negotium-peer-mcp-denied-")),
      agent: "claude",
      model: "sonnet",
      peerBridge: {
        hubCellId: "hub-cell",
        hostTopicId: "host-topic",
        hostQueryId: "host-query",
        canSpawnSubagents: false,
      },
    };
    const server = Bun.serve({
      port: 0,
      fetch: async (req) =>
        (await handleNegotiumMcpRequest(req)) ?? new Response("not found", { status: 404 }),
    });
    const client = new Client({ name: "peer-bridge-denied-test", version: "1.0.0" });

    try {
      const token = issueRuntimeMcpToken(ctx);
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(
            `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
          ),
        ),
      );
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain("spawn_subagent");
    } finally {
      await client.close();
      server.stop(true);
    }
  });
});
