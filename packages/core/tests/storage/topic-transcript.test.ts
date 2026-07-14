import { describe, expect, test } from "bun:test";
import { formatTopicArchiveTranscriptRecord } from "#storage/topic-transcript";

describe("topic archive transcript formatting", () => {
  test("formats user messages as readable transcript records while preserving raw row", () => {
    const row = {
      id: "m1",
      topic_id: "topic-1",
      parent_id: null,
      author_id: "user-1",
      text: "Hello\nworld",
      query_id: null,
      agent_type: null,
      model: null,
      attachments: JSON.stringify([{ id: "file-1", filename: "note.txt" }]),
      usage: null,
      deleted: 0,
      created_at: "2026-06-23T12:00:00.000Z",
      rowid: 42,
    };

    const record = formatTopicArchiveTranscriptRecord(row, "Archive Topic", 1);

    expect(record.role).toBe("user");
    expect(record.rowid).toBe(42);
    expect(record.speaker).toBe("user:user-1");
    expect(record.line).toBe("[2026-06-23T12:00:00.000Z] user:user-1: Hello world");
    expect(record.attachments).toEqual([{ id: "file-1", filename: "note.txt" }]);
    expect(record.message).toBe(row);
  });

  test("labels assistant and system messages explicitly", () => {
    const aiRecord = formatTopicArchiveTranscriptRecord(
      {
        id: "m2",
        topic_id: "topic-1",
        parent_id: null,
        author_id: "ai",
        text: "Done.",
        query_id: "q1",
        agent_type: "codex",
        model: "gpt-5.6-luna",
        attachments: null,
        usage: JSON.stringify({ input: 10, output: 4 }),
        deleted: 0,
        created_at: "2026-06-23T12:01:00.000Z",
      },
      "Archive Topic",
      2,
    );
    const systemRecord = formatTopicArchiveTranscriptRecord(
      {
        id: "m3",
        topic_id: "topic-1",
        parent_id: null,
        author_id: "system",
        text: "Model switched.",
        query_id: null,
        agent_type: null,
        model: null,
        attachments: null,
        usage: null,
        deleted: 0,
        created_at: "2026-06-23T12:02:00.000Z",
      },
      "Archive Topic",
      3,
    );

    expect(aiRecord.role).toBe("assistant");
    expect(aiRecord.speaker).toBe("assistant:codex");
    expect(aiRecord.usage).toEqual({ input: 10, output: 4 });
    expect(systemRecord.role).toBe("system");
    expect(systemRecord.speaker).toBe("system");
  });
});
