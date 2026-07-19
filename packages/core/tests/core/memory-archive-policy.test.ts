import { describe, expect, test } from "bun:test";
import {
  countMemoryArchiveExchanges,
  MIN_MEMORY_ARCHIVE_EXCHANGES,
} from "#agents/memory-archive-policy";

describe("memory archive policy", () => {
  test("matches Clawgram's six completed Q&A threshold", () => {
    expect(MIN_MEMORY_ARCHIVE_EXCHANGES).toBe(6);
  });

  test("counts completed exchanges and ignores system, tool, and subagent noise", () => {
    expect(
      countMemoryArchiveExchanges([
        { author_id: "system", kind: "system" },
        { author_id: "owner" },
        { author_id: "ai", kind: "tool" },
        { author_id: "ai" },
        { author_id: "ai", kind: "subagent" },
        { author_id: "owner" },
        { author_id: "owner" },
        { author_id: "ai", agent_type: "codex" },
        { author_id: "owner" },
      ]),
    ).toBe(2);
  });
});
