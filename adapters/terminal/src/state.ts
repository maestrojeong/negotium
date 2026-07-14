import type { MessageDto, RuntimeBusEvent, TopicDto } from "@negotium/core";

type Overlay = "help" | "topics" | null;

interface ToolActivity {
  id: string;
  label: string;
  output?: string;
  status?: string;
}

interface TopicActivity {
  running: boolean;
  queryId?: string;
  status?: string;
  error?: string;
  tools: ToolActivity[];
}

export interface AppState {
  userId: string;
  topics: TopicDto[];
  activeTopicId: string | null;
  messages: Record<string, MessageDto[]>;
  activity: Record<string, TopicActivity>;
  input: string;
  scrollOffset: number;
  askChoiceIndex: number;
  overlay: Overlay;
  notice?: string;
}

export function createInitialState(userId: string): AppState {
  return {
    userId,
    topics: [],
    activeTopicId: null,
    messages: {},
    activity: {},
    input: "",
    scrollOffset: 0,
    askChoiceIndex: 0,
    overlay: null,
  };
}

export function activeTopic(state: AppState): TopicDto | null {
  return state.topics.find((topic) => topic.id === state.activeTopicId) ?? null;
}

export function activeMessages(state: AppState): MessageDto[] {
  return state.activeTopicId ? (state.messages[state.activeTopicId] ?? []) : [];
}

export function activeQuestion(state: AppState): MessageDto | null {
  return (
    activeMessages(state)
      .slice()
      .reverse()
      .find(
        (message) =>
          message.kind === "ask_user_question" &&
          message.askUserQuestion &&
          !message.askUserQuestion.expired &&
          !message.askUserQuestion.selectedLabel,
      ) ?? null
  );
}

export function activeTaskPanel(state: AppState): MessageDto | null {
  return (
    activeMessages(state)
      .slice()
      .reverse()
      .find((message) => message.id.startsWith("tasks-")) ?? null
  );
}

export function setTopics(state: AppState, topics: TopicDto[], preferredTitle?: string): AppState {
  const stillVisible = topics.some((topic) => topic.id === state.activeTopicId);
  const preferred = preferredTitle
    ? topics.find((topic) => topic.title.toLowerCase() === preferredTitle.toLowerCase())
    : undefined;
  const nextActive = preferred?.id ?? (stillVisible ? state.activeTopicId : topics[0]?.id) ?? null;
  return {
    ...state,
    topics,
    activeTopicId: nextActive,
    scrollOffset: nextActive === state.activeTopicId ? state.scrollOffset : 0,
    askChoiceIndex: nextActive === state.activeTopicId ? state.askChoiceIndex : 0,
  };
}

export function selectTopic(state: AppState, topicId: string): AppState {
  if (!state.topics.some((topic) => topic.id === topicId)) return state;
  return {
    ...state,
    activeTopicId: topicId,
    scrollOffset: 0,
    askChoiceIndex: 0,
    overlay: null,
    notice: undefined,
  };
}

export function setMessages(state: AppState, topicId: string, messages: MessageDto[]): AppState {
  return { ...state, messages: { ...state.messages, [topicId]: messages } };
}

export function upsertMessage(state: AppState, message: MessageDto): AppState {
  const current = state.messages[message.topicId] ?? [];
  const index = current.findIndex((item) => item.id === message.id);
  const next = [...current];
  if (index >= 0) next[index] = message;
  else next.push(message);
  return {
    ...state,
    messages: { ...state.messages, [message.topicId]: next },
    scrollOffset: message.topicId === state.activeTopicId ? 0 : state.scrollOffset,
  };
}

function patchMessage(
  state: AppState,
  topicId: string,
  messageId: string,
  patch: Partial<MessageDto>,
): AppState {
  const current = state.messages[topicId] ?? [];
  const index = current.findIndex((message) => message.id === messageId);
  if (index < 0) return state;
  const next = [...current];
  next[index] = { ...next[index], ...patch } as MessageDto;
  return { ...state, messages: { ...state.messages, [topicId]: next } };
}

function activityFor(state: AppState, topicId: string): TopicActivity {
  return state.activity[topicId] ?? { running: false, tools: [] };
}

function setActivity(state: AppState, topicId: string, activity: TopicActivity): AppState {
  return { ...state, activity: { ...state.activity, [topicId]: activity } };
}

function applyAiStatus(state: AppState, topicId: string, raw: unknown): AppState {
  const status = (raw ?? {}) as Record<string, unknown>;
  const kind = String(status.kind ?? "");
  const current = activityFor(state, topicId);
  if (kind === "ai_active") {
    return setActivity(state, topicId, {
      running: true,
      queryId: String(status.queryId ?? ""),
      status: "Thinking…",
      tools: [],
    });
  }
  if (kind === "ai_done") {
    return setActivity(state, topicId, {
      ...current,
      running: false,
      status: "Done",
    });
  }
  if (kind === "ai_aborted") {
    return setActivity(state, topicId, {
      ...current,
      running: false,
      status: "Aborted",
    });
  }
  if (kind === "ai_error") {
    return setActivity(state, topicId, {
      ...current,
      running: false,
      status: "Error",
      error: String(status.error ?? "Unknown error"),
    });
  }
  if (kind === "tool_call") {
    const tool: ToolActivity = {
      id: String(status.toolUseId ?? `${status.queryId ?? "query"}:tool`),
      label: String(status.label ?? status.name ?? "tool"),
      status: "running",
    };
    return setActivity(state, topicId, {
      ...current,
      running: true,
      status: tool.label,
      tools: [...current.tools.filter((item) => item.id !== tool.id), tool].slice(-8),
    });
  }
  if (kind === "tool_output") {
    const id = String(status.toolUseId ?? "");
    const tools = current.tools.map((tool) =>
      tool.id === id ? { ...tool, output: String(status.content ?? ""), status: "done" } : tool,
    );
    return setActivity(state, topicId, { ...current, tools });
  }
  if (kind === "tool_status") {
    return setActivity(state, topicId, {
      ...current,
      status: String(status.content ?? current.status ?? "Working…"),
    });
  }
  return state;
}

export function applyRuntimeEvent(state: AppState, event: RuntimeBusEvent): AppState {
  if (event.type === "message") {
    return upsertMessage(state, event.payload as MessageDto);
  }
  if (event.type === "message-updated") {
    const payload = event.payload as {
      messageId?: string;
      patch?: Partial<MessageDto>;
    };
    if (!payload.messageId || !payload.patch) return state;
    return patchMessage(state, event.topicId, payload.messageId, payload.patch);
  }
  if (event.type === "ai-status") return applyAiStatus(state, event.topicId, event.payload);
  if (event.type === "topic-deleted" && state.activeTopicId === event.topicId) {
    return { ...state, activeTopicId: null };
  }
  return state;
}
