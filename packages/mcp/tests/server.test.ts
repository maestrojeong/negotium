import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  issueRuntimeMcpToken,
  type RuntimeMcpContext,
  registerTopic,
  sessionInboxPath,
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
      "send_message",
      "abort_topic",
      "delete_topic",
      "ask_user_question",
      "spawn_subagent",
      "send_file",
      "send_files",
      "show_html",
      "set_model",
      "schedule_self",
    ]) {
      expect(names).toContain(expected);
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

  test("send_message queues a durable tell entry in the target inbox", async () => {
    const result = await client.callTool({
      name: "send_message",
      arguments: { topic: "worker-room", message: "scan the ports" },
    });
    expect(result.isError).toBeFalsy();
    expect(resultText(result)).toContain("no reply will be returned");

    const listed = resultText(await client.callTool({ name: "list_topics", arguments: {} }));
    const workerId = /"worker-room" \(id: ([0-9a-f-]{36})/.exec(listed)?.[1];
    expect(workerId).toBeTruthy();

    const inboxFile = sessionInboxPath(USER_ID, workerId!);
    expect(existsSync(inboxFile)).toBe(true);
    const entries = readFileSync(inboxFile, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: "tell",
      from: "main-room",
      fromTopicId: mainTopic.id,
      message: "scan the ports",
      depth: 0,
    });
    expect(entries[0].requestId).toBeTruthy();
    expect(entries[0].timestamp).toBeTruthy();
  });

  test("send_message refuses topics the user cannot see", async () => {
    const result = await client.callTool({
      name: "send_message",
      arguments: { topic: "other-user-room", message: "hi" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("not found");
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
});
