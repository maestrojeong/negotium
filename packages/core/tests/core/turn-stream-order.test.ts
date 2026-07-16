import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerPeerRuntimeBridge } from "#mcp/peer-bridge";
import { resolveTopicWorkspaceDir } from "#platform/config";
import type { RoomQueryControl } from "#query/active-rooms";
import { AbortReason } from "#query/types";
import { fileHooks, setFileHooks } from "#runtime/file-hooks";
import { streamAgentEvents, wasLocallyRequeuedAfterUserPreemption } from "#runtime/turn-runner";
import { listApiMessages } from "#storage/api-messages";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { latestRuntimeEventSeq, listRuntimeEventsAfter } from "#storage/runtime-events";
import type { UnifiedEvent } from "#types";

const topicIds = new Set<string>();

function seedTopic(): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `stream-order-${id}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    participants: [{ userId: "owner", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  topicIds.add(id);
  return id;
}

async function* eventStream(): AsyncGenerator<UnifiedEvent> {
  yield { type: "text_delta", content: "first status" };
  yield { type: "text", content: "first status" };
  yield {
    type: "tool_use",
    name: "Bash",
    input: { command: "pwd" },
    toolUseId: "tool-1",
  };
  yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
  yield { type: "text_delta", content: "second status" };
  yield { type: "text", content: "second status" };
  yield {
    type: "tool_use",
    name: "Bash",
    input: { command: "git status" },
    toolUseId: "tool-2",
  };
  yield { type: "tool_result", toolUseId: "tool-2", content: "clean" };
  yield { type: "text_delta", content: "final answer" };
  yield { type: "text", content: "final answer" };
  yield {
    type: "result",
    content: "first statussecond statusfinal answer",
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 3 },
  };
}

afterEach(() => {
  for (const topicId of topicIds) deleteTopic(topicId);
  topicIds.clear();
});

describe("turn stream ordering", () => {
  test("only suppresses settlement after a replay was actually queued locally", () => {
    const injectParams = {
      topicId: "topic",
      runtimeEpoch: 1,
      userId: "owner",
      prompt: "scheduled",
      origin: "Scheduled self",
    };
    expect(
      wasLocallyRequeuedAfterUserPreemption("aborted", {
        abortReason: AbortReason.Internal,
        injectParams,
        injectRequeued: true,
      }),
    ).toBe(true);
    expect(
      wasLocallyRequeuedAfterUserPreemption("aborted", {
        abortReason: AbortReason.Internal,
        injectParams,
        injectRequeued: false,
      }),
    ).toBe(false);
    expect(
      wasLocallyRequeuedAfterUserPreemption("aborted", {
        abortReason: AbortReason.External,
        injectParams,
        injectRequeued: true,
      }),
    ).toBe(false);
  });

  test("does not trim a legitimate post-tool sentence that repeats an earlier prefix", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    async function* repeatedPrefixStream(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text_delta", content: "I" };
      yield { type: "text", content: "I" };
      yield { type: "tool_use", name: "Bash", input: { command: "pwd" }, toolUseId: "tool-1" };
      yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
      yield { type: "text_delta", content: "I found it" };
      yield { type: "text", content: "I found it" };
      yield { type: "result", content: "I found it", stopReason: "end_turn" };
    }

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      repeatedPrefixStream(),
      control,
      "maestro",
      "deepseek",
      "medium",
      "owner",
    );

    expect(listApiMessages(topicId).page.map((message) => message.text)).toEqual([
      "I",
      "I found it",
    ]);
  });

  test("bridges peer HTML once after the ordered event barrier", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const bridged: string[] = [];
    const bridgeOrder: string[] = [];
    const unregister = registerPeerRuntimeBridge({
      async spawnSubagent() {
        return { content: [{ type: "text", text: "unused" }] };
      },
      async flushEvents() {
        bridgeOrder.push("flush");
        return true;
      },
      async showVisual(request) {
        bridgeOrder.push("visual");
        bridged.push(request.html ?? "");
        return { ok: true, id: 42, url: "/visual/42", title: request.title ?? null };
      },
    });
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    async function* visualEvents(): AsyncGenerator<UnifiedEvent> {
      yield {
        type: "tool_use",
        name: "mcp__runtime__show_html",
        input: { html: "<p>peer visual</p>", title: "Peer visual" },
        toolUseId: "visual-tool",
      };
      yield { type: "tool_result", toolUseId: "visual-tool", content: "displayed" };
      yield { type: "result", content: "done", stopReason: "end_turn" };
    }

    try {
      await streamAgentEvents(
        topicId,
        "stream order",
        queryId,
        visualEvents(),
        control,
        "codex",
        "gpt-5.6-luna",
        "medium",
        "owner",
        true,
        undefined,
        {
          peerBridge: {
            hubCellId: "hub-cell",
            hostTopicId: "host-topic",
            hostQueryId: "host-query",
            canSpawnSubagents: true,
          },
        },
      );
      expect(bridged).toEqual(["<p>peer visual</p>"]);
      expect(bridgeOrder).toEqual(["flush", "visual"]);
    } finally {
      unregister();
    }
  });

  test("bridges peer media once without forwarding a duplicate visual event", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const cwd = resolveTopicWorkspaceDir(topicId);
    const imagePath = join(cwd, "peer-image.png");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(imagePath, new Uint8Array([137, 80, 78, 71]));
    const uploadId = randomUUID();
    const previousHooks = fileHooks();
    setFileHooks({
      resolveAttachmentByFileId(fileId) {
        return fileId === uploadId
          ? {
              id: uploadId,
              type: "image",
              filename: "peer-image.png",
              url: `/uploads/${uploadId}`,
              mimeType: "image/png",
              sizeBytes: 4,
            }
          : null;
      },
      resolveUploadedFilePathByFileId(fileId) {
        return fileId === uploadId ? imagePath : null;
      },
      storeLocalFileAsUpload() {
        return {
          id: uploadId,
          type: "image",
          filename: "peer-image.png",
          url: `/uploads/${uploadId}`,
          mimeType: "image/png",
          sizeBytes: 4,
        };
      },
    });
    const bridged: string[] = [];
    const bridgeOrder: string[] = [];
    const unregister = registerPeerRuntimeBridge({
      async spawnSubagent() {
        return { content: [{ type: "text", text: "unused" }] };
      },
      async showVisual(request) {
        bridgeOrder.push("visual");
        bridged.push(request.fileId ?? "");
        return { ok: true, id: 91, url: "/visual/91", title: request.title ?? null };
      },
      async flushEvents() {
        bridgeOrder.push("flush");
        return true;
      },
    });
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    const after = latestRuntimeEventSeq();
    async function* mediaEvents(): AsyncGenerator<UnifiedEvent> {
      yield {
        type: "tool_use",
        name: "mcp__runtime__show_image",
        input: { file_path: imagePath, title: "Peer image" },
        toolUseId: "image-tool",
      };
      yield { type: "tool_result", toolUseId: "image-tool", content: "displayed" };
      yield { type: "result", content: "done", stopReason: "end_turn" };
    }

    try {
      await streamAgentEvents(
        topicId,
        "stream order",
        queryId,
        mediaEvents(),
        control,
        "codex",
        "gpt-5.6-luna",
        "medium",
        "owner",
        true,
        undefined,
        {
          peerBridge: {
            hubCellId: "hub-cell",
            hostTopicId: "host-topic",
            hostQueryId: "host-query",
            canSpawnSubagents: true,
          },
        },
      );
      expect(bridged).toEqual([uploadId]);
      expect(bridgeOrder).toEqual(["flush", "visual"]);
      const statuses = listRuntimeEventsAfter(after)
        .filter((event) => event.topicId === topicId && event.type === "ai-status")
        .map((event) => (event.payload as { kind?: string }).kind);
      expect(statuses.filter((kind) => kind === "visual")).toHaveLength(0);
      expect(statuses.filter((kind) => kind === "tool_call")).toHaveLength(1);
      expect(statuses.filter((kind) => kind === "tool_output")).toHaveLength(1);
    } finally {
      unregister();
      setFileHooks(previousHooks);
      rmSync(imagePath, { force: true });
    }
  });

  test("does not bridge sensitive files emitted through legacy file events", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const cwd = resolveTopicWorkspaceDir(topicId);
    const sensitivePath = join(cwd, ".env");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(sensitivePath, "SECRET=do-not-send");
    const sent: string[] = [];
    const unregister = registerPeerRuntimeBridge({
      async spawnSubagent() {
        return { content: [{ type: "text", text: "unused" }] };
      },
      async sendFile(request) {
        sent.push(request.path);
        return { ok: true };
      },
    });
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    async function* fileEvents(): AsyncGenerator<UnifiedEvent> {
      yield { type: "file", path: sensitivePath, source: "legacy-file-tag", origin: "tag" };
      yield { type: "result", content: "done", stopReason: "end_turn" };
    }

    try {
      await streamAgentEvents(
        topicId,
        "stream order",
        queryId,
        fileEvents(),
        control,
        "codex",
        "gpt-5.6-luna",
        "medium",
        "owner",
        true,
        undefined,
        {
          peerBridge: {
            hubCellId: "hub-cell",
            hostTopicId: "host-topic",
            hostQueryId: "host-query",
            canSpawnSubagents: true,
          },
        },
      );
      expect(sent).toEqual([]);
    } finally {
      unregister();
      rmSync(sensitivePath, { force: true });
    }
  });

  test("persists assistant segments before the tools that follow them", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    const after = latestRuntimeEventSeq();

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      eventStream(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    const timeline = listRuntimeEventsAfter(after)
      .filter((event) => event.topicId === topicId)
      .map((event) => {
        if (event.type === "message") {
          return `message:${(event.payload as { text?: string }).text ?? ""}`;
        }
        if (event.type === "ai-status") {
          const payload = event.payload as { kind?: string; toolUseId?: string };
          if (payload.kind === "tool_call") return `tool:${payload.toolUseId}`;
          if (payload.kind === "tool_output") return `output:${payload.toolUseId}`;
          if (payload.kind === "ai_done") return "done";
        }
        return null;
      })
      .filter((item): item is string => item !== null);

    expect(timeline).toEqual([
      "message:first status",
      "tool:tool-1",
      "output:tool-1",
      "message:second status",
      "tool:tool-2",
      "output:tool-2",
      "message:final answer",
      "done",
    ]);
    expect(listApiMessages(topicId).page.map((message) => message.text)).toEqual([
      "first status",
      "second status",
      "final answer",
    ]);
    expect(listApiMessages(topicId).page.at(-1)?.usage).toEqual({ input: 10, output: 3 });
  });

  test("accepts a completed-only text segment after an earlier streamed segment", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    async function* mixedTextStream(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text_delta", content: "streamed status" };
      yield { type: "text", content: "streamed status" };
      yield {
        type: "tool_use",
        name: "Bash",
        input: { command: "pwd" },
        toolUseId: "tool-1",
      };
      yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
      yield { type: "text", content: "completed-only answer" };
      yield {
        type: "result",
        content: "completed-only answer",
        stopReason: "end_turn",
        usage: { inputTokens: 4, outputTokens: 2 },
      };
    }

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      mixedTextStream(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    expect(listApiMessages(topicId).page.map((message) => message.text)).toEqual([
      "streamed status",
      "completed-only answer",
    ]);
  });

  test("attaches final usage to the last segment after a tool-only ending", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    const after = latestRuntimeEventSeq();
    async function* toolOnlyEnding(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text", content: "status before final tool" };
      yield {
        type: "tool_use",
        name: "Bash",
        input: { command: "pwd" },
        toolUseId: "tool-1",
      };
      yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
      yield {
        type: "result",
        content: "status before final tool",
        stopReason: "end_turn",
        usage: { inputTokens: 8, outputTokens: 2 },
      };
    }

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      toolOnlyEnding(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    const messages = listApiMessages(topicId).page;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: "status before final tool",
      usage: { input: 8, output: 2 },
    });
    expect(
      listRuntimeEventsAfter(after)
        .filter((event) => event.topicId === topicId && event.type === "message-updated")
        .map((event) => event.payload),
    ).toContainEqual({
      messageId: messages[0]?.id,
      patch: { usage: { input: 8, output: 2 } },
    });
  });

  test("removes already-flushed assistant segments when the turn is superseded", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    const after = latestRuntimeEventSeq();
    async function* supersededStream(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text_delta", content: "obsolete status" };
      yield { type: "text", content: "obsolete status" };
      yield {
        type: "tool_use",
        name: "Bash",
        input: { command: "pwd" },
        toolUseId: "tool-1",
      };
      control.abortReason = AbortReason.Internal;
      control.abortController.abort();
      yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
    }

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      supersededStream(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    expect(listApiMessages(topicId).page).toEqual([]);
    expect(
      listRuntimeEventsAfter(after)
        .filter((event) => event.topicId === topicId && event.type === "message-updated")
        .map((event) => event.payload),
    ).toContainEqual({
      messageId: expect.any(String),
      patch: { deleted: true, text: "" },
    });
  });

  test("preserves intermediate assistant messages when the user explicitly aborts", async () => {
    const topicId = seedTopic();
    const queryId = randomUUID();
    const control: RoomQueryControl = {
      topicId,
      queryId,
      origin: "user",
      prompt: "test",
      abortController: new AbortController(),
      abortReason: AbortReason.None,
    };
    const after = latestRuntimeEventSeq();
    async function* explicitlyAbortedStream(): AsyncGenerator<UnifiedEvent> {
      yield { type: "text_delta", content: "kept status" };
      yield { type: "text", content: "kept status" };
      yield {
        type: "tool_use",
        name: "Bash",
        input: { command: "pwd" },
        toolUseId: "tool-1",
      };
      yield { type: "tool_result", toolUseId: "tool-1", content: "/tmp" };
      yield { type: "text_delta", content: "kept tail" };
      control.abortReason = AbortReason.External;
      control.abortController.abort();
      yield { type: "text", content: "ignored after abort" };
    }

    await streamAgentEvents(
      topicId,
      "stream order",
      queryId,
      explicitlyAbortedStream(),
      control,
      "codex",
      "gpt-5.6-luna",
      "medium",
      "owner",
    );

    expect(listApiMessages(topicId).page.map((message) => message.text)).toEqual([
      "kept status",
      "kept tail",
    ]);
    expect(
      listRuntimeEventsAfter(after)
        .filter((event) => event.topicId === topicId && event.type === "message-updated")
        .some((event) => (event.payload as { patch?: { deleted?: boolean } }).patch?.deleted),
    ).toBe(false);
  });
});
