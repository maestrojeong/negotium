import { describe, expect, test } from "bun:test";
import {
  type ArchiverHost,
  createArchiverRuntime,
  type RunArchiverTurnParams,
} from "#agents/archiver";
import type { AgentQueryOptions, UnifiedEvent } from "#types";
import type { MessageDto } from "#types/api";

function createHost(eventFactory: () => AsyncIterable<UnifiedEvent>) {
  let nowMs = Date.parse("2026-07-29T12:00:00.000Z");
  let id = 0;
  let definitionLoads = 0;
  const agentOptions: AgentQueryOptions[] = [];
  const messages: MessageDto[] = [];
  const broadcasts: Array<{ topicId: string; message: MessageDto }> = [];
  const briefs: Array<{
    topicId: string;
    fields: { briefMd: string; latestSummaryMd?: string; summaryDate?: string };
  }> = [];
  const scheduled: Array<() => void> = [];

  const host: ArchiverHost = {
    storage: {
      getWikiDir: () => "/wiki",
      fileExists: () => true,
      listDirectory: () => [],
      readTextFile: () => "---\ntopic: archived\n---\n\n# Summary\nA durable summary line.",
      fileSize: () => 2048,
      fileModifiedAt: () => nowMs,
      getGeneralTopicId: (userId) => `general:${userId}`,
      getTopicBrief: () => null,
      setTopicBrief: (topicId, fields) => {
        briefs.push({ topicId, fields });
      },
    },
    messaging: {
      appendMessage: (message) => {
        messages.push(message);
      },
      broadcastMessage: (topicId, message) => {
        broadcasts.push({ topicId, message });
      },
    },
    config: {
      workspaceDir: "/workspace",
      completedSessionRetentionMs: 1_000,
      loadAgentDefinition: () => {
        definitionLoads++;
        return {
          name: "archiver",
          type: "autonomous",
          model: "host-model",
          prompt: "host system prompt",
        };
      },
      sanitizeTopicName: (title) => title.toLowerCase().replaceAll(" ", "-"),
      createId: () => `id-${++id}`,
      now: () => new Date(nowMs),
      schedule: (callback) => {
        scheduled.push(callback);
        return callback;
      },
      cancelScheduled: () => {},
      info: () => {},
      warn: () => {},
    },
    agentRuntime: {
      run: (options) => {
        agentOptions.push(options);
        return eventFactory();
      },
    },
  };

  return {
    host,
    agentOptions,
    messages,
    broadcasts,
    briefs,
    scheduled,
    definitionLoads: () => definitionLoads,
    advanceTime: (ms: number) => {
      nowMs += ms;
    },
  };
}

function runAndSettle(
  runtime: ReturnType<typeof createArchiverRuntime>,
  params: Omit<RunArchiverTurnParams, "onSettled">,
): Promise<boolean> {
  return new Promise((resolve) => {
    expect(runtime.runArchiverTurn({ ...params, onSettled: resolve })).toBe(true);
  });
}

describe("archiver runtime factory", () => {
  test("owns isolated session lifecycle, prompt cache, and agent event reduction", async () => {
    const fixture = createHost(async function* () {
      yield { type: "session", sessionId: "provider-session" };
      yield { type: "tool_use", name: "wiki_save", input: { topic: "Factory Test" } };
      yield { type: "text_delta", content: "saved " };
      yield { type: "text", content: "duplicate full text" };
      yield { type: "text_delta", content: "memory" };
      yield {
        type: "result",
        content: "result fallback",
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    });
    const runtime = createArchiverRuntime(fixture.host);
    const otherRuntime = createArchiverRuntime(fixture.host);
    const params = {
      userId: "owner",
      topicId: "topic-id",
      topicTitle: "Factory Test",
      archivePath: "/archive/messages.jsonl",
      messageCount: 7,
      mode: "active-topic" as const,
    };

    expect(await runAndSettle(runtime, params)).toBe(true);

    const sessions = runtime.listActiveMemoryArchiverSessions("owner");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      active: false,
      agent: "claude",
      model: "host-model",
      output: "saved memory",
      status: "Completed",
    });
    expect(sessions[0]?.steps).toContain("Provider session started");
    expect(sessions[0]?.steps).toContain("wiki_save(topic: Factory Test)");
    expect(sessions[0]?.steps.at(-1)).toBe("Memory archive completed · 12 B");
    expect(otherRuntime.listActiveMemoryArchiverSessions("owner")).toEqual([]);

    sessions[0]!.steps.push("external mutation");
    expect(runtime.listActiveMemoryArchiverSessions("owner")[0]?.steps).not.toContain(
      "external mutation",
    );
    expect(fixture.agentOptions[0]).toMatchObject({
      agent: "claude",
      cwd: "/workspace",
      systemPrompt: "host system prompt",
      session: "__archiver_factory-test",
      topicId: "topic-id",
      mcpEnabled: ["wiki"],
      silent: true,
    });

    expect(await runAndSettle(runtime, params)).toBe(true);
    expect(fixture.definitionLoads()).toBe(1);
    expect(fixture.messages).toEqual([]);

    fixture.advanceTime(1_001);
    expect(runtime.listActiveMemoryArchiverSessions("owner")).toEqual([]);
  });

  test("routes deleted-topic storage and notifications through the injected host", async () => {
    const fixture = createHost(async function* () {
      yield {
        type: "result",
        content: "General completion reply",
        stopReason: "end_turn",
        usage: { inputTokens: 21, outputTokens: 5 },
      };
    });
    const runtime = createArchiverRuntime(fixture.host);

    expect(
      await runAndSettle(runtime, {
        userId: "owner",
        topicId: "topic-id",
        topicTitle: "Deleted Topic",
        archivePath: "/archive/messages.jsonl",
        rawArchivePaths: ["/archive/events.jsonl"],
        messageCount: 9,
      }),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fixture.briefs).toHaveLength(1);
    expect(fixture.briefs[0]).toMatchObject({
      topicId: "general:owner",
      fields: {
        latestSummaryMd: expect.stringContaining("A durable summary line."),
        summaryDate: "2026-07-29",
      },
    });
    expect(fixture.briefs[0]?.fields.briefMd).toContain(
      "- **Deleted Topic** (2026-07-29): A durable summary line.",
    );
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.messages[0]).toMatchObject({
      topicId: "general:owner",
      authorId: "ai",
      text: "General completion reply",
      agentType: "claude",
      usage: { input: 21, output: 5 },
    });
    expect(fixture.broadcasts).toEqual([
      { topicId: "general:owner", message: fixture.messages[0]! },
    ]);
    expect(fixture.agentOptions[0]?.prompt).toContain("raw_archive_path: /archive/events.jsonl");
  });
});
