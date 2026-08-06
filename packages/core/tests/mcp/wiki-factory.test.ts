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

    // Documents created directly on disk predate wiki_write, so the derived
    // body index is filled by an explicit reindex. Retrieval never scans.
    await client.callTool({ name: "wiki_reindex", arguments: {} });

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

    // Documents created directly on disk predate wiki_write, so the derived
    // body index is filled by an explicit reindex. Retrieval never scans.
    await client.callTool({ name: "wiki_reindex", arguments: {} });

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

    // Documents created directly on disk predate wiki_write, so the derived
    // body index is filled by an explicit reindex. Retrieval never scans.
    await client.callTool({ name: "wiki_reindex", arguments: {} });

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

    // Documents created directly on disk predate wiki_write, so the derived
    // body index is filled by an explicit reindex. Retrieval never scans.
    await client.callTool({ name: "wiki_reindex", arguments: {} });

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
          name: "wiki_write",
          arguments: {
            kind: "summary",
            topic: "Roadmap Notes",
            content,
            description: "Roadmap session notes",
          },
        }),
      );
    }

    const date = new Date().toISOString().slice(0, 10);
    // A summary write records the latest summary and defensively backfills the
    // EXISTING brief file into brief_md (never emptying it). The authoritative
    // fresh brief is written later by kind="topic" (archive → summary → brief).
    expect(response).toContain("SQLite latest-summary also updated.");
    expect(readdirSync(join(root, "summaries")).sort()).toEqual([
      `${date}-Roadmap-Notes.md`,
      `${date}-Roadmap-Notes~2.md`,
    ]);
    // The accumulated brief file itself is left untouched by a summary write.
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

  test("wiki_write kind=topic writes the brief file and mirrors only brief_md", async () => {
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
        name: "wiki_write",
        arguments: {
          kind: "topic",
          topic: "Roadmap Notes",
          content: brief,
          description: "Roadmap Notes persona brief",
        },
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
        name: "wiki_write",
        arguments: {
          kind: "summary",
          topic: "Roadmap Notes",
          content: "Durable summary.",
          description: "Durable summary of the roadmap session",
        },
      }),
    );

    expect(response).toContain("Saved summary:");
    expect(response).not.toContain("SQLite latest-summary also updated.");
    await client.close();
  });

  test("a summary write carries a legacy id-keyed brief into a new title row", async () => {
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
      name: "wiki_write",
      arguments: {
        kind: "summary",
        topic: "Roadmap Notes",
        content: "Fresh summary.",
        description: "Fresh roadmap summary",
      },
    });

    const date = new Date().toISOString().slice(0, 10);
    expect(writes.at(-1)).toEqual({
      key: "Roadmap-Notes",
      fields: { briefMd: "# legacy brief", latestSummaryMd: "Fresh summary.", summaryDate: date },
    });
    await client.close();
  });

  test("wiki_write indexes every document kind in its own catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-write-index-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "room-id", surface: "wiki" },
        { wikiRoot: root },
      ),
    );

    const summary = text(
      await client.callTool({
        name: "wiki_write",
        arguments: {
          kind: "summary",
          topic: "Roadmap Notes",
          content: "# Roadmap\n\nShipped the catalog split.",
          description: "Catalog split shipped",
          date: "2026-08-06",
        },
      }),
    );
    expect(summary).toContain("Saved summary: summaries/2026-08-06-Roadmap-Notes.md");
    expect(summary).toContain("Indexed: - [[summaries/2026-08-06-Roadmap-Notes]]");

    const article = text(
      await client.callTool({
        name: "wiki_write",
        arguments: {
          kind: "article",
          slug: "guides/catalog-split",
          section: "Wiki",
          content: "# Catalog Split\n\nOne call writes document and row.",
          description: "Why the document and its row are written together",
          date: "2026-08-06",
        },
      }),
    );
    expect(article).toContain("Saved article: articles/guides/catalog-split.md (created)");

    await client.callTool({
      name: "wiki_write",
      arguments: {
        kind: "topic",
        topic: "Roadmap Notes",
        content: "# Roadmap Notes\n\n## Persona\n- engineer",
        description: "Roadmap Notes persona brief",
        date: "2026-08-06",
      },
    });

    // Each kind lands in exactly one catalog, and no catalog holds another's rows.
    const summaryIndex = readFileSync(join(root, "summary-index.md"), "utf-8");
    const articleIndex = readFileSync(join(root, "article-index.md"), "utf-8");
    const topicIndex = readFileSync(join(root, "topic-index.md"), "utf-8");
    expect(summaryIndex).toContain("[[summaries/2026-08-06-Roadmap-Notes]] Catalog split shipped");
    expect(summaryIndex).not.toContain("[[articles/");
    expect(articleIndex).toContain("## Wiki");
    expect(articleIndex).toContain("[[articles/guides/catalog-split]] Why the document");
    expect(articleIndex).not.toContain("[[summaries/");
    expect(topicIndex).toContain("[[topic/Roadmap-Notes]] Roadmap Notes persona brief");

    // Every written document is immediately retrievable through the catalog.
    for (const [kind, question, key] of [
      ["summary", "catalog split shipped", "2026-08-06-Roadmap-Notes"],
      ["article", "document and its row", "guides/catalog-split"],
    ] as const) {
      const found = text(
        await client.callTool({ name: "wiki_query", arguments: { question, kind } }),
      );
      expect(found).toContain(`kind: ${kind}`);
      expect(found).toContain(`key: ${key}`);
    }
    await client.close();
  });

  test("wiki_write rejects inputs that would degrade the catalog", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-write-guard-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "room-id", surface: "wiki" },
        { wikiRoot: root },
      ),
    );

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ kind: "summary", topic: "T", content: "body" }, "description is required"],
      [
        { kind: "summary", topic: "T", content: "body", description: "   " },
        "description is required",
      ],
      [{ kind: "article", content: "body", description: "d", section: "S" }, "slug is required"],
      [
        { kind: "article", slug: "../escape", content: "body", description: "d", section: "S" },
        "relative path segments",
      ],
      [{ kind: "article", slug: "ok", content: "body", description: "d" }, "requires a section"],
      [{ kind: "summary", content: "body", description: "d" }, "Missing topic"],
      [{ kind: "skill", content: "body", description: "d" }, "kind must be one of"],
    ];
    for (const [args, expected] of cases) {
      const result = await client.callTool({ name: "wiki_write", arguments: args });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(expected);
    }
    // A rejected call must not leave a document or a catalog behind.
    expect(readdirSync(join(root, "summaries"))).toEqual([]);
    expect(readdirSync(join(root, "articles"))).toEqual([]);
    expect(existsSync(join(root, "summary-index.md"))).toBe(false);
    await client.close();
  });

  test("index_upsert curates existing entries but cannot invent one", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-index-upsert-guard-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "room-id", surface: "wiki" },
        { wikiRoot: root },
      ),
    );

    await client.callTool({
      name: "wiki_write",
      arguments: {
        kind: "article",
        slug: "catalog-authority",
        section: "Wiki",
        content: "# Catalog Authority\n\nDocument is truth.",
        description: "auto description",
        date: "2026-08-06",
      },
    });

    const curated = await client.callTool({
      name: "index_upsert",
      arguments: {
        kind: "article",
        slug: "catalog-authority",
        description: "Curated: the document is the only source of truth",
        section: "Wiki",
        date: "2026-08-06",
      },
    });
    expect(text(curated)).toContain("Curated: the document is the only source of truth");

    const invented = await client.callTool({
      name: "index_upsert",
      arguments: { kind: "article", slug: "never-written", description: "phantom row" },
    });
    expect(invented.isError).toBe(true);
    expect(text(invented)).toContain("Use wiki_write");

    const index = readFileSync(join(root, "article-index.md"), "utf-8");
    expect(index.match(/\[\[articles\/catalog-authority\]\]/g)).toHaveLength(1);
    expect(index).not.toContain("phantom row");
    await client.close();
  });

  test("wiki_write makes a body phrase searchable without scanning the wiki", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-incremental-search-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "room-id", surface: "wiki" },
        { wikiRoot: root },
      ),
    );

    await client.callTool({
      name: "wiki_write",
      arguments: {
        kind: "article",
        slug: "fence-cancellation",
        section: "Runtime",
        // The phrase lives only in the body, so a hit proves the derived index
        // was filled at write time rather than the catalog being matched.
        content: "# Fence Cancellation\n\nDrop the lease before awaiting the terminal channel.",
        description: "Lease and fence ordering",
        date: "2026-08-06",
      },
    });

    const found = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "awaiting the terminal channel", kind: "article" },
      }),
    );
    expect(found).toContain("key: fence-cancellation");

    // A document dropped in by hand is deliberately not discovered: retrieval
    // never walks the tree. An explicit reindex is what picks it up.
    writeFileSync(
      join(root, "articles", "hand-dropped.md"),
      "# Hand Dropped\n\nRotate the quarantined credential bundle.",
    );
    const missed = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "quarantined credential bundle", kind: "article" },
      }),
    );
    expect(missed).toBe("No matching wiki articles found.");

    const report = text(await client.callTool({ name: "wiki_reindex", arguments: {} }));
    expect(report).toContain("2 documents");
    expect(report).toContain("missing rows: hand-dropped");

    const recovered = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "quarantined credential bundle", kind: "article" },
      }),
    );
    expect(recovered).toContain("key: hand-dropped");
    await client.close();
  });

  test("catalog retrieval survives a deleted body cache", async () => {
    const root = mkdtempSync(join(tmpdir(), "wiki-cache-loss-"));
    roots.push(root);
    const client = await connect(
      createWikiMcpServer(
        { userId: "user", topicId: "room-id", surface: "wiki" },
        { wikiRoot: root },
      ),
    );

    await client.callTool({
      name: "wiki_write",
      arguments: {
        kind: "article",
        slug: "cache-authority",
        section: "Runtime",
        content: "# Cache Authority\n\nThe derived cache is never the source of truth.",
        description: "Why the derived cache is disposable",
        date: "2026-08-06",
      },
    });

    // The cache is a rebuildable artifact: deleting it must not lose an entry.
    rmSync(join(root, ".wiki-search-index.sqlite"), { force: true });
    const found = text(
      await client.callTool({
        name: "wiki_query",
        arguments: { question: "derived cache is disposable", kind: "article" },
      }),
    );
    expect(found).toContain("key: cache-authority");
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
