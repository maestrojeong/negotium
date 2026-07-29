import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiMessageRow } from "#storage/api-messages";
import { appendApiMessage } from "#storage/api-messages";
import { upsertTopic } from "#storage/api-topics";
import {
  migrateLegacyCompactedConversations,
  restoreVisibleConversationEntries,
} from "#storage/conversation-migration";
import {
  getActiveConversationPath,
  getConversationPath,
  readConversation,
  readRawConversation,
  replaceRawConversationStrict,
} from "#storage/conversations";
import {
  closeStorageDatabase,
  configureStorageHost,
  resetStorageHost,
} from "#storage/storage-host";

const TOPIC_ID = "migration-topic";
const TOPIC_TITLE = "Legacy compacted topic";
const USER_ID = "migration-owner";
let root = "";
let database: Database;
let disposeStorage: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "negotium-conversation-migration-"));
  database = new Database(":memory:");
  disposeStorage = configureStorageHost({ database, dataDir: join(root, "data") });
  const now = "2026-01-01T00:00:00.000Z";
  upsertTopic({
    id: TOPIC_ID,
    title: TOPIC_TITLE,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-test",
    defaultEffort: "medium",
    aiMode: "always",
    participants: [{ userId: USER_ID, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
});

afterEach(() => {
  disposeStorage();
  resetStorageHost();
  closeStorageDatabase();
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("legacy compacted conversation migration", () => {
  test("collapses incremental assistant UI rows to the final result", () => {
    const rows = [
      {
        rowid: 1,
        author_id: "migration-owner",
        text: "question",
        created_at: "2026-01-01T00:00:01.000Z",
      },
      {
        rowid: 2,
        author_id: "ai",
        agent_type: "claude",
        query_id: "query-1",
        text: "partial",
        created_at: "2026-01-01T00:00:02.000Z",
      },
      {
        rowid: 3,
        author_id: "ai",
        agent_type: "claude",
        query_id: "query-1",
        text: "final",
        created_at: "2026-01-01T00:00:03.000Z",
      },
    ].map(
      (row) =>
        ({
          id: `message-${row.rowid}`,
          topic_id: TOPIC_ID,
          parent_id: null,
          source_adapter: null,
          source_node: null,
          source_message_id: null,
          query_id: null,
          agent_type: null,
          model: null,
          attachments: null,
          usage: null,
          deleted: 0,
          edited_at: null,
          reactions: null,
          kind: null,
          ask_user_question: null,
          subagent_card: null,
          mentions: null,
          thread_root_id: null,
          ...row,
        }) satisfies ApiMessageRow,
    );

    const restored = restoreVisibleConversationEntries(rows, "2026-01-02T00:00:00.000Z", "codex");
    expect(restored).toHaveLength(2);
    expect(restored[0]?.event).toEqual({ type: "user_message", content: "question" });
    expect(restored[1]).toMatchObject({
      agent: "claude",
      event: { type: "result", content: "final" },
    });
  });

  test("backs up the legacy stream and creates independent raw and active files", () => {
    appendApiMessage({
      id: "user-before",
      topicId: TOPIC_ID,
      authorId: USER_ID,
      text: "original user message",
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    appendApiMessage({
      id: "assistant-partial",
      topicId: TOPIC_ID,
      authorId: "ai",
      text: "partial",
      queryId: "query-1",
      agentType: "codex",
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    appendApiMessage({
      id: "assistant-final",
      topicId: TOPIC_ID,
      authorId: "ai",
      text: "original assistant answer",
      queryId: "query-1",
      agentType: "codex",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    appendApiMessage({
      id: "user-after",
      topicId: TOPIC_ID,
      authorId: USER_ID,
      text: "post-compact UI row",
      createdAt: "2026-01-03T00:00:00.000Z",
    });

    const legacy = [
      {
        ts: "2026-01-02T00:00:00.000Z",
        agent: "codex" as const,
        event: {
          type: "user_message" as const,
          content:
            "[Negotium compacted context]\nThe assistant response is the authoritative summary of all earlier context.",
        },
      },
      {
        ts: "2026-01-02T00:00:01.000Z",
        agent: "codex" as const,
        event: {
          type: "result" as const,
          content: "compacted summary",
          stopReason: "end_turn",
        },
      },
      {
        ts: "2026-01-03T00:00:01.000Z",
        agent: "codex" as const,
        event: { type: "session" as const, sessionId: "post-compact-session" },
      },
    ];
    const rawPath = getConversationPath(USER_ID, TOPIC_TITLE);
    replaceRawConversationStrict(USER_ID, TOPIC_TITLE, legacy);
    writeFileSync(
      rawPath,
      `{malformed legacy line\n${legacy.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    expect(migrateLegacyCompactedConversations()).toEqual({
      migrated: 1,
      skipped: 0,
      restoredEntries: 2,
    });
    expect(readConversation(USER_ID, TOPIC_TITLE)).toEqual(legacy);
    expect(readRawConversation(USER_ID, TOPIC_TITLE)).toHaveLength(5);
    expect(readRawConversation(USER_ID, TOPIC_TITLE).slice(0, 2)).toMatchObject([
      { event: { type: "user_message", content: "original user message" } },
      { event: { type: "result", content: "original assistant answer" } },
    ]);
    expect(existsSync(getActiveConversationPath(USER_ID, TOPIC_TITLE))).toBe(true);
    expect(
      existsSync(
        join(
          root,
          "data",
          "conversation-migration-backups",
          "raw-active-v1",
          USER_ID,
          "legacy_compacted_topic.jsonl",
        ),
      ),
    ).toBe(true);

    expect(migrateLegacyCompactedConversations()).toEqual({
      migrated: 0,
      skipped: 1,
      restoredEntries: 0,
    });
  });
});
