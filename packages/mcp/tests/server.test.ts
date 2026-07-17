import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  getTopic,
  getTopicByNameForUser,
  getTopicSessionId,
  issueRuntimeMcpToken,
  type RuntimeMcpContext,
  registerPeerRuntimeBridge,
  registerTopic,
  sessionInboxPath,
  setTopicSessionId,
  upsertTopic,
} from "@negotium/core";
import { handleNegotiumMcpRequest } from "../src/index";

const USER_ID = "test-user";

let server: ReturnType<typeof Bun.serve>;
let client: Client;
let ctx: RuntimeMcpContext;
let mainTopic: ReturnType<typeof registerTopic>;

function resultText(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{
    type: string;
    text?: string;
  }>;
  return content.map((c) => c.text ?? "").join("\n");
}

beforeAll(async () => {
  mainTopic = registerTopic({ title: "main-room", userId: USER_ID, agent: "claude" });
  ctx = {
    userId: USER_ID,
    topicId: mainTopic.id,
    topicTitle: mainTopic.title,
    cwd: mkdtempSync(join(tmpdir(), "negotium-mcp-cwd-")),
    agent: "claude",
  };

  server = Bun.serve({
    port: 0,
    fetch: async (req) =>
      (await handleNegotiumMcpRequest(req)) ?? new Response("host route", { status: 404 }),
  });

  const token = issueRuntimeMcpToken(ctx);
  const url = new URL(
    `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
  );
  client = new Client({ name: "negotium-mcp-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
});

afterAll(async () => {
  await client?.close();
  server?.stop(true);
});

describe("negotium MCP endpoint", () => {
  test("ignores non-MCP paths so the host can fall through", async () => {
    const res = await handleNegotiumMcpRequest(new Request("http://127.0.0.1/api/topics"));
    expect(res).toBeNull();
  });

  test("rejects unsigned tokens", async () => {
    const res = await handleNegotiumMcpRequest(
      new Request("http://127.0.0.1/mcp/runtime/mcp?token=forged", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {} }),
      }),
    );
    expect(res?.status).toBe(401);
  });

  test("exposes node tools and shared runtime tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of [
      "register_topic",
      "list_topics",
      "abort_topic",
      "restart_topic",
      "delete_topic",
      "ask_user_question",
      "spawn_subagent",
      "list_subagents",
      "delete_subagent",
      "send_file",
      "send_files",
      "set_model",
      "set_agent",
      "schedule_self",
      "get_self_schedule",
      "update_self_schedule",
      "cancel_self_schedule",
    ]) {
      expect(names).toContain(expected);
    }
    for (const visual of ["show_html", "show_mermaid", "show_image", "show_video"]) {
      expect(names).not.toContain(visual);
    }
    expect(names).not.toContain("send_message");
  });

  test("exposes visual tools only when the adapter grants the capability", async () => {
    const visualClient = new Client({ name: "negotium-visual-mcp-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken({ ...ctx, visualTools: true });
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await visualClient.connect(new StreamableHTTPClientTransport(url));
      const names = (await visualClient.listTools()).tools.map((tool) => tool.name);
      for (const visual of ["show_html", "show_mermaid", "show_image", "show_video"]) {
        expect(names).toContain(visual);
      }
    } finally {
      await visualClient.close();
    }
  });

  test("send_file uses the canonical hub bridge during a peer turn", async () => {
    const filePath = join(ctx.cwd, "peer-output.txt");
    writeFileSync(filePath, "peer output");
    const calls: Array<{ path: string; source: string }> = [];
    const unregister = registerPeerRuntimeBridge({
      async spawnSubagent() {
        return { content: [{ type: "text", text: "unused" }] };
      },
      async sendFile(request) {
        calls.push({ path: request.path, source: request.source });
        return { ok: true };
      },
      async showVisual() {
        return { ok: false, error: "hub unavailable" };
      },
    });
    const peerCtx: RuntimeMcpContext = {
      ...ctx,
      visualTools: true,
      peerBridge: {
        hubCellId: "hub-cell",
        hostTopicId: "host-topic",
        hostQueryId: "host-query",
        canSpawnSubagents: true,
      },
    };
    const peerClient = new Client({ name: "negotium-peer-mcp-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken(peerCtx);
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await peerClient.connect(new StreamableHTTPClientTransport(url));
      const result = await peerClient.callTool({
        name: "send_file",
        arguments: { file_path: filePath },
      });
      expect(result.isError).toBeFalsy();
      expect(calls).toEqual([{ path: filePath, source: "runtime.send_file" }]);
      const visualResult = await peerClient.callTool({
        name: "show_html",
        arguments: { html: "<p>not delivered</p>" },
      });
      expect(visualResult.isError).toBeFalsy();
      expect(resultText(visualResult)).toContain("queued for ordered display");
      const scheduleResult = await peerClient.callTool({
        name: "schedule_self",
        arguments: { delay_seconds: 60, message: "This must run on the hub." },
      });
      expect(scheduleResult.isError).toBe(true);
      expect(resultText(scheduleResult)).toContain("peer self-config bridge");
    } finally {
      await peerClient.close();
      unregister();
    }
  });

  test("register_topic creates a topic owned by the token's user", async () => {
    const result = await client.callTool({
      name: "register_topic",
      arguments: { title: "worker-room", agent: "codex", description: "port scanner" },
    });
    const text = resultText(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("title: worker-room");
    expect(text).toContain("agent: codex");
    expect(text).toMatch(/id: [0-9a-f-]{36}/);
    expect(text).toMatch(/model: \S+/);
  });

  test("register_topic surfaces validation errors", async () => {
    const result = await client.callTool({
      name: "register_topic",
      arguments: { title: "worker-room" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("already exists");
  });

  test("list_topics lists only the calling user's topics", async () => {
    registerTopic({ title: "other-user-room", userId: "someone-else", agent: "claude" });
    const result = await client.callTool({ name: "list_topics", arguments: {} });
    const text = resultText(result);
    expect(text).toContain('"main-room"');
    expect(text).toContain('"worker-room"');
    expect(text).toContain("idle");
    expect(text).not.toContain("other-user-room");
  });

  test("abort_topic reports idle targets and queues the abort signal", async () => {
    const result = await client.callTool({
      name: "abort_topic",
      arguments: { topic: "worker-room" },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("No active turn");

    const listed = resultText(await client.callTool({ name: "list_topics", arguments: {} }));
    const workerId = /"worker-room" \(id: ([0-9a-f-]{36})/.exec(listed)?.[1];
    const entries = readFileSync(sessionInboxPath(USER_ID, workerId!), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries.at(-1)).toMatchObject({ type: "abort" });
  });

  test("abort_topic refuses the current topic", async () => {
    const result = await client.callTool({
      name: "abort_topic",
      arguments: { topic: mainTopic.id },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("current topic");
  });

  test("delete_topic rejects a shared topic member without cascading into owner subagents", async () => {
    const suffix = randomUUID();
    const ownerId = `delete-owner-${suffix}`;
    const memberId = `delete-member-${suffix}`;
    const parent = registerTopic({
      title: `shared-delete-parent-${suffix}`,
      userId: ownerId,
      agent: "codex",
      accessMode: "shared",
    });
    parent.participants.push({ userId: memberId, role: "member" });
    upsertTopic(parent);

    const child = registerTopic({
      title: `shared-delete-child-${suffix}`,
      userId: ownerId,
      agent: "codex",
    });
    child.parentTopicId = parent.id;
    child.isSubagent = true;
    upsertTopic(child);

    const caller = registerTopic({
      title: `shared-delete-caller-${suffix}`,
      userId: memberId,
      agent: "codex",
    });
    const memberCtx: RuntimeMcpContext = {
      ...ctx,
      userId: memberId,
      topicId: caller.id,
      topicTitle: caller.title,
    };
    const memberClient = new Client({ name: "negotium-member-delete-test", version: "1.0.0" });
    const token = issueRuntimeMcpToken(memberCtx);
    const url = new URL(
      `http://127.0.0.1:${server.port}/mcp/runtime/mcp?token=${encodeURIComponent(token)}`,
    );

    try {
      await memberClient.connect(new StreamableHTTPClientTransport(url));
      const result = await memberClient.callTool({
        name: "delete_topic",
        arguments: { topic: parent.id, force: true },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("only the topic owner");
      expect(getTopic(parent.id)).toBeDefined();
      expect(getTopic(child.id)).toBeDefined();
    } finally {
      await memberClient.close();
    }
  });

  test("restart_topic clears AI context but preserves the topic", async () => {
    const worker = getTopicByNameForUser("worker-room", USER_ID)!;
    setTopicSessionId(worker.id, "01940000-0000-7000-8000-000000000000", {
      reason: "test",
      agent: "codex",
    });

    const result = await client.callTool({
      name: "restart_topic",
      arguments: { topic: worker.id },
    });

    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain('Session reset for "worker-room"');
    expect(getTopicSessionId(worker.id)).toBeNull();
    expect(getTopicByNameForUser("worker-room", USER_ID)?.id).toBe(worker.id);
  });

  test("restart_topic refuses the current topic", async () => {
    const result = await client.callTool({
      name: "restart_topic",
      arguments: { topic: mainTopic.id },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("current topic");
  });
});
