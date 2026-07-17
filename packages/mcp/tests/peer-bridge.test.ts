import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  issueRuntimeMcpToken,
  type PeerRuntimeAskUserRequest,
  type PeerRuntimeSelfConfigRequest,
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
      expect(names).toContain("spawn_topic");
      expect(names).toContain("fork_topic");

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

  test("ask-user and self-config tools execute on the canonical hub", async () => {
    const topic = registerTopic({
      title: `peer-runtime-${crypto.randomUUID()}`,
      userId: "peer-runtime-user",
      agent: "claude",
    });
    const askCalls: PeerRuntimeAskUserRequest[] = [];
    const configCalls: PeerRuntimeSelfConfigRequest[] = [];
    const unregister = registerPeerRuntimeBridge({
      async spawnSubagent() {
        return textResult("unused");
      },
      async askUser(request) {
        askCalls.push(request);
        return textResult("Hub choice");
      },
      async selfConfig(request) {
        configCalls.push(request);
        return textResult("Hub model: sonnet");
      },
    });
    const ctx: RuntimeMcpContext = {
      userId: "peer-runtime-user",
      topicId: topic.id,
      topicTitle: topic.title,
      cwd: mkdtempSync(join(tmpdir(), "negotium-peer-runtime-")),
      agent: "claude",
      model: "sonnet",
      currentUserPrompt: "inspect the hub",
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
    const client = new Client({ name: "peer-runtime-test", version: "1.0.0" });

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
      expect(names).toContain("ask_user_question");
      expect(names).toContain("get_model");
      expect(names).toContain("spawn_topic");
      expect(names).toContain("fork_topic");

      const askResult = await client.callTool({
        name: "ask_user_question",
        arguments: {
          question: "Continue?",
          choices: [{ label: "Hub choice" }],
        },
      });
      expect(resultText(askResult)).toBe("Hub choice");

      const configResult = await client.callTool({ name: "get_model", arguments: {} });
      expect(resultText(configResult)).toBe("Hub model: sonnet");
      expect(askCalls).toEqual([
        {
          bridge: ctx.peerBridge!,
          userId: ctx.userId,
          agent: ctx.agent,
          model: ctx.model,
          input: { question: "Continue?", choices: [{ label: "Hub choice" }] },
        },
      ]);
      expect(configCalls).toEqual([
        {
          bridge: ctx.peerBridge!,
          userId: ctx.userId,
          tool: "get_model",
          input: {},
          currentUserPrompt: "inspect the hub",
        },
      ]);
    } finally {
      await client.close();
      server.stop(true);
      unregister();
    }
  });
});
