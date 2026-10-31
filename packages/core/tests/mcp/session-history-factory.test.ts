import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSessionHistoryMcpServer } from "#mcp/factories/session-history";
import type { ConversationEntry } from "#storage/conversations";
import { getConversationPath } from "#storage/conversations";

async function connect(server: ReturnType<typeof createSessionHistoryMcpServer>): Promise<Client> {
  const client = new Client({ name: "session-history-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function payload(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function seedRawManifest(userId: string, topic: string, entries: ConversationEntry[]): void {
  const path = getConversationPath(userId, topic);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

describe("createSessionHistoryMcpServer", () => {
  test("exposes exactly the three session-history tools", async () => {
    const client = await connect(
      createSessionHistoryMcpServer({ userId: "u1", topic: "list-tools-topic" }),
    );
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "list_session_boundaries",
      "read_session_history",
      "search_session_history",
    ]);
  });

  test("list_session_boundaries classifies compaction vs agent switch from raw session events", async () => {
    const topic = "boundaries-topic";
    seedRawManifest("u1", topic, [
      { ts: "t0", agent: "claude", event: { type: "session", sessionId: "s1" } },
      { ts: "t1", agent: "claude", event: { type: "user_message", content: "hello" } },
      // same agent, new sessionId -> compacted
      { ts: "t2", agent: "claude", event: { type: "session", sessionId: "s2" } },
      { ts: "t3", agent: "claude", event: { type: "user_message", content: "world" } },
      // different agent -> agent-switch
      { ts: "t4", agent: "codex", event: { type: "session", sessionId: "s3" } },
    ]);
    const client = await connect(createSessionHistoryMcpServer({ userId: "u1", topic }));

    const result = payload(
      await client.callTool({ name: "list_session_boundaries", arguments: {} }),
    );
    expect(result.total_entries).toBe(5);
    expect(result.sessions).toMatchObject([
      { sessionId: "s1", agent: "claude", endedBy: "compacted" },
      { sessionId: "s2", agent: "claude", endedBy: "agent-switch" },
      { sessionId: "s3", agent: "codex", endedBy: "active" },
    ]);
  });

  test("list_session_boundaries does not treat a per-turn re-announcement of the same sessionId as a new boundary", async () => {
    // Providers re-emit a `session` event with the SAME sessionId at the
    // start of every turn of a resumed session (Claude's system init,
    // Codex's thread.started), and every streamed event gets recorded into
    // the raw manifest. A long-lived two-turn session must still collapse
    // to one boundary, not mint a spurious "compacted" boundary per turn.
    const topic = "reannounce-topic";
    seedRawManifest("u1", topic, [
      { ts: "t0", agent: "claude", event: { type: "session", sessionId: "s1" } },
      { ts: "t1", agent: "claude", event: { type: "user_message", content: "turn one" } },
      // Same session resumed for a second turn: the provider re-announces s1.
      { ts: "t2", agent: "claude", event: { type: "session", sessionId: "s1" } },
      { ts: "t3", agent: "claude", event: { type: "user_message", content: "turn two" } },
      // A real compaction: same agent, genuinely new sessionId.
      { ts: "t4", agent: "claude", event: { type: "session", sessionId: "s2" } },
      { ts: "t5", agent: "claude", event: { type: "user_message", content: "turn three" } },
    ]);
    const client = await connect(createSessionHistoryMcpServer({ userId: "u1", topic }));

    const result = payload(
      await client.callTool({ name: "list_session_boundaries", arguments: {} }),
    );
    expect(result.sessions).toMatchObject([
      { sessionId: "s1", agent: "claude", endedBy: "compacted" },
      { sessionId: "s2", agent: "claude", endedBy: "active" },
    ]);

    // Scoping read_session_history to s1 must cover BOTH turns (entries 1-4),
    // not stop at the re-announcement (the bug returned only entries 1-2).
    const scoped = payload(
      await client.callTool({
        name: "read_session_history",
        arguments: { sessionId: "s1" },
      }),
    );
    expect(scoped.returned_entries).toBe(4);
    expect(scoped.content).toContain("turn one");
    expect(scoped.content).toContain("turn two");
    expect(scoped.content).not.toContain("turn three");
  });

  test("read_session_history paginates and can scope to one sessionId", async () => {
    const topic = "read-topic";
    seedRawManifest("u1", topic, [
      { ts: "t0", agent: "claude", event: { type: "session", sessionId: "s1" } },
      { ts: "t1", agent: "claude", event: { type: "user_message", content: "first" } },
      { ts: "t2", agent: "claude", event: { type: "session", sessionId: "s2" } },
      { ts: "t3", agent: "claude", event: { type: "user_message", content: "second" } },
    ]);
    const client = await connect(createSessionHistoryMcpServer({ userId: "u1", topic }));

    const scoped = payload(
      await client.callTool({
        name: "read_session_history",
        arguments: { sessionId: "s1" },
      }),
    );
    expect(scoped.returned_entries).toBe(2);
    expect(scoped.content).toContain("first");
    expect(scoped.content).not.toContain("second");

    const paged = payload(
      await client.callTool({
        name: "read_session_history",
        arguments: { offset: 3, limit: 10 },
      }),
    );
    expect(paged.returned_entries).toBe(2);
    expect(paged.content).toContain("second");
  });

  test("search_session_history finds a match surviving a compaction boundary", async () => {
    const topic = "search-topic";
    seedRawManifest("u1", topic, [
      { ts: "t0", agent: "claude", event: { type: "session", sessionId: "s1" } },
      {
        ts: "t1",
        agent: "claude",
        event: { type: "user_message", content: "deploy rollback was due to cache invalidation" },
      },
      { ts: "t2", agent: "claude", event: { type: "session", sessionId: "s2" } },
      {
        ts: "t3",
        agent: "claude",
        event: { type: "user_message", content: "unrelated follow-up" },
      },
    ]);
    const client = await connect(createSessionHistoryMcpServer({ userId: "u1", topic }));

    const result = payload(
      await client.callTool({
        name: "search_session_history",
        arguments: { query: "rollback" },
      }),
    );
    expect(result.match_count).toBe(1);
    const matches = result.matches as Array<{ entry: number; sessionId?: string; snippet: string }>;
    expect(matches[0]?.entry).toBe(2);
    expect(matches[0]?.sessionId).toBe("s1");
    expect(matches[0]?.snippet).toContain("rollback");
  });

  test("search_session_history matches are not desynced by a case fold that changes string length", async () => {
    // "İ" (U+0130) lowercases to two code units ("i̇"); a naive
    // `text.toLowerCase().indexOf(needle)` desyncs the match offset from the
    // original string once ~160 such characters precede the match, drifting
    // the snippet away from the actual hit. A regex matched directly against
    // the original text does not have this problem, even with just one.
    const topic = "unicode-search-topic";
    seedRawManifest("u1", topic, [
      { ts: "t0", agent: "claude", event: { type: "session", sessionId: "s1" } },
      {
        ts: "t1",
        agent: "claude",
        event: { type: "user_message", content: "İstanbul rollback notes" },
      },
    ]);
    const client = await connect(createSessionHistoryMcpServer({ userId: "u1", topic }));

    const result = payload(
      await client.callTool({
        name: "search_session_history",
        arguments: { query: "rollback" },
      }),
    );
    expect(result.match_count).toBe(1);
    const matches = result.matches as Array<{ snippet: string }>;
    expect(matches[0]?.snippet).toContain("rollback");
  });

  test("search_session_history reports a budget-exhausted note instead of a silent zero", async () => {
    const topic = "search-budget-topic";
    seedRawManifest("u1", topic, [
      { ts: "t0", agent: "claude", event: { type: "session", sessionId: "s1" } },
      {
        ts: "t1",
        agent: "claude",
        event: { type: "user_message", content: "needle in a haystack" },
      },
    ]);
    // A budget too small to fit even one match object forces the scan to
    // stop before finding anything, which must be distinguishable from a
    // genuine "no matches" result.
    const client = await connect(
      createSessionHistoryMcpServer({ userId: "u1", topic, maxTotalBytes: 10, maxChunkBytes: 10 }),
    );

    const result = payload(
      await client.callTool({
        name: "search_session_history",
        arguments: { query: "needle" },
      }),
    );
    expect(result.match_count).toBe(0);
    expect(result.note).toContain("budget ran out");
  });

  test("enforces the per-process call budget across all three tools", async () => {
    const topic = "budget-topic";
    seedRawManifest("u1", topic, [
      { ts: "t0", agent: "claude", event: { type: "session", sessionId: "s1" } },
      { ts: "t1", agent: "claude", event: { type: "user_message", content: "hi" } },
    ]);
    const client = await connect(
      createSessionHistoryMcpServer({ userId: "u1", topic, maxCalls: 1 }),
    );

    const first = await client.callTool({ name: "list_session_boundaries", arguments: {} });
    expect(first.isError).toBeFalsy();

    const second = await client.callTool({ name: "list_session_boundaries", arguments: {} });
    expect(second.isError).toBe(true);
    const text = (second.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).toContain("budget exhausted");
  });

  test("missing userId/topic context is rejected without touching storage", async () => {
    const client = await connect(createSessionHistoryMcpServer({ userId: "", topic: "" }));
    const result = await client.callTool({ name: "list_session_boundaries", arguments: {} });
    expect(result.isError).toBe(true);
  });
});
