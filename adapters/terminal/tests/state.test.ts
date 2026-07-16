import { describe, expect, test } from "bun:test";
import type { MessageDto, TopicDto } from "@negotium/core";
import {
  activeQuestion,
  applyRuntimeEvent,
  createInitialState,
  focusCreatedTopic,
  moveTopicPickerSelection,
  openTopicPicker,
  selectTopic,
  setBackgroundSessions,
  setMessages,
  setTopics,
  startTopicCreation,
} from "@/state";

function topic(id: string, title: string): TopicDto {
  return {
    id,
    title,
    kind: "agent",
    agent: "maestro",
    defaultModel: "deepseek-pro",
    defaultEffort: "medium",
    participants: [{ userId: "local", role: "owner" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    lastMessageAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("terminal adapter state", () => {
  test("keeps a selected topic while refreshing the topic list", () => {
    let state = setTopics(createInitialState("local"), [topic("a", "A"), topic("b", "B")]);
    state = { ...state, activeTopicId: "b" };
    state = setTopics(state, [topic("a", "A"), topic("b", "B")]);
    expect(state.activeTopicId).toBe("b");
  });

  test("places subagent topics directly after their visible parent", () => {
    const parent = topic("parent", "Parent");
    const child = {
      ...topic("child", "Child"),
      isSubagent: true,
      parentTopicId: parent.id,
    };
    const other = topic("other", "Other");

    const state = setTopics(createInitialState("local"), [child, parent, other]);

    expect(state.topics.map((candidate) => candidate.id)).toEqual(["parent", "child", "other"]);
  });

  test("uses the same Manager-first order for rendering and keyboard navigation", () => {
    const work = topic("work", "Work");
    const general = { ...topic("general", "General"), kind: "manager" as const };
    let state = setTopics(createInitialState("local"), [work, general]);
    state = openTopicPicker(state, undefined, true);

    expect(state.topics.map((candidate) => candidate.id)).toEqual(["general", "work"]);
    expect(state.topics[state.topicPickerIndex]?.id).toBe("general");
    state = moveTopicPickerSelection(state, 1);
    expect(state.topics[state.topicPickerIndex]?.id).toBe("work");

    state = setTopics(state, [general, topic("new", "New"), work]);
    expect(state.topics[state.topicPickerIndex]?.id).toBe("work");
  });

  test("navigates grouped background sessions after topics and drops finished selections", () => {
    let state = setTopics(createInitialState("local"), [topic("general", "General")]);
    state = setBackgroundSessions(state, [
      {
        id: "cron-1",
        kind: "cron",
        title: "Cron work",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "Running",
        steps: [],
      },
      {
        id: "memory-1",
        kind: "memory",
        title: "Archive work",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "Writing",
        steps: ["Tool: wiki_save"],
      },
    ]);

    state = moveTopicPickerSelection(state, 1);
    expect(state.topicPickerBackgroundId).toBe("memory-1");
    state = moveTopicPickerSelection(state, 1);
    expect(state.topicPickerBackgroundId).toBe("cron-1");

    state = { ...state, overlay: "background-session" };
    state = setBackgroundSessions(state, []);
    expect(state.overlay).toBe("topics");
    expect(state.topicPickerBackgroundId).toBeUndefined();
  });

  test("keeps an orphaned subagent visible in its original position", () => {
    const child = {
      ...topic("child", "Child"),
      isSubagent: true,
      parentTopicId: "missing-parent",
    };

    const state = setTopics(createInitialState("local"), [child, topic("other", "Other")]);

    expect(state.topics.map((candidate) => candidate.id)).toEqual(["child", "other"]);
  });

  test("focuses a created topic before the refreshed list arrives", () => {
    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = focusCreatedTopic(state, topic("b", "B"));

    expect(state.activeTopicId).toBe("b");
    expect(state.topics.map((candidate) => candidate.id)).toEqual(["a", "b"]);

    state = setTopics(state, [topic("a", "A"), topic("b", "B")]);
    expect(state.activeTopicId).toBe("b");
  });

  test("opens the topic picker on the active topic after a deletion refresh", () => {
    let state = setTopics(createInitialState("local"), [topic("a", "A"), topic("b", "B")]);
    state = { ...state, activeTopicId: "b" };
    state = openTopicPicker(state, "Deleted A");

    expect(state.overlay).toBe("topics");
    expect(state.topicPickerIndex).toBe(1);
    expect(state.notice).toBe("Deleted A");
  });

  test("keeps the startup topic picker independent from an active General conversation", () => {
    let state = setTopics(createInitialState("local"), [
      topic("general", "General"),
      topic("a", "A"),
    ]);
    state = openTopicPicker(state, undefined, true);

    expect(state.overlay).toBe("topics");
    expect(state.topicPickerRoot).toBe(true);
    expect(state.activeTopicId).toBeNull();

    state = selectTopic(state, "a");
    expect(state.topicPickerRoot).toBe(false);
    expect(state.activeTopicId).toBe("a");
  });

  test("starts topic creation without exposing an internal slash command", () => {
    const state = startTopicCreation(createInitialState("local"));

    expect(state.creatingTopic).toBe(true);
    expect(state.overlay).toBeNull();
    expect(state.input).toBe("");
    expect(state.notice).toContain("topic name");
  });

  test("keeps one local start time when the same active event is replayed", () => {
    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { kind: "ai_active", queryId: "q" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      createdAt: "2026-01-01T00:00:05.000Z",
      payload: { kind: "ai_active", queryId: "q" },
    });

    expect(state.activity.a?.startedAtMs).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  test("ignores late terminal events from a superseded query", () => {
    const staleTerminals = [
      { kind: "ai_done", queryId: "old" },
      { kind: "ai_aborted", queryId: "old", reason: "superseded" },
      { kind: "ai_error", queryId: "old", error: "late failure" },
    ] as const;

    for (const terminal of staleTerminals) {
      let state = setTopics(createInitialState("local"), [topic("a", "A")]);
      state = applyRuntimeEvent(state, {
        type: "ai-status",
        topicId: "a",
        payload: { kind: "ai_active", queryId: "old" },
      });
      state = applyRuntimeEvent(state, {
        type: "ai-status",
        topicId: "a",
        payload: { kind: "ai_active", queryId: "new" },
      });
      state = applyRuntimeEvent(state, {
        type: "ai-status",
        topicId: "a",
        payload: terminal,
      });

      expect(state.activity.a).toMatchObject({
        running: true,
        queryId: "new",
        status: "Thinking…",
      });
    }
  });

  test("ignores late tool events from a superseded query", () => {
    const staleTools = [
      { kind: "tool_call", queryId: "old", toolUseId: "late", name: "Bash", label: "Bash(pwd)" },
      { kind: "tool_output", queryId: "old", toolUseId: "late", content: "/tmp" },
      { kind: "tool_status", queryId: "old", content: "late status" },
    ] as const;

    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      payload: { kind: "ai_active", queryId: "old" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      payload: { kind: "ai_active", queryId: "new" },
    });

    for (const payload of staleTools) {
      state = applyRuntimeEvent(state, { type: "ai-status", topicId: "a", payload });
    }

    expect(state.activity.a).toMatchObject({
      running: true,
      queryId: "new",
      status: "Thinking…",
      tools: [],
    });
    expect(state.messages.a ?? []).toEqual([]);
  });

  test("applies a terminal event for the current query", () => {
    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      payload: { kind: "ai_active", queryId: "new" },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      payload: { kind: "ai_aborted", queryId: "new", reason: "stopped" },
    });

    expect(state.activity.a).toMatchObject({
      running: false,
      queryId: "new",
      status: "Aborted",
    });
  });

  test("tracks blocking ask cards and clears them after selection", () => {
    const ask: MessageDto = {
      id: "ask-1",
      topicId: "a",
      authorId: "ai",
      text: "Choose",
      kind: "ask_user_question",
      askUserQuestion: { question: "Choose", choices: [{ label: "Safe" }] },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = setMessages(state, "a", [ask]);
    expect(activeQuestion(state)?.id).toBe("ask-1");
    state = applyRuntimeEvent(state, {
      type: "message-updated",
      topicId: "a",
      payload: {
        messageId: "ask-1",
        patch: {
          askUserQuestion: {
            question: "Choose",
            choices: [{ label: "Safe" }],
            selectedLabel: "Safe",
          },
        },
      },
    });
    expect(activeQuestion(state)).toBeNull();
  });

  test("removes a live message after a supersede tombstone", () => {
    const message: MessageDto = {
      id: "obsolete",
      topicId: "a",
      authorId: "ai",
      text: "obsolete status",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = setMessages(state, "a", [message]);
    state = applyRuntimeEvent(state, {
      type: "message-updated",
      topicId: "a",
      payload: {
        messageId: message.id,
        patch: { deleted: true, text: "" },
      },
    });

    expect(state.messages.a).toEqual([]);
  });

  test("pairs tool output with the current tool activity", () => {
    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      payload: {
        kind: "tool_call",
        queryId: "q",
        toolUseId: "t",
        label: "Bash(test)",
      },
    });
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      payload: {
        kind: "tool_output",
        queryId: "q",
        toolUseId: "t",
        content: "ok",
      },
    });
    expect(state.activity.a?.tools[0]).toMatchObject({
      status: "done",
      output: "ok",
    });
    expect(state.messages.a?.[0]).toMatchObject({
      kind: "tool",
      text: "Bash · test",
    });
    expect(state.messages.a?.[0]?.editedAt).toBeDefined();
  });

  test("keeps tool calls inline before the agent message that follows", () => {
    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = applyRuntimeEvent(state, {
      type: "ai-status",
      topicId: "a",
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        kind: "tool_call",
        queryId: "q",
        toolUseId: "edit",
        name: "Edit",
        label: "Edit(/workspace/src/app.ts)",
        input: {
          file_path: "/workspace/src/app.ts",
          before: "const oldValue = true;",
          after: "const newValue = true;",
        },
      },
    });
    state = applyRuntimeEvent(state, {
      type: "message",
      topicId: "a",
      payload: {
        id: "answer",
        topicId: "a",
        authorId: "ai",
        text: "Updated it.",
        createdAt: "2026-01-01T00:00:02.000Z",
      } satisfies MessageDto,
    });
    expect(state.messages.a?.map((message) => message.kind ?? "message")).toEqual([
      "tool",
      "message",
    ]);
    expect(state.messages.a?.[0]?.text).toContain("- const oldValue");
    expect(state.messages.a?.[0]?.text).toContain("+ const newValue");
  });

  test("does not jump to the live edge while the user is reading history", () => {
    let state = setTopics(createInitialState("local"), [topic("a", "A")]);
    state = { ...state, scrollOffset: 24 };
    state = applyRuntimeEvent(state, {
      type: "message",
      topicId: "a",
      payload: {
        id: "new-message",
        topicId: "a",
        authorId: "ai",
        text: "new reply",
        createdAt: "2026-01-01T00:00:00.000Z",
      } satisfies MessageDto,
    });
    expect(state.scrollOffset).toBe(24);
  });
});
