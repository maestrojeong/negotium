/**
 * A provider-internal retry is not the end of the turn.
 *
 * The node retries a query twice on its own: after a session expiry, and once
 * after a zero-content "success" from the CLI. Both used to broadcast
 * `ai_aborted` for the old queryId and restart under a fresh one. That reads
 * as a terminal event to a host: Otium revokes the turn's remote session-comm
 * capability on `ai_done`/`ai_error`/`ai_aborted` for the turn's queryId, so
 * the retried attempt — the same logical turn, carrying the same grant — found
 * every remote tool answering 401. A fresh queryId made it worse: the original
 * id then never got a terminal event at all, so the capability stayed valid
 * for its whole 4 h ceiling.
 *
 * So: no terminal event for an internal retry, and the queryId carries over.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { startAiTurn } from "#runtime/turn-runner";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { listRecentRuntimeEventsForTopic } from "#storage/runtime-events";

// bun's mock.module is process-global and outlives this file, so snapshot the
// real module first and put it back afterwards. Without the restore, test files
// that run later (the order differs between macOS and Linux CI) see a stubbed
// mcp-config with no host-grant merging.
const realMcpConfig = { ...(await import("#platform/mcp-config")) };
mock.module("#platform/mcp-config", () => ({
  ...realMcpConfig,
  getMcpServersForQuery: () => ({}),
}));

afterAll(() => {
  mock.module("#platform/mcp-config", () => realMcpConfig);
});

const topicIds = new Set<string>();

function seedTopic(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `internal-retry-${id}`,
    kind: "agent",
    agent: "claude",
    defaultModel: "sonnet",
    defaultEffort: "medium",
    participants: [{ userId: "owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  topicIds.add(id);
  return id;
}

afterEach(() => {
  for (const topicId of topicIds) deleteTopic(topicId);
  topicIds.clear();
});

/** Kinds of the runtime status events this topic recorded, in order. */
function statusKinds(topicId: string): Array<{ kind: string; queryId: string }> {
  return listRecentRuntimeEventsForTopic(topicId)
    .map((event) => event.payload)
    .filter(
      (payload): payload is { kind: string; queryId: string } =>
        typeof payload === "object" &&
        payload !== null &&
        "kind" in payload &&
        "queryId" in payload &&
        typeof (payload as { queryId?: unknown }).queryId === "string",
    )
    .map(({ kind, queryId }) => ({ kind, queryId }));
}

describe("provider-internal retries", () => {
  test("an empty first response is retried under the SAME queryId, with no terminal event in between", async () => {
    let attempts = 0;
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: async function* () {
        attempts += 1;
        yield { type: "system", subtype: "init", session_id: `sess-empty-${attempts}` };
        if (attempts === 1) {
          // The observed shape: a terminal "success" with nothing in it.
          yield { type: "result", subtype: "success", result: "", stop_reason: "end_turn" };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "the real answer" }] },
        };
        yield {
          type: "result",
          subtype: "success",
          result: "the real answer",
          stop_reason: "end_turn",
        };
      },
    }));

    const topicId = seedTopic();
    const requestId = `req-${randomUUID()}`;
    const settled = new Promise<{ kind: string }>((resolve) => {
      startAiTurn({
        topic: { id: topicId, agent: "claude", title: `internal-retry-${topicId}` } as never,
        userId: "owner",
        prompt: "answer me",
        allowAutoContinue: false,
        _queryId: requestId,
        onSettled: (result) => resolve(result),
      });
    });
    expect(await settled).toMatchObject({ kind: "completed", queryId: requestId });
    expect(attempts).toBe(2);

    const statuses = statusKinds(topicId);
    // Nothing terminal for this turn until it actually finished.
    expect(statuses.filter((s) => s.kind === "ai_aborted")).toEqual([]);
    expect(statuses.filter((s) => s.kind === "ai_error")).toEqual([]);
    // And the whole turn — both attempts — is one queryId, so the host's
    // (queryId → capability) binding still names something that will end.
    expect(new Set(statuses.map((s) => s.queryId))).toEqual(new Set([requestId]));
    expect(statuses.at(-1)).toEqual({ kind: "ai_done", queryId: requestId });
  });

  test("a session expiry is retried under the SAME queryId, with no terminal event in between", async () => {
    let attempts = 0;
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: async function* () {
        attempts += 1;
        yield { type: "system", subtype: "init", session_id: `sess-expired-${attempts}` };
        if (attempts === 1) {
          yield {
            type: "result",
            subtype: "error_during_execution",
            errors: ["session not found"],
            is_error: true,
          };
          return;
        }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "recovered" }] },
        };
        yield { type: "result", subtype: "success", result: "recovered", stop_reason: "end_turn" };
      },
    }));

    const topicId = seedTopic();
    const requestId = `req-${randomUUID()}`;
    const settled = new Promise<{ kind: string }>((resolve) => {
      startAiTurn({
        topic: { id: topicId, agent: "claude", title: `internal-retry-${topicId}` } as never,
        userId: "owner",
        prompt: "answer me",
        allowAutoContinue: false,
        _queryId: requestId,
        onSettled: (result) => resolve(result),
      });
    });
    expect(await settled).toMatchObject({ kind: "completed", queryId: requestId });
    expect(attempts).toBe(2);

    const statuses = statusKinds(topicId);
    expect(statuses.filter((s) => s.kind === "ai_aborted")).toEqual([]);
    expect(new Set(statuses.map((s) => s.queryId))).toEqual(new Set([requestId]));
    expect(statuses.at(-1)).toEqual({ kind: "ai_done", queryId: requestId });
  });
});
