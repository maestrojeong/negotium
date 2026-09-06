import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWikiMcpServer, type WikiMcpHost } from "#mcp/wiki-server";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function wikiRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wiki-assign-"));
  roots.push(root);
  return root;
}

async function connect(server: ReturnType<typeof createWikiMcpServer>): Promise<Client> {
  const client = new Client({ name: "wiki-assign-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text?: string }>).map((entry) => entry.text ?? "").join("\n");
}

function recordingSink() {
  const calls: Array<{ memoryKey: string; model: string; effort?: string; reason?: string }> = [];
  const sink: NonNullable<WikiMcpHost["assignTopicDefaults"]> = (input) => {
    calls.push(input);
    if (input.model === "rejected") return null;
    return {
      agent: "claude",
      model: input.model,
      effort: input.effort ?? "medium",
      assignCount: calls.length,
    };
  };
  return { calls, sink };
}

describe("assign_topic_defaults", () => {
  test("stays unregistered for turns that name no memory persona", async () => {
    const { sink } = recordingSink();
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", surface: "wiki" },
        { wikiRoot: wikiRoot(), assignTopicDefaults: sink },
      ),
    );

    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "assign_topic_defaults",
    );
    await client.close();
  });

  test("stays unregistered when the host wired no assignment sink", async () => {
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", surface: "wiki", memoryKey: "persona" },
        { wikiRoot: wikiRoot() },
      ),
    );

    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain(
      "assign_topic_defaults",
    );
    await client.close();
  });

  test("falls back to the turn's own persona before any brief is written", async () => {
    const { calls, sink } = recordingSink();
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", surface: "wiki", memoryKey: "room-persona" },
        { wikiRoot: wikiRoot(), assignTopicDefaults: sink },
      ),
    );

    const result = await client.callTool({
      name: "assign_topic_defaults",
      arguments: { model: "opus", effort: "high", reason: "needs deep reasoning" },
    });

    expect(text(result)).toContain("room-persona");
    expect(calls[0]).toEqual({
      memoryKey: "room-persona",
      model: "opus",
      effort: "high",
      reason: "needs deep reasoning",
    });
    await client.close();
  });

  test("follows the persona the archiver actually routed to", async () => {
    const { calls, sink } = recordingSink();
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", surface: "wiki", memoryKey: "room-persona" },
        { wikiRoot: wikiRoot(), assignTopicDefaults: sink },
      ),
    );

    await client.callTool({
      name: "wiki_write",
      arguments: {
        kind: "topic",
        topic: "Reused Persona",
        content: "# Reused Persona\n\nbrief body",
        description: "brief for the reused persona",
      },
    });
    await client.callTool({ name: "assign_topic_defaults", arguments: { model: "opus" } });

    expect(calls[0]?.memoryKey).toBe("Reused-Persona");
    await client.close();
  });

  test("a reused server does not carry one run's persona into the next run", async () => {
    const { calls, sink } = recordingSink();
    // One server, two logical archive runs — what Maestro's process-lifetime
    // MCP cache actually does to the archiver.
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", surface: "wiki", memoryKey: "room-persona" },
        { wikiRoot: wikiRoot(), assignTopicDefaults: sink },
      ),
    );

    await client.callTool({
      name: "wiki_write",
      arguments: {
        kind: "topic",
        topic: "Other Persona",
        content: "# Other Persona\n\nbrief body",
        description: "brief for the other persona",
      },
    });
    // Run 2 starts: its summary write is the run boundary, and it assigns
    // before writing any brief of its own.
    await client.callTool({
      name: "wiki_write",
      arguments: {
        kind: "summary",
        topic: "room-persona",
        content: "# room-persona\n\nsecond run",
        description: "second run summary",
      },
    });
    await client.callTool({ name: "assign_topic_defaults", arguments: { model: "opus" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.memoryKey).toBe("room-persona");
    await client.close();
  });

  test("a successful assignment is consumed, not left in scope", async () => {
    const { calls, sink } = recordingSink();
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", surface: "wiki", memoryKey: "room-persona" },
        { wikiRoot: wikiRoot(), assignTopicDefaults: sink },
      ),
    );

    await client.callTool({
      name: "wiki_write",
      arguments: {
        kind: "topic",
        topic: "Routed Persona",
        content: "# Routed Persona\n\nbrief body",
        description: "brief for the routed persona",
      },
    });
    await client.callTool({ name: "assign_topic_defaults", arguments: { model: "opus" } });
    await client.callTool({ name: "assign_topic_defaults", arguments: { model: "sonnet" } });

    expect(calls.map((call) => call.memoryKey)).toEqual(["Routed-Persona", "room-persona"]);
    await client.close();
  });

  test("reports a rejected model as an error instead of pretending it stuck", async () => {
    const { sink } = recordingSink();
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", surface: "wiki", memoryKey: "room-persona" },
        { wikiRoot: wikiRoot(), assignTopicDefaults: sink },
      ),
    );

    const result = await client.callTool({
      name: "assign_topic_defaults",
      arguments: { model: "rejected" },
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not a model this node can run");
    await client.close();
  });
});
