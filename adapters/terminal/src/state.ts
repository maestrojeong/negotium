import {
  getGlobalAiName,
  type MessageDto,
  type RuntimeBusEvent,
  type TopicDto,
} from "@negotium/core";

type Overlay = "help" | "topics" | "transcript" | "confirm-delete" | null;

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
  aiName: string;
  topics: TopicDto[];
  activeTopicId: string | null;
  messages: Record<string, MessageDto[]>;
  activity: Record<string, TopicActivity>;
  input: string;
  inputCursor: { row: number; col: number };
  suggestionIndex: number;
  topicPickerIndex: number;
  pendingDeleteTopicId?: string;
  scrollOffset: number;
  askChoiceIndex: number;
  overlay: Overlay;
  notice?: string;
}

export function createInitialState(userId: string): AppState {
  return {
    userId,
    aiName: getGlobalAiName(),
    topics: [],
    activeTopicId: null,
    messages: {},
    activity: {},
    input: "",
    inputCursor: { row: 0, col: 0 },
    suggestionIndex: 0,
    topicPickerIndex: 0,
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
    topicPickerIndex: Math.max(
      0,
      topics.findIndex((topic) => topic.id === nextActive),
    ),
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
    topicPickerIndex: state.topics.findIndex((topic) => topic.id === topicId),
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
  next.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt);
    const rightTime = Date.parse(right.createdAt);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
    return leftTime - rightTime;
  });
  return {
    ...state,
    messages: { ...state.messages, [message.topicId]: next },
    // Keep the user's place while reading history. Explicit navigation and
    // message submission return to the live edge instead.
    scrollOffset: state.scrollOffset,
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

function compactPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "file";
  const normalized = value.trim().replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : normalized;
}

function compactToolLabel(value: string): string {
  const match = value.match(/^([^()]+)\((.*)\)$/);
  return match ? `${match[1]} · ${match[2]}` : value;
}

function toolTimelineText(status: Record<string, unknown>): string {
  const name = String(status.name ?? "tool");
  const shortName = name.split("__").at(-1)?.toLowerCase() ?? name.toLowerCase();
  const input =
    status.input && typeof status.input === "object"
      ? (status.input as Record<string, unknown>)
      : {};
  const path = compactPath(input.file_path ?? input.path ?? input.file_id);
  if (shortName === "edit") {
    const before = typeof input.before === "string" ? input.before : "";
    const after = typeof input.after === "string" ? input.after : "";
    return [`Edit · ${path}`, before ? `- ${before}` : "", after ? `+ ${after}` : ""]
      .filter(Boolean)
      .join("\n");
  }
  if (shortName === "write") {
    const lines = typeof input.lines === "number" ? ` · ${input.lines} lines` : "";
    const preview = typeof input.preview === "string" ? input.preview : "";
    return [`Write · ${path}${lines}`, preview ? `+ ${preview}` : ""].filter(Boolean).join("\n");
  }
  return compactToolLabel(String(status.label ?? status.name ?? "tool"));
}

function toolMessageId(status: Record<string, unknown>, toolUseId: string): string {
  return `terminal-tool:${String(status.queryId ?? "query")}:${toolUseId}`;
}

function applyAiStatus(
  state: AppState,
  topicId: string,
  raw: unknown,
  createdAt?: string,
): AppState {
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
    const withActivity = setActivity(state, topicId, {
      ...current,
      running: true,
      status: tool.label,
      tools: [...current.tools.filter((item) => item.id !== tool.id), tool].slice(-8),
    });
    return upsertMessage(withActivity, {
      id: toolMessageId(status, tool.id),
      topicId,
      authorId: "ai",
      text: toolTimelineText(status),
      kind: "tool",
      queryId: typeof status.queryId === "string" ? status.queryId : undefined,
      createdAt: createdAt ?? new Date().toISOString(),
    });
  }
  if (kind === "tool_output") {
    const id = String(status.toolUseId ?? "");
    const tools = current.tools.map((tool) =>
      tool.id === id ? { ...tool, output: String(status.content ?? ""), status: "done" } : tool,
    );
    const withActivity = setActivity(state, topicId, { ...current, tools });
    return patchMessage(withActivity, topicId, toolMessageId(status, id), {
      editedAt: createdAt ?? new Date().toISOString(),
    });
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
  if (event.type === "ai-status") {
    return applyAiStatus(state, event.topicId, event.payload, event.createdAt);
  }
  if (event.type === "topic-deleted" && state.activeTopicId === event.topicId) {
    return { ...state, activeTopicId: null };
  }
  return state;
}
