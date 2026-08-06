#!/usr/bin/env bun
/**
 * Long-lived JSONL adapter around this repository's real wiki MCP server.
 *
 * The adapter owns scenario state, because in the write-time architecture what a
 * query can find depends on whether the derived cache was built:
 *
 *   --scenario=indexed  run wiki_reindex once, then answer queries
 *   --scenario=fresh    delete the derived cache and never reindex
 *
 * Each request is answered from a server whose state matches its scenario, so a
 * single evaluation covers both without the fixtures being rebuilt.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")];
  }),
);
const repo = resolve(args.repo || new URL("../..", import.meta.url).pathname);
const corpus = resolve(args.corpus || new URL("dataset/corpus", import.meta.url).pathname);
const scenario = args.scenario === "fresh" ? "fresh" : "indexed";
const cachePath = resolve(corpus, ".wiki-search-index.sqlite");

const wiki = await import(
  pathToFileURL(resolve(repo, "packages/core/src/mcp/wiki-server.ts")).href
);
const clientSdk = await import(
  pathToFileURL(resolve(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js"))
    .href
);
const transports = await import(
  pathToFileURL(resolve(repo, "node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js")).href
);

const access = JSON.parse(readFileSync(resolve(corpus, "access.json"), "utf8"));
const allowed = new Set<string>(access.allowed_topics);
const adopted: string[] = [];

// Both scenarios start from no cache so a previous run cannot leak into this one.
for (const suffix of ["", "-journal", "-wal", "-shm"]) {
  if (existsSync(cachePath + suffix)) rmSync(cachePath + suffix);
}

const server = wiki.createWikiMcpServer(
  {
    userId: access.user,
    currentTopicId: "evaluation-room",
    topicId: "evaluation-room",
    surface: "wiki",
  },
  {
    wikiRoot: corpus,
    canReadTopicMemory: (selection: string, userId: string) =>
      userId === access.user && allowed.has(selection.replace(/\.md$/i, "")),
    adoptTopicMemory: (_topicId: string, _userId: string, memoryKey: string) => {
      adopted.push(memoryKey);
      return true;
    },
  },
);
const client = new clientSdk.Client({ name: "search-eval-v3", version: "3.0.0" });
const [clientTransport, serverTransport] = transports.InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const tools = new Set((await client.listTools()).tools.map((tool: { name: string }) => tool.name));

let reindexReport = "";
if (scenario === "indexed") {
  if (!tools.has("wiki_reindex"))
    throw new Error("wiki_reindex is required for the indexed scenario");
  const result = await client.callTool({ name: "wiki_reindex", arguments: {} });
  reindexReport = (result.content as Array<{ text?: string }>).map((e) => e.text || "").join("\n");
} else {
  // A query recreates the cache file, so ensure it starts absent and stays unfilled.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    if (existsSync(cachePath + suffix)) rmSync(cachePath + suffix);
  }
}

type Candidate = { id: string; score?: number };
function parse(text: string): Candidate[] {
  const found: Candidate[] = [];
  const block = /- kind: (topic|article|summary)\n\s+key: ([^\n]+)\n\s+score: ([0-9.]+)/g;
  for (const match of text.matchAll(block)) {
    found.push({ id: `${match[1]}:${match[2].trim()}`, score: Number(match[3]) });
  }
  const paths = /^\s*Path: (articles|topic|summaries)\/(.+?)\.md$/gm;
  for (const match of text.matchAll(paths)) {
    const kind =
      match[1] === "articles" ? "article" : match[1] === "summaries" ? "summary" : "topic";
    found.push({ id: `${kind}:${match[2]}` });
  }
  return [...new Map(found.map((candidate) => [candidate.id, candidate])).values()];
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const started = Bun.nanoseconds();
  const adoptedBefore = adopted.length;
  try {
    const result = await client.callTool({
      name: "wiki_query",
      arguments: { question: request.query, kind: request.track, limit: 5 },
    });
    const responseText = (result.content as Array<{ text?: string }>)
      .map((entry) => entry.text || "")
      .join("\n");
    const candidates = parse(responseText);
    let outcome = "results";
    let canonical: string | undefined;
    if (candidates.length === 0) outcome = "no_match";
    else if (request.track === "topic") {
      if (/ambiguous/i.test(responseText)) outcome = "ambiguous";
      else {
        outcome = "selected";
        canonical = candidates[0].id.replace(/^topic:/, "");
        if (request.adopt) {
          await client.callTool({
            name: "wiki_read",
            arguments: { kind: "topic", key: canonical, adopt: true },
          });
        }
      }
    }
    process.stdout.write(
      JSON.stringify({
        id: request.id,
        outcome,
        canonical,
        results: candidates.map((candidate) => candidate.id),
        scores: candidates.map((candidate) => candidate.score ?? null),
        adopted: adopted.slice(adoptedBefore),
        latency_ms: Number((Bun.nanoseconds() - started) / 1e6),
      }) + "\n",
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ id: request.id, outcome: "error", results: [], error: String(error) }) +
        "\n",
    );
  }
}
if (reindexReport) process.stderr.write(`${reindexReport}\n`);
await client.close();
