import { describe, expect, test } from "bun:test";
import type { MessageDto, TopicDto } from "@negotium/core";
import {
  displayWidth,
  effectiveTopicModel,
  renderApp,
  stripAnsi,
  WORKING_FRAME_INTERVAL_MS,
  workingFrame,
  wrapText,
} from "@/render";
import { applyRuntimeEvent, createInitialState, setMessages, setTopics } from "@/state";

function topic(): TopicDto {
  return {
    id: "topic",
    title: "Terminal",
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt",
    defaultEffort: "medium",
    participants: [{ userId: "local", role: "owner" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("terminal renderer", () => {
  test("counts Korean glyphs as wide characters", () => {
    expect(displayWidth("a한")).toBe(3);
    expect(wrapText("가나다", 4)).toEqual(["가나", "다"]);
  });

  test("fills exactly the requested terminal height", () => {
    const output = renderApp(createInitialState("local"), 120, 30);
    expect(output.split("\n")).toHaveLength(30);
  });

  test("keeps the always-active message composer flat and borderless", () => {
    const output = stripAnsi(renderApp(createInitialState("local"), 120, 30));
    const lines = output.split("\n");
    const labelIndex = lines.findIndex((line) => line.includes("Ctrl-O topics"));
    expect(output).toContain("Ctrl-O topics");
    expect(output).not.toContain("Enter send");
    expect(output).not.toContain("Ctrl-J");
    expect(output).not.toContain("╭ message");
    expect(output).not.toContain("╰");
    expect(lines[labelIndex - 3]?.trim()).toBe("");
    expect(lines[labelIndex - 2]).toContain("Type a message");
    expect(lines[labelIndex - 1]?.trim()).toBe("");
  });

  test("shows a dedicated topic-name composer after choosing new topic", () => {
    const state = { ...createInitialState("local"), creatingTopic: true };
    const output = stripAnsi(renderApp(state, 120, 30));

    expect(output).toContain("new topic · type a name · Enter create");
    expect(output).toContain("Type a topic name…");
    expect(output).not.toContain("/new ");
  });

  test("places terminal status below the composer without a product wordmark", () => {
    const state = setTopics(createInitialState("local"), [topic()]);
    const output = stripAnsi(renderApp(state, 120, 30));
    const lines = output.split("\n");
    const composerIndex = lines.findIndex((line) => line.includes("Type a message"));
    const statusIndex = lines.findIndex((line) => line.includes("Terminal · codex · gpt"));

    expect(statusIndex).toBeGreaterThan(composerIndex);
    expect(lines[statusIndex]).toContain("○ ready");
    expect(output).not.toContain("NEGOTIUM");
  });

  test("does not display a stale Maestro model after switching the topic to Codex", () => {
    const stale = { ...topic(), defaultModel: "deepseek-pro" };
    expect(effectiveTopicModel(stale)).toBe("gpt-5.6-luna");

    const state = setTopics(createInitialState("local"), [stale]);
    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Terminal · codex · gpt-5.6-luna");
    expect(output).not.toContain("Terminal · codex · deepseek-pro");
  });

  test("shows the persisted per-topic model override in the footer", () => {
    const configured = { ...topic(), effectiveModel: "gpt-5.6-sol" };
    expect(effectiveTopicModel(configured)).toBe("gpt-5.6-sol");

    const state = setTopics(createInitialState("local"), [configured]);
    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Terminal · codex · gpt-5.6-sol");
  });

  test("shows both the agent and effective model in the topic picker", () => {
    const state = {
      ...setTopics(createInitialState("local"), [topic()]),
      overlay: "topics" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("Terminal  ·  codex  ·  gpt");
  });

  test("separates latest context occupancy from aggregate turn spend", () => {
    const message: MessageDto = {
      id: "usage-message",
      topicId: "topic",
      authorId: "ai",
      text: "done",
      usage: {
        input: 1_343_881,
        output: 4_698,
        cachedInput: 1_230_336,
        context: 104_464,
        contextWindow: 258_400,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const state = {
      ...setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [message]),
      overlay: "status" as const,
    };

    const output = stripAnsi(renderApp(state, 120, 30));
    expect(output).toContain("104K / 258K (40%)");
    expect(output).toContain("input 1.34M");
    expect(output).toContain("Cache read  1.23M");
    expect(output).toContain("not context size");
  });

  test("strips terminal escape sequences", () => {
    expect(stripAnsi("safe\u001b[2Jbad")).toBe("safebad");
  });

  test("renders markdown lists and fenced code in the conversation flow", () => {
    const message: MessageDto = {
      id: "message",
      topicId: "topic",
      authorId: "ai",
      agentType: "codex",
      text: "## Result\n- first\n```ts\nconst ok = true;\n```",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", [message]);
    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("• first");
    expect(output).toContain("code · ts");
    expect(output).toContain("const ok = true;");
  });

  test("hides system messages from the Terminal conversation", () => {
    const systemMessage: MessageDto = {
      id: "system-message",
      topicId: "topic",
      authorId: "system",
      text: "internal orchestration detail",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const state = setMessages(setTopics(createInitialState("local"), [topic()]), "topic", [
      systemMessage,
    ]);

    expect(stripAnsi(renderApp(state, 100, 30))).not.toContain("internal orchestration detail");
  });

  test("shows compact tool status without verbose output", () => {
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "ai_active", queryId: "query" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "tool_call", queryId: "query", toolUseId: "tool", label: "Bash(test)" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "tool_output", queryId: "query", toolUseId: "tool", content: "ok" },
    });
    const output = stripAnsi(renderApp(state, 100, 30));
    expect(output).toContain("Bash · test");
    expect(output).not.toContain("ok");
    expect(output).toContain("Working");
  });

  test("animates the working indicator without requiring another runtime event", () => {
    expect(WORKING_FRAME_INTERVAL_MS).toBe(16);
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: { kind: "ai_active", queryId: "query" },
    });

    const first = stripAnsi(renderApp(state, 100, 30, 0));
    const second = stripAnsi(renderApp(state, 100, 30, 1));
    expect(first).toContain(`${workingFrame(0)} Working`);
    expect(second).toContain(`${workingFrame(1)} Working`);
    expect(first).not.toBe(second);
  });

  test("advances working time from the terminal clock instead of provider heartbeats", () => {
    const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
    let state = setTopics(createInitialState("local"), [topic()]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { kind: "ai_active", queryId: "query" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "topic",
      payload: {
        kind: "tool_status",
        queryId: "query",
        statusKind: "progress",
        content: "Working… 111s",
        toolName: "working",
        elapsed: 111,
      },
    });

    const at106 = stripAnsi(renderApp(state, 100, 30, 0, startedAt + 106_000));
    const at107 = stripAnsi(renderApp(state, 100, 30, 1, startedAt + 107_000));
    expect(at106).toContain("Working · 106s");
    expect(at107).toContain("Working · 107s");
    expect(at106).not.toContain("111s");
  });

  test("shows compact speaker marks without names or timestamps", () => {
    const messages: MessageDto[] = [
      {
        id: "user-message",
        topicId: "topic",
        authorId: "local",
        text: "question",
        createdAt: "2026-01-01T18:39:00.000Z",
      },
      {
        id: "ai-message",
        topicId: "topic",
        authorId: "ai",
        agentType: "codex",
        text: "answer",
        createdAt: "2026-01-01T18:40:00.000Z",
      },
    ];
    let state = setTopics(createInitialState("local"), [topic()]);
    state = { ...state, aiName: "Nova" };
    state = setMessages(state, "topic", messages);

    const rendered = renderApp(state, 100, 30);
    const renderedLines = rendered.split("\n");
    const outputLines = stripAnsi(rendered).split("\n");
    const userLine = renderedLines[outputLines.findIndex((line) => line.includes("› question"))];
    const aiLine = renderedLines[outputLines.findIndex((line) => line.includes("● answer"))];
    const output = outputLines.join("\n");
    expect(output).toContain("› question");
    expect(output).toContain("● answer");
    expect(userLine).toContain("\u001b[48;2;24;27;36m");
    expect(aiLine).toContain("\u001b[48;2;10;11;15m");
    expect(output).not.toContain("You");
    expect(output).not.toContain("Nova");
    expect(output).not.toContain("06:39");
    expect(output).not.toContain("06:40");
  });

  test("clamps at the loaded history boundary and exposes explicit older loading", () => {
    const messages: MessageDto[] = Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      topicId: "topic",
      authorId: "local",
      text: `conversation-${index}`,
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    let state = setTopics(createInitialState("local"), [topic()]);
    state = setMessages(state, "topic", messages);
    const latest = stripAnsi(renderApp(state, 100, 16));
    expect(latest).toContain("conversation-19");
    expect(latest).not.toContain("conversation-0");

    state = {
      ...state,
      scrollOffset: 10_000,
      messageHistory: { topic: { hasMore: true, loading: false } },
    };
    const history = stripAnsi(renderApp(state, 100, 16));
    expect(history).toContain("Loaded history start · Ctrl-E load older");
    expect(history).toContain("conversation-0");
    expect(history).not.toContain("conversation-19");

    state = {
      ...state,
      messageHistory: { topic: { hasMore: false, loading: false } },
    };
    expect(stripAnsi(renderApp(state, 100, 16))).toContain("Start of conversation");
  });
});
