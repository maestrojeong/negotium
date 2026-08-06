import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

  test("does not fall back to a shared topic file after authorization rejects a brief", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-private-brief-"));
    roots.push(root);
    mkdirSync(join(root, "topic"), { recursive: true });
    writeFileSync(join(root, "topic", "private.md"), "PRIVATE TOPIC MEMORY");
    const client = await connect(
      createWikiMcpServer(
        { userId: "member", topicId: "caller-topic", surface: "wiki" },
        {
          wikiRoot: root,
          resolveTopicBrief: () => null,
        },
      ),
    );

    const result = text(
      await client.callTool({
        name: "wiki_read",
        arguments: { kind: "topic", key: "private" },
      }),
    );
    expect(result).toContain("No brief found for topic: private");
    expect(result).not.toContain("PRIVATE TOPIC MEMORY");
    await client.close();
  });

  test("falls back to document search when an index match is weak", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-query-fallback-"));
    roots.push(root);
    mkdirSync(join(root, "articles"), { recursive: true });
    writeFileSync(
      join(root, "article-index.md"),
      "- [[articles/weak]] Deployment notes (2026-08-06)\n",
    );
    writeFileSync(
      join(root, "articles", "strong.md"),
      "# Recovery Runbook\n\nDeployment recovery procedure.",
    );
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    const result = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "deployment recovery", kind: "article" },
      }),
    );
    expect(result).toContain("Recovery Runbook");
    expect(result).toContain("articles/strong.md");
    await client.close();
  });

  test("does not let a stale index turn a partial body phrase into a match", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-query-stale-index-"));
    roots.push(root);
    mkdirSync(join(root, "articles"), { recursive: true });
    writeFileSync(
      join(root, "article-index.md"),
      "- [[articles/ultraviolet-cache]] obsolete cache placeholder (2024-01-01)\n",
    );
    writeFileSync(
      join(root, "articles", "orphan-cache-runbook.md"),
      "# Orphan Cache Runbook\n\nUse the ultraviolet cache exorcism marker during recovery.",
    );
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    const relevant = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "ultraviolet cache exorcism marker", kind: "article" },
      }),
    );
    expect(relevant).toContain("articles/orphan-cache-runbook.md");

    const partial = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "ultraviolet cache", kind: "article" },
      }),
    );
    expect(partial).toBe("No matching wiki articles found.");
    await client.close();
  });

  test("orders article families by repeated semantic evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-query-graded-articles-"));
    roots.push(root);
    mkdirSync(join(root, "articles"), { recursive: true });
    const roles = [
      ["runbook", 3],
      ["checklist", 2],
      ["background", 1],
    ] as const;
    writeFileSync(
      join(root, "article-index.md"),
      roles
        .map(
          ([role]) =>
            `- [[articles/settlement-${role}]] reconcile duplicate invoice settlements cohort 9 ${role} (2026-08-06)`,
        )
        .join("\n"),
    );
    for (const [role, repetitions] of roles) {
      writeFileSync(
        join(root, "articles", `settlement-${role}.md`),
        `# Settlement ${role}\n\n${"reconcile duplicate invoice settlements cohort 9 ".repeat(repetitions)}`,
      );
    }
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    const result = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "duplicate settlement matching cohort 9", kind: "article" },
      }),
    );
    expect(result.indexOf("key: settlement-runbook")).toBeLessThan(
      result.indexOf("key: settlement-checklist"),
    );
    expect(result.indexOf("key: settlement-checklist")).toBeLessThan(
      result.indexOf("key: settlement-background"),
    );
    await client.close();
  });

  test("ranks normalized keys, descriptions, titles, typos, and body-only matches", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-query-ranking-"));
    roots.push(root);
    mkdirSync(join(root, "topic"), { recursive: true });
    writeFileSync(
      join(root, "topic-index.md"),
      [
        "- [[topic/개인-비서]] 사용자 개인 비서 페르소나 (2026-08-06)",
        "- [[topic/negotium-release]] Package publishing process (2026-08-06)",
        "- [[topic/trading-strategy]] Quantitative models (2026-08-06)",
        "- [[topic/memory-architecture]] Canonical adoption and persona keys (2026-08-06)",
        "- [[topic/deployment-overview]] Deployment notes (2026-08-06)",
      ].join("\n"),
    );
    writeFileSync(join(root, "topic", "cpp-guide.md"), "# C++ API Guide\n\nNative bindings.");
    writeFileSync(
      join(root, "topic", "incident-recovery.md"),
      "# Incident Recovery\n\nDatabase recovery procedure and restore validation.",
    );
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    for (const [query, expected] of [
      ["개인비서", "key: 개인-비서"],
      ["negotum release", "key: negotium-release"],
      ["trading strat", "key: trading-strategy"],
      ["canonical adoption", "key: memory-architecture"],
      ["C++ API", "Path: topic/cpp-guide.md"],
      ["database recovery", "Path: topic/incident-recovery.md"],
    ]) {
      const result = text(
        await client.callTool({
          name: "wiki_query",
          arguments: { question: query, kind: "topic" },
        }),
      );
      expect(result).toContain(expected);
    }
    await client.close();
  });

  test("filters unauthorized kinds and rejects matches without enough evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-query-filtering-"));
    roots.push(root);
    mkdirSync(join(root, "topic"), { recursive: true });
    mkdirSync(join(root, "articles"), { recursive: true });
    writeFileSync(
      join(root, "topic-index.md"),
      "- [[topic/private-roadmap]] Secret project roadmap (2026-08-06)\n",
    );
    writeFileSync(
      join(root, "article-index.md"),
      "- [[articles/project-roadmap]] Public project roadmap (2026-08-06)\n",
    );
    writeFileSync(join(root, "topic", "private-roadmap.md"), "# Private Roadmap\n\nSecret plan.");
    writeFileSync(
      join(root, "articles", "project-roadmap.md"),
      "# Project Roadmap\n\nPublic milestones.",
    );
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", surface: "wiki" },
        { wikiRoot: root, canReadTopicMemory: () => false },
      ),
    );

    const articles = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "project roadmap", kind: "article" },
      }),
    );
    expect(articles).toContain("key: project-roadmap");
    expect(articles).not.toContain("private-roadmap");

    for (const query of ["quantum bananas", "the", "!!!"]) {
      const noMatch = text(
        await client.callTool({
          name: "wiki_query",
          arguments: { question: query, kind: "topic" },
        }),
      );
      expect(noMatch).toBe("No matching wiki articles found.");
      expect(noMatch).not.toContain("Secret plan");
    }
    await client.close();
  });

  test("uses kind-specific topic, article, and summary result policies", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-query-policies-"));
    roots.push(root);
    mkdirSync(join(root, "topic"), { recursive: true });
    mkdirSync(join(root, "articles"), { recursive: true });
    mkdirSync(join(root, "summaries"), { recursive: true });
    writeFileSync(
      join(root, "topic-index.md"),
      [
        "- [[topic/persona-a]] Shared persona alias (2026-08-06)",
        "- [[topic/persona-b]] Shared persona alias (2026-08-06)",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "article-index.md"),
      [
        "- [[articles/indexed-guide]] credential rollover (2026-08-06)",
        "- [[articles/stale-guide]] obsolete placeholder (2024-01-01)",
      ].join("\n"),
    );
    writeFileSync(join(root, "topic", "persona-a.md"), "# Persona A\n\nCanonical A.");
    writeFileSync(join(root, "topic", "persona-b.md"), "# Persona B\n\nCanonical B.");
    writeFileSync(join(root, "articles", "indexed-guide.md"), "# Indexed Guide\n\nPrimary.");
    writeFileSync(
      join(root, "articles", "body-guide.md"),
      "# Body Guide\n\nCredential rollover evidence and validation.",
    );
    writeFileSync(
      join(root, "summaries", "2026-07-01-review.md"),
      "# Search Review\n\nRetrieval decisions.",
    );
    writeFileSync(
      join(root, "summaries", "2026-08-01-review.md"),
      "# Search Review\n\nRetrieval decisions.",
    );
    for (const [date, session] of [
      ["2026-05-04", "1"],
      ["2026-06-11", "2"],
      ["2026-07-19", "3"],
    ]) {
      writeFileSync(
        join(root, "summaries", `${date}-ledger-review.md`),
        `# Ledger Review ${date}\n\nledger-review session ${session}. Settlement controls.`,
      );
      writeFileSync(
        join(root, "summaries", `${date}-ledger-review-neighbor.md`),
        `# Ledger Review Neighbor ${date}\n\nNeighbor session ${session}. Settlement controls.`,
      );
    }
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    const ambiguousTopic = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "shared persona alias", kind: "topic", limit: 5 },
      }),
    );
    expect(ambiguousTopic).toContain("Found 2 ambiguous wiki candidates:");
    expect(ambiguousTopic).toContain("key: persona-a");
    expect(ambiguousTopic).toContain("key: persona-b");
    const exactTopic = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "persona-a", kind: "topic", limit: 5 },
      }),
    );
    expect(exactTopic).toContain("key: persona-a");
    expect(exactTopic).not.toContain("key: persona-b");

    const articles = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "credential rollover", kind: "article", limit: 5 },
      }),
    );
    expect(articles).toContain("key: indexed-guide");
    expect(articles).toContain("key: body-guide");
    expect(articles).not.toContain("stale-guide");

    const summaries = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "Search Review", kind: "summary", limit: 5 },
      }),
    );
    expect(summaries.indexOf("key: 2026-08-01-review")).toBeLessThan(
      summaries.indexOf("key: 2026-07-01-review"),
    );
    const julySummaries = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "July 2026 summaries", kind: "summary", limit: 5 },
      }),
    );
    expect(julySummaries).toContain("key: 2026-07-01-review");
    expect(julySummaries).not.toContain("key: 2026-08-01-review");

    const latestSummary = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "latest summary", kind: "summary", limit: 1 },
      }),
    );
    expect(latestSummary).toContain("key: 2026-08-01-review");

    const boundedSummaries = text(
      await client.callTool({
        name: "wiki_query",
        arguments: {
          question: "ledger-review before 2026-07-01",
          kind: "summary",
          limit: 5,
        },
      }),
    );
    expect(boundedSummaries).toContain("key: 2026-06-11-ledger-review");
    expect(boundedSummaries).toContain("key: 2026-05-04-ledger-review");
    expect(boundedSummaries).not.toContain("2026-07-19-ledger-review");
    expect(boundedSummaries).not.toContain("ledger-review-neighbor");
    await client.close();
  });

  test("searches the requested wiki index kind and adopts a selected topic memory", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-index-query-"));
    roots.push(root);
    writeFileSync(
      join(root, "topic-index.md"),
      "- [[topic/persona]] Otium persona and topic memory design (2026-08-06)\n",
    );
    writeFileSync(
      join(root, "article-index.md"),
      "- [[articles/persona-prompts]] Prompt design notes (2026-08-06)\n",
    );
    const adopted: Array<{ topicId: string; userId: string; memoryKey: string }> = [];
    const client = await connect(
      createWikiMcpServer(
        {
          userId: "user",
          currentTopicId: "current-room",
          topicId: "current-room",
          surface: "wiki",
        },
        {
          wikiRoot: root,
          resolveTopicBrief: (selection) =>
            selection === "persona"
              ? { briefMd: "Canonical persona brief", updatedAt: "2026-08-06T00:00:00Z" }
              : null,
          adoptTopicMemory: (topicId, userId, memoryKey) => {
            adopted.push({ topicId, userId, memoryKey });
            return true;
          },
        },
      ),
    );

    const search = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "persona", kind: "topic", limit: 5 },
      }),
    );
    expect(search).toContain("key: persona");
    expect(search).not.toContain("persona-prompts");

    const read = text(
      await client.callTool({
        name: "wiki_read",
        arguments: { kind: "topic", key: "persona", adopt: true },
      }),
    );
    expect(read).toContain("Canonical persona brief");
    expect(read).toContain("Adopted topic memory: persona");
    expect(adopted).toEqual([{ topicId: "current-room", userId: "user", memoryKey: "persona" }]);
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
    // save_wiki_entry records the latest summary and defensively backfills the
    // EXISTING brief file into brief_md (never emptying it). The authoritative
    // fresh brief is written later by save_topic_brief (archive → summary → brief).
    expect(response).toContain("SQLite latest-summary also updated.");
    expect(readdirSync(join(root, "summaries")).sort()).toEqual([
      `${date}-Roadmap-Notes.md`,
      `${date}-Roadmap-Notes~2.md`,
    ]);
    // The accumulated brief file itself is left untouched by save_wiki_entry.
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

  test("save_topic_brief writes the brief file and mirrors only brief_md", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-save-brief-"));
    roots.push(root);
    const writes: Array<{
      key: string;
      fields: { briefMd?: string; latestSummaryMd?: string; summaryDate?: string };
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

    const brief =
      "---\ntopic: Roadmap Notes\ntype: topic-brief\n---\n# Roadmap Notes 토픽 브리프\n\n## 페르소나\n- 사용자: BlueHole 엔지니어";
    const response = text(
      await client.callTool({
        name: "save_topic_brief",
        arguments: { topic: "Roadmap Notes", content: brief },
      }),
    );

    expect(response).toContain("Saved brief: topic/Roadmap-Notes.md");
    expect(response).toContain("SQLite brief also updated.");
    expect(readFileSync(join(root, "topic", "Roadmap-Notes.md"), "utf-8")).toBe(brief);
    // Partial upsert: only brief_md is touched (latest_summary_md/summary_date untouched).
    expect(writes.at(-1)).toEqual({ key: "Roadmap-Notes", fields: { briefMd: brief } });
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
    expect(response).not.toContain("SQLite latest-summary also updated.");
    await client.close();
  });

  test("save_wiki_entry carries a legacy id-keyed brief into a new title row", async () => {
    // Regression: with no brief file and no title row yet, a summary-only write
    // must migrate the legacy id-keyed brief forward instead of inserting an
    // empty title row that shadows it (resolveTopicBrief prefers the title key).
    const root = mkdtempSync(join(tmpdir(), "wiki-legacy-brief-"));
    roots.push(root);
    const writes: Array<{
      key: string;
      fields: { briefMd?: string; latestSummaryMd?: string; summaryDate?: string };
    }> = [];
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "room-id", surface: "wiki" },
        {
          wikiRoot: root,
          setTopicBrief: (key, fields) => writes.push({ key, fields }),
          getTopicBrief: (key: string) =>
            key === "room-id"
              ? { briefMd: "# legacy brief", updatedAt: "2026-01-01T00:00:00.000Z" }
              : null,
        },
      ),
    );

    await client.callTool({
      name: "save_wiki_entry",
      arguments: { topic: "Roadmap Notes", content: "Fresh summary." },
    });

    const date = new Date().toISOString().slice(0, 10);
    expect(writes.at(-1)).toEqual({
      key: "Roadmap-Notes",
      fields: { briefMd: "# legacy brief", latestSummaryMd: "Fresh summary.", summaryDate: date },
    });
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

  test("synchronizes article catalog additions and refreshes generated metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-article-index-sync-"));
    roots.push(root);
    mkdirSync(join(root, "articles", "guides"), { recursive: true });
    mkdirSync(join(root, "summaries"), { recursive: true });
    writeFileSync(
      join(root, "article-index.md"),
      [
        "# Article Index",
        "",
        "## Curated",
        "",
        "- [[articles/manual]] Human-maintained description (2026-08-01)",
        "- [[articles/manual]] Duplicate generated description <!-- negotium:auto-index mtime=1 size=1 --> (2026-08-01)",
        "- [[articles/deleted]] Deliberate stale tombstone (2026-07-01)",
      ].join("\n"),
    );
    writeFileSync(join(root, "articles", "manual.md"), "# Manual\n\nChanged body.");
    const generatedPath = join(root, "articles", "guides", "recovery.md");
    writeFileSync(generatedPath, "# Recovery Guide\n\nRestore the primary database safely.");
    writeFileSync(
      join(root, "summaries", "2026-08-06-recovery.md"),
      "# Recovery Session\n\nValidated restore procedures.",
    );
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    await client.callTool({
      name: "wiki_query",
      arguments: { question: "primary database restore", kind: "article" },
    });

    let index = readFileSync(join(root, "article-index.md"), "utf-8");
    expect(index.match(/\[\[articles\/manual\]\]/g)).toHaveLength(1);
    expect(index).toContain("[[articles/manual]] Human-maintained description");
    expect(index).toContain("[[articles/guides/recovery]] Recovery Guide: Restore the primary");
    expect(index).toContain("[[summaries/2026-08-06-recovery]] Recovery Session");
    expect(index).toContain("[[articles/deleted]] Deliberate stale tombstone");
    expect(index.match(/## Auto-synchronized Articles/g)).toHaveLength(1);

    writeFileSync(generatedPath, "# Recovery Guide\n\nRotate the recovery credentials safely.");
    const changedTime = new Date(Date.now() + 5_000);
    utimesSync(generatedPath, changedTime, changedTime);
    writeFileSync(
      join(root, "articles", "guides", "rollback.md"),
      "# Rollback Guide\n\nReverse a failed deployment.",
    );
    await client.callTool({
      name: "wiki_query",
      arguments: { question: "recovery credentials", kind: "article" },
    });

    index = readFileSync(join(root, "article-index.md"), "utf-8");
    expect(index).toContain("[[articles/guides/recovery]] Recovery Guide: Rotate the recovery");
    expect(index).toContain("[[articles/guides/rollback]] Rollback Guide");
    expect(index.match(/## Auto-synchronized Articles/g)).toHaveLength(1);

    await client.callTool({
      name: "index_upsert",
      arguments: {
        slug: "guides/recovery",
        description: "Curated recovery procedures",
        kind: "article",
        section: "Curated",
        date: "2026-08-06",
      },
    });
    await client.callTool({
      name: "wiki_query",
      arguments: { question: "curated recovery", kind: "article" },
    });
    index = readFileSync(join(root, "article-index.md"), "utf-8");
    expect(index).toContain("[[articles/guides/recovery]] Curated recovery procedures");
    expect(index.indexOf("[[articles/guides/recovery]]")).toBeLessThan(
      index.indexOf("## Auto-synchronized Articles"),
    );
    expect(
      index.split("\n").find((line) => line.includes("[[articles/guides/recovery]]")),
    ).not.toContain("negotium:auto-index");
    await client.close();
  });

  test("searches indexed articles and summaries without reopening source documents", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-derived-search-index-"));
    roots.push(root);
    mkdirSync(join(root, "articles"), { recursive: true });
    mkdirSync(join(root, "summaries"), { recursive: true });
    const articlePath = join(root, "articles", "database-recovery.md");
    const summaryPath = join(root, "summaries", "2026-08-06-database-recovery.md");
    writeFileSync(
      articlePath,
      "# Database Recovery\n\nRestore the primary ledger from immutable checkpoints.",
    );
    writeFileSync(
      summaryPath,
      "# Database Recovery Session\n\nValidated immutable checkpoint restoration.",
    );
    const client = await connect(
      createWikiMcpServer({ userId: "user", surface: "wiki" }, { wikiRoot: root }),
    );

    expect(
      text(
        await client.callTool({
          name: "wiki_query",
          arguments: { question: "immutable checkpoint restoration", kind: "summary" },
        }),
      ),
    ).toContain("key: 2026-08-06-database-recovery");
    const searchIndexPath = join(root, ".wiki-search-index.sqlite");
    expect(statSync(searchIndexPath).mode & 0o777).toBe(0o600);

    chmodSync(articlePath, 0o000);
    chmodSync(summaryPath, 0o000);
    expect(
      text(
        await client.callTool({
          name: "wiki_query",
          arguments: { question: "primary ledger immutable checkpoints", kind: "article" },
        }),
      ),
    ).toContain("key: database-recovery");
    expect(
      text(
        await client.callTool({
          name: "wiki_query",
          arguments: { question: "immutable checkpoint restoration", kind: "summary" },
        }),
      ),
    ).toContain("key: 2026-08-06-database-recovery");
    chmodSync(articlePath, 0o600);
    chmodSync(summaryPath, 0o600);

    rmSync(articlePath);
    expect(
      text(
        await client.callTool({
          name: "wiki_query",
          arguments: { question: "database-recovery", kind: "article" },
        }),
      ),
    ).toBe("No matching wiki articles found.");

    writeFileSync(searchIndexPath, "not a sqlite database");
    expect(
      text(
        await client.callTool({
          name: "wiki_query",
          arguments: { question: "immutable checkpoint restoration", kind: "summary" },
        }),
      ),
    ).toContain("key: 2026-08-06-database-recovery");
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
