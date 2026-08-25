import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionCommMcpServer, type SessionCommMcpHost } from "#mcp/factories/session-comm";
import { mcpOk } from "#mcp/mcp-helpers";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { deleteTopic, upsertTopic } from "#storage/api-topics";

const topicIds: string[] = [];

function storedSubagentContext(): SessionCommContext {
  const parentId = `factory-parent-${randomUUID()}`;
  const childId = `factory-child-${randomUUID()}`;
  topicIds.push(childId, parentId);
  const now = new Date().toISOString();
  const common = {
    kind: "agent" as const,
    agent: "codex" as const,
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium" as const,
    aiMode: "always" as const,
    participants: [{ userId: "factory-test", role: "owner" as const }],
    createdAt: now,
    lastMessageAt: now,
  };
  upsertTopic({ ...common, id: parentId, title: parentId });
  upsertTopic({
    ...common,
    id: childId,
    title: childId,
    isSubagent: true,
    parentTopicId: parentId,
  });
  return {
    ...context,
    currentTopic: childId,
    currentTopicId: childId,
  };
}

afterEach(() => {
  for (const id of topicIds.splice(0)) deleteTopic(id);
});

const context: SessionCommContext = {
  userId: "user",
  currentTopic: "Source",
  currentTopicId: "source-id",
  depth: 1,
  replyOnly: false,
  agent: "codex",
};

function host(overrides: Partial<SessionCommMcpHost> = {}): SessionCommMcpHost {
  const ok = () => mcpOk("ok");
  return {
    listSessions: ok,
    configureMcp: ok,
    getMcpConfig: ok,
    peekSession: ok,
    setDescription: ok,
    askSession: ok,
    askCron: ok,
    abortSession: ok,
    tellSession: ok,
    ...overrides,
  };
}

async function connected(
  current: SessionCommContext,
  currentHost: SessionCommMcpHost,
): Promise<Client> {
  const server = createSessionCommMcpServer(current, currentHost);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "session-comm-factory-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("session-comm MCP factory", () => {
  test("keeps the canonical ask_session message argument", async () => {
    let seen: { to: string; message: string } | undefined;
    const client = await connected(
      context,
      host({
        askSession: (_context, input) => {
          seen = input;
          return mcpOk("asked");
        },
      }),
    );

    const tools = await client.listTools();
    const ask = tools.tools.find((tool) => tool.name === "ask_session");
    expect(ask?.inputSchema).toMatchObject({
      required: ["to", "message"],
      properties: { to: { type: "string" }, message: { type: "string" } },
    });
    await client.callTool({
      name: "ask_session",
      arguments: { to: "Target", message: "Question" },
    });
    expect(seen).toEqual({ to: "Target", message: "Question" });
    await client.close();
  });

  test("exposes ask_cron with a required message", async () => {
    let seen: string | undefined;
    const client = await connected(
      context,
      host({
        askCron: (_context, message) => {
          seen = message;
          return mcpOk("asked cron");
        },
      }),
    );
    const tool = (await client.listTools()).tools.find((entry) => entry.name === "ask_cron");
    expect(tool?.inputSchema).toMatchObject({
      required: ["message"],
      properties: { message: { type: "string" } },
    });
    await client.callTool({ name: "ask_cron", arguments: { message: "Cron question" } });
    expect(seen).toBe("Cron question");
    await client.close();
  });

  test("omits outbound tools in reply-only sessions", async () => {
    const client = await connected({ ...context, replyOnly: true }, host());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("list_sessions");
    expect(names).not.toContain("ask_session");
    expect(names).not.toContain("ask_cron");
    expect(names).not.toContain("tell_session");
    expect(names).not.toContain("abort_session");
    await client.close();
  });

  test("subagents expose tell_session but not ask_session", async () => {
    const client = await connected({ ...context, subagentParentTopicId: "parent-id" }, host());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("tell_session");
    expect(names).not.toContain("ask_session");
    expect(names).not.toContain("ask_cron");
    expect(names).not.toContain("abort_session");
    await client.close();
  });

  test("stored subagents stay restricted when the asserted parent context is missing", async () => {
    const client = await connected(storedSubagentContext(), host());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("tell_session");
    expect(names).not.toContain("ask_session");
    expect(names).not.toContain("abort_session");
    await client.close();
  });

  test("subagent tell_session fails closed instead of delegating to the host", async () => {
    // The context asserts a subagent identity that storage cannot confirm, so
    // the shared permission check must block the tell before it reaches the host.
    let delegated = false;
    const client = await connected(
      { ...context, subagentParentTopicId: "parent-id" },
      host({
        tellSession: () => {
          delegated = true;
          return mcpOk("told");
        },
      }),
    );
    const result = (await client.callTool({
      name: "tell_session",
      arguments: { to: "SomeOtherSession", message: "hi" },
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("subagents can tell_session only");
    expect(delegated).toBe(false);
    await client.close();
  });

  test("plain rooms delegate tell_session to the host untouched", async () => {
    let seen: { to: string; message: string } | undefined;
    const client = await connected(
      context,
      host({
        tellSession: (_context, input) => {
          seen = input;
          return mcpOk("told");
        },
      }),
    );
    await client.callTool({
      name: "tell_session",
      arguments: { to: "Target", message: "hello" },
    });
    expect(seen).toEqual({ to: "Target", message: "hello" });
    await client.close();
  });

  test("only exposes browser profile tools when the host implements them", async () => {
    const withoutProfiles = await connected(context, host());
    expect((await withoutProfiles.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "get_browser_profile",
    );
    await withoutProfiles.close();

    const withProfiles = await connected(
      context,
      host({
        getBrowserProfile: () => mcpOk("profile"),
        setBrowserProfile: () => mcpOk("set"),
        deleteBrowserProfile: () => mcpOk("deleted"),
      }),
    );
    const names = (await withProfiles.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("get_browser_profile");
    expect(names).toContain("set_browser_profile");
    expect(names).toContain("delete_browser_profile");
    await withProfiles.close();
  });
});
