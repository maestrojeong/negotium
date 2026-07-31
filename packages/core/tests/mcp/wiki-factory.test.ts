import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createWikiMcpServer, resolveAccessibleWikiTopicBrief } from "#mcp/wiki-server";

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
      arguments: {
        name: "isolated",
        content: "---\nname: isolated\n---\nsecret-b",
      },
    });
    expect(
      text(
        await skills.callTool({
          name: "skill_query",
          arguments: { question: "secret-b" },
        }),
      ),
    ).toContain("isolated");
    expect(
      text(
        await wiki.callTool({
          name: "wiki_query",
          arguments: { question: "secret-b" },
        }),
      ),
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
      text(
        await client.callTool({
          name: "wiki_topic_brief",
          arguments: { topic: "topic-id" },
        }),
      ),
    ).toContain("brief:topic-id");
    await client.close();
  });

  test("resolves a topic title before reading its canonical brief", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-title-brief-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "caller-topic", surface: "wiki" },
        {
          wikiRoot: root,
          getTopicBrief: (id) => ({
            briefMd: `legacy:${id}`,
            updatedAt: "2026-07-18T00:00:00Z",
          }),
          resolveTopicBrief: (selection, userId) =>
            selection === "negotium" && userId === "user"
              ? {
                  briefMd: "canonical:topic-id",
                  updatedAt: "2026-07-30T00:00:00Z",
                }
              : null,
        },
      ),
    );

    expect(
      text(
        await client.callTool({
          name: "wiki_topic_brief",
          arguments: { topic: "negotium" },
        }),
      ),
    ).toContain("canonical:topic-id");
    expect(
      text(
        await client.callTool({
          name: "wiki_topic_brief",
          arguments: { topic: "private" },
        }),
      ),
    ).toContain("No brief found for topic: private");
    await client.close();
  });

  test("supports a resolver-only topic brief host", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-resolver-only-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "caller-topic", surface: "wiki" },
        {
          wikiRoot: root,
          resolveTopicBrief: () => ({
            briefMd: "resolver-only",
            updatedAt: "2026-07-30T00:00:00Z",
          }),
        },
      ),
    );
    expect(
      text(
        await client.callTool({
          name: "wiki_topic_brief",
          arguments: { topic: "negotium" },
        }),
      ),
    ).toContain("resolver-only");
    await client.close();
  });

  test("stores immutable summaries without replacing the accumulated title brief", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-title-memory-"));
    roots.push(root);
    const topicDir = join(root, "topic");
    mkdirSync(topicDir, { recursive: true });
    const brief =
      "---\ntopic: Roadmap Notes\ntype: topic-brief\n---\n# Roadmap Notes\n\nAccumulated.";
    writeFileSync(join(topicDir, "Roadmap-Notes.md"), brief);
    const writes: Array<{
      key: string;
      fields: {
        briefMd?: string;
        latestSummaryMd?: string;
        summaryDate?: string;
      };
    }> = [];
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "room-id", surface: "wiki" },
        {
          wikiRoot: root,
          setTopicBrief: (key, fields) => writes.push({ key, fields }),
        },
      ),
    );

    let response = "";
    for (const content of ["First session.", "Second session."]) {
      response = text(
        await client.callTool({
          name: "save_wiki_entry",
          arguments: { topic: "Roadmap Notes", content },
        }),
      );
    }

    const date = new Date().toISOString().slice(0, 10);
    expect(response).toContain("SQLite brief also updated.");
    expect(readdirSync(join(root, "summaries")).sort()).toEqual([
      `${date}-Roadmap-Notes.md`,
      `${date}-Roadmap-Notes~2.md`,
    ]);
    expect(readFileSync(join(topicDir, "Roadmap-Notes.md"), "utf-8")).toBe(brief);
    expect(writes.at(-1)).toEqual({
      key: "Roadmap-Notes",
      fields: {
        briefMd: brief,
        latestSummaryMd: "Second session.",
        summaryDate: date,
      },
    });
    await client.close();
  });

  test("does not claim a failed SQLite mirror update succeeded", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-failed-mirror-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "room-id", surface: "wiki" },
        {
          wikiRoot: root,
          setTopicBrief: () => {
            throw new Error("database unavailable");
          },
        },
      ),
    );

    const response = text(
      await client.callTool({
        name: "save_wiki_entry",
        arguments: { topic: "Roadmap Notes", content: "Durable summary." },
      }),
    );

    expect(response).toContain("Saved summary:");
    expect(response).not.toContain("SQLite brief also updated.");
    await client.close();
  });

  test("deduplicates canonical topic index entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-index-"));
    roots.push(root);
    writeFileSync(
      join(root, "topic-index.md"),
      "- [[topic/negotium]] old (2026-07-01)\n- [[topic/negotium]] newer (2026-07-02)\n",
    );
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    await client.callTool({
      name: "index_upsert",
      arguments: {
        slug: "negotium",
        description: "latest",
        kind: "topic",
        date: "2026-07-30",
      },
    });

    const index = readFileSync(join(root, "topic-index.md"), "utf-8");
    expect(index.match(/\[\[topic\/negotium\]\]/g)).toHaveLength(1);
    expect(index).toContain("- [[topic/negotium]] latest (2026-07-30)");
    await client.close();
  });

  test("recovers a stale topic index lock without leaving it behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-stale-index-lock-"));
    roots.push(root);
    const indexPath = join(root, "topic-index.md");
    const lockPath = `${indexPath}.lock`;
    writeFileSync(lockPath, "abandoned-owner");
    const staleTime = new Date(Date.now() - 31_000);
    utimesSync(lockPath, staleTime, staleTime);
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    await client.callTool({
      name: "index_upsert",
      arguments: {
        slug: "negotium",
        description: "recovered",
        kind: "topic",
        date: "2026-07-30",
      },
    });

    expect(readFileSync(indexPath, "utf-8")).toContain("[[topic/negotium]] recovered");
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
    await client.close();
  });

  test("resolves visible participant topics through their shared title namespace", () => {
    const topics = [
      {
        id: "topic-id",
        title: "Negotium",
        visibility: "private",
        participants: [{ userId: "user" }],
      },
      {
        id: "hidden-id",
        title: "Hidden",
        visibility: "hidden",
        participants: [{ userId: "user" }],
      },
      {
        id: "private-id",
        title: "Private",
        visibility: "private",
        participants: [{ userId: "other" }],
      },
    ];
    const resolveBrief = (topicId: string, legacyTitle: string) => ({
      brief: {
        briefMd: `canonical:${topicId}:${legacyTitle}`,
        updatedAt: "2026-07-30T00:00:00Z",
      },
    });

    expect(resolveAccessibleWikiTopicBrief("negotium", "user", topics, resolveBrief)?.briefMd).toBe(
      "canonical:topic-id:Negotium",
    );
    expect(resolveAccessibleWikiTopicBrief("topic-id", "user", topics, resolveBrief)?.briefMd).toBe(
      "canonical:topic-id:Negotium",
    );
    expect(
      resolveAccessibleWikiTopicBrief(
        "topic-id",
        "user",
        [
          ...topics,
          {
            id: "title-collision",
            title: "topic-id",
            visibility: "private",
            participants: [{ userId: "user" }],
          },
        ],
        resolveBrief,
      )?.briefMd,
    ).toBe("canonical:topic-id:Negotium");
    expect(resolveAccessibleWikiTopicBrief("Hidden", "user", topics, resolveBrief)).toBeNull();
    expect(resolveAccessibleWikiTopicBrief("Private", "user", topics, resolveBrief)).toBeNull();
    expect(
      resolveAccessibleWikiTopicBrief(
        "Negotium",
        "user",
        [
          ...topics,
          {
            id: "duplicate-id",
            title: "negotium",
            visibility: "private",
            participants: [{ userId: "user" }],
          },
        ],
        resolveBrief,
      )?.briefMd,
    ).toBe("canonical:topic-id:Negotium");
  });
});
