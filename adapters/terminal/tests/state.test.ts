import { describe, expect, test } from "bun:test";
import type { MessageDto, TopicDto } from "@negotium/core";
import {
  activeQuestion,
  applyRuntimeEvent,
  createInitialState,
  setMessages,
  setTopics,
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
