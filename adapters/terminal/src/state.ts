import {
  getGlobalAiName,
  type MessageDto,
  type RuntimeBusEvent,
  type TopicDto,
} from "@negotium/core";
import { terminalNowMs } from "@/clock";

type Overlay = "help" | "status" | "topics" | "transcript" | "confirm-delete" | null;

interface ToolActivity {
  id: string;
  label: string;
  output?: string;
  status?: string;
}

interface TopicActivity {
  running: boolean;
  queryId?: string;
  startedAtMs?: number;
  status?: string;
  error?: string;
  tools: ToolActivity[];
}

export interface MessageHistoryStatus {
  hasMore: boolean;
  loading: boolean;
}

export interface AppState {
  userId: string;
  aiName: string;
  topics: TopicDto[];
  activeTopicId: string | null;
  messages: Record<string, MessageDto[]>;
  messageHistory: Record<string, MessageHistoryStatus>;
  activity: Record<string, TopicActivity>;
  input: string;
  inputCursor: { row: number; col: number };
  suggestionIndex: number;
  topicPickerIndex: number;
  pendingDeleteTopicId?: string;
  creatingTopic: boolean;
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
    messageHistory: {},
    activity: {},
    input: "",
    inputCursor: { row: 0, col: 0 },
    suggestionIndex: 0,
    topicPickerIndex: 0,
    creatingTopic: false,
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

function orderTopicsByParent(topics: TopicDto[]): TopicDto[] {
  const topicIds = new Set(topics.map((topic) => topic.id));
  const childrenByParent = new Map<string, TopicDto[]>();
  const attachedChildIds = new Set<string>();

  for (const topic of topics) {
    if (
      !topic.isSubagent ||
      !topic.parentTopicId ||
      topic.parentTopicId === topic.id ||
      !topicIds.has(topic.parentTopicId)
    ) {
      continue;
    }
    const children = childrenByParent.get(topic.parentTopicId) ?? [];
    children.push(topic);
    childrenByParent.set(topic.parentTopicId, children);
    attachedChildIds.add(topic.id);
  }

  const ordered: TopicDto[] = [];
  const visited = new Set<string>();
  const appendTopic = (topic: TopicDto): void => {
    if (visited.has(topic.id)) return;
    visited.add(topic.id);
    ordered.push(topic);
    for (const child of childrenByParent.get(topic.id) ?? []) appendTopic(child);
  };

  for (const topic of topics) {
    if (!attachedChildIds.has(topic.id)) appendTopic(topic);
  }
  // Keep malformed/cyclic relationships discoverable instead of dropping them.
  for (const topic of topics) appendTopic(topic);
  return ordered;
}

export function setTopics(state: AppState, topics: TopicDto[], preferredTitle?: string): AppState {
  const orderedTopics = orderTopicsByParent(topics);
  const stillVisible = orderedTopics.some((topic) => topic.id === state.activeTopicId);
  const preferred = preferredTitle
    ? orderedTopics.find((topic) => topic.title.toLowerCase() === preferredTitle.toLowerCase())
    : undefined;
  const nextActive =
    preferred?.id ?? (stillVisible ? state.activeTopicId : orderedTopics[0]?.id) ?? null;
  return {
    ...state,
    topics: orderedTopics,
    activeTopicId: nextActive,
    scrollOffset: nextActive === state.activeTopicId ? state.scrollOffset : 0,
    askChoiceIndex: nextActive === state.activeTopicId ? state.askChoiceIndex : 0,
    topicPickerIndex: Math.max(
      0,
      orderedTopics.findIndex((topic) => topic.id === nextActive),
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
    creatingTopic: false,
    topicPickerIndex: state.topics.findIndex((topic) => topic.id === topicId),
    notice: undefined,
  };
}

/** Select a newly-created topic before asynchronous list refreshes can race it. */
export function focusCreatedTopic(state: AppState, topic: TopicDto): AppState {
  const topics = state.topics.some((candidate) => candidate.id === topic.id)
    ? state.topics.map((candidate) => (candidate.id === topic.id ? topic : candidate))
    : [...state.topics, topic];
  return selectTopic(setTopics(state, topics), topic.id);
}

export function openTopicPicker(state: AppState, notice = state.notice): AppState {
  return {
    ...state,
    overlay: "topics",
    creatingTopic: false,
    topicPickerIndex: Math.max(
      0,
      state.topics.findIndex((topic) => topic.id === state.activeTopicId),
    ),
    notice,
  };
}

export function startTopicCreation(state: AppState): AppState {
  return {
    ...state,
    overlay: null,
    creatingTopic: true,
    notice: "Type a new topic name, then press Enter",
  };
}

export function setMessages(state: AppState, topicId: string, messages: MessageDto[]): AppState {
  return { ...state, messages: { ...state.messages, [topicId]: messages } };
}

export function setMessageHistoryStatus(
  state: AppState,
  topicId: string,
  status: MessageHistoryStatus,
): AppState {
  return {
    ...state,
    messageHistory: { ...state.messageHistory, [topicId]: status },
  };
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

function removeMessage(state: AppState, topicId: string, messageId: string): AppState {
  const current = state.messages[topicId] ?? [];
  const next = current.filter((message) => message.id !== messageId);
  if (next.length === current.length) return state;
  return { ...state, messages: { ...state.messages, [topicId]: next } };
}

function activityFor(state: AppState, topicId: string): TopicActivity {
  return state.activity[topicId] ?? { running: false, tools: [] };
}

function setActivity(state: AppState, topicId: string, activity: TopicActivity): AppState {
  return { ...state, activity: { ...state.activity, [topicId]: activity } };
}

function activityStartMs(createdAt?: string): number {
  const parsed = createdAt ? Date.parse(createdAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : terminalNowMs();
}

function isStaleTerminalStatus(current: TopicActivity, status: Record<string, unknown>): boolean {
  const queryId = typeof status.queryId === "string" ? status.queryId.trim() : "";
  return Boolean(queryId && current.queryId && queryId !== current.queryId);
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
    const queryId = String(status.queryId ?? "");
    return setActivity(state, topicId, {
      running: true,
      queryId,
      startedAtMs:
        current.running && current.queryId === queryId && current.startedAtMs !== undefined
          ? current.startedAtMs
          : activityStartMs(createdAt),
      status: "Thinking…",
      tools: [],
    });
  }
  if (kind === "ai_done") {
    // A superseded provider can finish unwinding after its replacement has
    // already broadcast ai_active. Its late terminal event must not stop the
    // replacement's spinner or overwrite its status.
    if (isStaleTerminalStatus(current, status)) return state;
    return setActivity(state, topicId, {
      ...current,
      running: false,
      status: "Done",
    });
  }
  if (kind === "ai_aborted") {
    if (isStaleTerminalStatus(current, status)) return state;
    return setActivity(state, topicId, {
      ...current,
      running: false,
      status: "Aborted",
    });
  }
  if (kind === "ai_error") {
    if (isStaleTerminalStatus(current, status)) return state;
    return setActivity(state, topicId, {
      ...current,
      running: false,
      status: "Error",
      error: String(status.error ?? "Unknown error"),
    });
  }
  if (kind === "tool_call") {
    if (isStaleTerminalStatus(current, status)) return state;
    const queryId = String(status.queryId ?? "");
    const tool: ToolActivity = {
      id: String(status.toolUseId ?? `${queryId || "query"}:tool`),
      label: String(status.label ?? status.name ?? "tool"),
      status: "running",
    };
    const withActivity = setActivity(state, topicId, {
      ...current,
      running: true,
      queryId: queryId || current.queryId,
      startedAtMs:
        current.queryId === queryId && current.startedAtMs !== undefined
          ? current.startedAtMs
          : activityStartMs(createdAt),
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
    if (isStaleTerminalStatus(current, status)) return state;
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
    if (isStaleTerminalStatus(current, status)) return state;
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
    if (payload.patch.deleted) return removeMessage(state, event.topicId, payload.messageId);
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
