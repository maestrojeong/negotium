import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionCommMcpServer, type SessionCommMcpHost } from "#mcp/factories/session-comm";
import { mcpOk } from "#mcp/mcp-helpers";
import type { SessionCommContext } from "#mcp/session-comm/context";

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

  test("omits outbound tools in reply-only sessions", async () => {
    const client = await connected({ ...context, replyOnly: true }, host());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("list_sessions");
    expect(names).not.toContain("ask_session");
    expect(names).not.toContain("tell_session");
    expect(names).not.toContain("abort_session");
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
      host({ getBrowserProfile: () => mcpOk("profile"), setBrowserProfile: () => mcpOk("set") }),
    );
    const names = (await withProfiles.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("get_browser_profile");
    expect(names).toContain("set_browser_profile");
    await withProfiles.close();
  });
});
