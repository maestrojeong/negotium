import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWikiMcpServer } from "#mcp/wiki-server";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connect(server: ReturnType<typeof createWikiMcpServer>): Promise<Client> {
  const client = new Client({ name: "wiki-factory-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text?: string }>).map((entry) => entry.text ?? "").join("\n");
}

describe("createWikiMcpServer", () => {
  test("isolates roots and surface tool sets between hosts", async () => {
    const rootA = mkdtempSync(join(tmpdir(), "wiki-a-"));
    const rootB = mkdtempSync(join(tmpdir(), "wiki-b-"));
    roots.push(rootA, rootB);
    const wiki = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: rootA }),
    );
    const skills = await connect(
      createWikiMcpServer({ userId: "user", surface: "skills" }, { wikiRoot: rootB }),
    );

    expect((await wiki.listTools()).tools.map((tool) => tool.name)).not.toContain("skill_save");
    expect((await skills.listTools()).tools.map((tool) => tool.name)).toEqual([
      "skill_query",
      "skill_save",
    ]);
    await skills.callTool({
      name: "skill_save",
      arguments: { name: "isolated", content: "---\nname: isolated\n---\nsecret-b" },
    });
    expect(
      text(await skills.callTool({ name: "skill_query", arguments: { question: "secret-b" } })),
    ).toContain("isolated");
    expect(
      text(await wiki.callTool({ name: "wiki_query", arguments: { question: "secret-b" } })),
    ).not.toContain("isolated");

    await Promise.all([wiki.close(), skills.close()]);
  });

  test("uses the caller-owned topic brief bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-brief-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "topic-id", surface: "wiki" },
        {
          wikiRoot: root,
          getTopicBrief: (id) => ({
            briefMd: `brief:${id}`,
            updatedAt: "2026-07-18T00:00:00Z",
          }),
        },
      ),
    );
    expect(
      text(await client.callTool({ name: "wiki_topic_brief", arguments: { topic: "topic-id" } })),
    ).toContain("brief:topic-id");
    await client.close();
  });
});
