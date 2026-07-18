/**
 * Otium REST/WS API 계약 타입 — backend와 클라이언트(web-app 등)가 공유하는
 * 단일 소스. 타입 전용 패키지: 런타임 코드 없음 (모든 import는 `import type`).
 *
 * canonical 기준은 서버(backend) 직렬화 형태다. 클라이언트가 더 느슨한 형태가
 * 필요하면 이 타입을 extend/Omit 해서 로컬로 확장한다 (드리프트를 명시적으로).
 *
 * 주의: AgentKind/EffortLevel/ToolCallSummary*는 backend 내부(@/types,
 * agents/tool-format)에 값(배열 상수)과 함께 정의된 원본이 따로 있다 —
 * 여기 선언은 구조적으로 동일한 계약 사본이며, 값 추가 시 양쪽을 함께 갱신한다.
 */

/** Agent identifier — one of the supported AI provider backends. */
export type AgentKind = "maestro" | "claude" | "codex";
export type TopicKind = "channel" | "agent" | "manager";
/** Adapter access boundary for a user-facing topic. */
export type TopicAccessMode = "private" | "shared";
/** Whether adapters may expose a topic in user-facing discovery surfaces. */
export type TopicVisibility = "visible" | "hidden";
export type ResponsePolicy = "off" | "mention" | "always";
/** @deprecated use ResponsePolicy. */
export type AiMode = ResponsePolicy;

/** Reasoning effort levels (union across all agents; per-agent subsets은 backend 레지스트리가 검증). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Display-only tool call summary values (never raw tool args). */
export type ToolCallSummaryValue =
  | string
  | number
  | boolean
  | Array<{ label: string; description?: string }>;

export type ToolCallSummaryInput = Record<string, ToolCallSummaryValue>;

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  cursor?: string;
  hasMore: boolean;
}

export interface LoginRequest {
  identifier: string;
}
export interface LoginResponse {
  token: string;
  user: UserDto;
  expiresAt: string;
}

export interface UserDto {
  id: string;
  displayName: string;
  email?: string;
  avatarUrl?: string;
  isAI: boolean;
  agentType?: AgentKind;
  createdAt: string;
}

export interface TopicDto {
  id: string;
  title: string;
  kind?: TopicKind;
  description?: string;
  /** AI agent invited to this topic. */
  agent?: AgentKind;
  /** Canonical base model alias used by newer clients. */
  baseModel?: string;
  /** Canonical base effort alias used by newer clients. */
  baseEffort?: EffortLevel;
  /** Canonical response-policy alias used by newer clients. */
  responsePolicy?: ResponsePolicy;
  /** Base/fallback model used when no topic config override exists. */
  defaultModel: string;
  /** Base/fallback effort used when no topic config override exists. */
  defaultEffort: EffortLevel;
  /** Resolved per-topic model after applying the persisted self-config override. */
  effectiveModel?: string;
  /** Resolved per-topic effort after applying the persisted self-config override. */
  effectiveEffort?: EffortLevel;
  /**
   * Response policy stored as `response_policy`.
   * - manager rooms are system-managed and always `always`.
   * - agent rooms are always `always` and have an agent.
   * - channel rooms are `off` or `mention`.
   */
  aiMode?: AiMode;
  /** @deprecated response compatibility alias; use aiMode. */
  aiMention?: boolean;
  participants: ParticipantDto[];
  createdAt: string;
  lastMessageAt: string;
  /** Preview of the most recent message text (subtitle in the topic list). */
  lastMessagePreview?: string;
  /** Current user's unread message count for this topic. */
  unreadCount?: number;
  /** Current user's last read message id for this topic. */
  lastReadMessageId?: string;
  /** ID of the parent topic, set when this topic was spawned or forked. */
  parentTopicId?: string;
  /** True when the topic was created via fork (copies history). */
  isFork?: boolean;
  /** True when this topic was spawned by an agent as a subagent worker room. */
  isSubagent?: boolean;
  /** Hidden topics remain executable/addressable by id but stay out of adapter pickers. */
  visibility?: TopicVisibility;
  /** Private stays on local adapters; shared may be exposed through Otium too. */
  accessMode?: TopicAccessMode;
  /** Stable execution placement. Absent means the hub runs this topic locally. */
  executionNode?: {
    nodeId: string;
    nodeName: string;
  };
  /** True when an AI turn is currently in flight for this topic (snapshot at list time). */
  running?: boolean;
  /** Query id associated with the list-time running snapshot. */
  runningQueryId?: string;
}

/** Read-only internal work shown by operational clients. */
export interface BackgroundSessionDto {
  id: string;
  kind: "memory" | "cron";
  title: string;
  startedAt: string;
  topicId?: string;
  status: string;
  /** False for durable sessions that are currently waiting for their next run. */
  active?: boolean;
  agent?: AgentKind;
  model?: string;
  effort?: EffortLevel;
  /** User/task prompt that started the displayed run. Never includes system instructions. */
  prompt?: string;
  promptTitle?: string;
  steps: string[];
}

export interface ParticipantDto {
  userId: string;
  role: "owner" | "member";
  aiConfig?: {
    enabled: boolean;
    agent: AgentKind;
    model: string;
    effort: EffortLevel;
  };
}

export interface CreateTopicRequest {
  title: string;
  kind?: TopicKind;
  description?: string;
  agent?: AgentKind | null | "none";
  baseModel?: string;
  baseEffort?: EffortLevel;
  responsePolicy?: ResponsePolicy;
  /** @deprecated input aliases accepted during API transition. */
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  aiMode?: AiMode;
  aiMention?: boolean;
}
export interface UpdateTopicRequest {
  /** Backward-compatible rename alias; normalized to title. */
  name?: string;
  title?: string;
  kind?: TopicKind;
  description?: string;
  agent?: AgentKind | null | "none";
  baseModel?: string;
  baseEffort?: EffortLevel;
  responsePolicy?: ResponsePolicy;
  /** @deprecated input aliases accepted during API transition. */
  defaultModel?: string;
  defaultEffort?: EffortLevel;
  aiMode?: AiMode;
  aiMention?: boolean;
}

export interface MessageTokenUsage {
  /** Aggregate input consumed by every model call in the turn. */
  input: number;
  output: number;
  cachedInput?: number;
  /** Latest-request context occupancy, distinct from aggregate turn input. */
  context?: number;
  contextWindow?: number;
}

export interface MessageDto {
  id: string;
  topicId: string;
  parentId?: string;
  authorId: string;
  /** Originating adapter for live cross-channel echo suppression/routing. */
  sourceAdapter?: string;
  /** Stable origin metadata used by idempotent cross-node transcript sync. */
  sourceNode?: string;
  sourceMessageId?: string;
  /** Display name of the author, resolved from the user store at read time. */
  authorName?: string;
  /** Current profile image URL for the author, resolved from the user store at read time. */
  authorAvatarUrl?: string | null;
  text: string;
  attachments?: AttachmentDto[];
  /** Internal hint: an external channel may claim and acknowledge attachment delivery. */
  deliveryAckRequested?: boolean;
  queryId?: string;
  agentType?: AgentKind;
  model?: string;
  usage?: MessageTokenUsage;
  /** Soft-delete tombstone flag. Deleted messages keep rowid stable. */
  deleted?: boolean;
  /** Set when a message's text was edited in place. */
  editedAt?: string;
  /** User ids mentioned in the message text (e.g. "@정연우"), resolved at send time. */
  mentions?: string[];
  /** Root message id when this message is a Slack-style thread reply. */
  threadRootId?: string;
  /** Number of thread replies under this message (only stamped on thread roots). */
  threadReplyCount?: number;
  /** Timestamp of the latest thread reply (only stamped on thread roots). */
  threadLastReplyAt?: string;
  /** Emoji reactions, one entry per (user, emoji). */
  reactions?: ReactionDto[];
  kind?: "message" | "system" | "tool" | "ask_user_question" | "subagent";
  askUserQuestion?: AskUserQuestionDto;
  subagentCard?: SubagentCardDto;
  createdAt: string;
}
export interface AskUserQuestionDto {
  question: string;
  choices: { label: string; description?: string }[];
  selectedLabel?: string;
  expired?: boolean;
}

export type SubagentCardStatus = "spawned" | "running" | "completed" | "failed";

/** Live-updating subagent delegation card, persisted on a parent-room message. */
export interface SubagentCardDto {
  /** Child agent-topic id (navigation target). */
  subagentTopicId: string;
  /** Child topic title, e.g. "research-agent-1". */
  name: string;
  /** The self-contained task brief the child received. */
  task: string;
  /** Runtime process instance that owns completion tracking for this child. */
  runtimeOwnerId?: string;
  status: SubagentCardStatus;
  /** Truncated final response (set when completed). */
  resultSummary?: string;
  /** Failure reason (set when failed). */
  errorMessage?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface ReactionDto {
  emoji: string;
  userId: string;
  /** Display name of the reacting user, resolved at write time. */
  userName: string;
}
export interface AttachmentDto {
  id: string;
  type: "image" | "file" | "audio";
  filename: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  transcription?: string;
}
export interface SendMessageRequest {
  text: string;
  attachments?: string[];
  parentId?: string;
  replyTo?: string;
  /** User ids explicitly mentioned in the message (client-selected). */
  mentions?: string[];
  /** Root message id when posting a Slack-style thread reply. */
  threadRootId?: string;
}

export interface MarkTopicReadRequest {
  lastReadMessageId?: string | null;
}

export interface PushRegisterRequest {
  token: string;
  platform?: string;
  deviceId?: string;
}

export interface PushUnregisterRequest {
  token?: string;
  deviceId?: string;
}

export interface AiQueryRequest {
  text: string;
  parentId?: string;
  agent?: AgentKind;
  model?: string;
  effort?: EffortLevel;
  attachments?: string[];
}
export interface AiQueryResponse {
  queryId: string;
  topicId: string;
  status: "pending";
}

export interface AiQueryStatusResponse {
  queryId: string;
  topicId: string;
  status: "running" | "not_found";
}

export interface AskUserQuestionAnswerResponse {
  askMessage: MessageDto;
  answerMessage: MessageDto;
  queryId?: string;
  status: "pending" | "sent";
}

export interface FileUploadResponse {
  fileId: string;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AgentInfoDto {
  kind: AgentKind;
  displayName: string;
  models: string[];
  defaultModel: string;
  effortLevels: EffortLevel[];
}

export type WsClientMessage =
  | { type: "subscribe"; topicId: string }
  | { type: "unsubscribe"; topicId: string }
  | { type: "subscribe_presence"; topicId: string }
  | { type: "unsubscribe_presence"; topicId: string }
  | { type: "typing"; topicId: string; isTyping: boolean };

export type WsServerMessage =
  | {
      type: "ai_done";
      queryId: string;
      topicId: string;
      usage?: MessageTokenUsage;
      // Provider metadata for the completed turn. The answer text itself is
      // delivered by the persisted `message` event.
      agent?: AgentKind;
      model?: string;
    }
  | {
      // A live AI turn exists on this room. Broadcast at turn start and sent
      // as a snapshot to late subscribers, so clients can bind typing/tool UI
      // to turns they did not initiate (subagent task turns, session injects).
      type: "ai_active";
      queryId: string;
      topicId: string;
    }
  | { type: "ai_error"; queryId: string; topicId: string; error: string }
  | {
      type: "ai_aborted";
      queryId: string;
      topicId: string;
      // Why the turn ended: "superseded" = a new user message on the same room
      // interrupted and replaced it (Otium AbortReason.Internal); "stopped" =
      // explicit cancel / abort_session / DELETE (Otium AbortReason.External).
      // Absent on legacy emitters → clients treat as "stopped".
      reason?: "superseded" | "stopped";
    }
  | {
      type: "tool_call";
      queryId: string;
      topicId: string;
      name: string;
      /** Small display-only summary; never raw tool args such as full HTML/content. */
      input?: ToolCallSummaryInput;
      /** Human-readable label (formatToolUse), e.g. "Bash(npm test)". Single source of truth. */
      label: string;
      toolUseId: string; // non-empty id for client-side tool_call↔tool_output matching
    }
  | {
      type: "tool_output";
      queryId: string;
      topicId: string;
      toolUseId: string;
      content: string;
    }
  | {
      type: "tool_status";
      queryId: string;
      topicId: string;
      kind: "status" | "progress" | "summary";
      content: string;
      toolName?: string;
      elapsed?: number;
    }
  | {
      type: "file_ready";
      queryId: string;
      topicId: string;
      path: string;
      source: string;
    }
  | {
      type: "visual";
      queryId: string;
      topicId: string;
      url: string;
      id?: number;
      title?: string | null;
      kind?: "html" | "mermaid" | "image" | "video";
    }
  | { type: "message"; topicId: string; message: MessageDto }
  | {
      type: "message_updated";
      topicId: string;
      messageId: string;
      text?: string;
      deleted?: boolean;
      editedAt?: string;
      usage?: MessageTokenUsage;
      askUserQuestion?: AskUserQuestionDto;
      subagentCard?: SubagentCardDto;
    }
  | {
      type: "reaction_update";
      topicId: string;
      messageId: string;
      reactions: ReactionDto[];
    }
  | { type: "typing"; topicId: string; userId: string }
  | {
      type: "unread_update";
      topicId: string;
      userId: string;
      unreadCount: number;
    }
  | {
      type: "user_typing";
      topicId: string;
      userId: string;
      userName: string;
      isTyping: boolean;
    }
  | {
      // User-level foreground notification (web tier-1). Delivered on the user
      // socket so an open web/desktop client can surface an OS notification.
      type: "notification";
      topicId: string;
      userId: string;
      title: string;
      body: string;
      messageId: string;
    }
  | {
      // Emitted when a thread's reply count changes so the parent message's
      // "N replies" chip updates live in the channel list.
      type: "thread_update";
      topicId: string;
      rootMessageId: string;
      replyCount: number;
      lastReplyAt: string;
    }
  | { type: "topic_created"; topicId: string; topic: TopicDto }
  | { type: "topic_updated"; topicId: string; patch: Partial<TopicDto> }
  // Sent to a user's socket when a room stops existing *for them* — hard
  // delete, or their own membership was revoked.
  | { type: "topic_deleted"; topicId: string };

/** Request to spawn (config-only copy) or fork (config+history copy) a topic. */
export interface SpawnForkRequest {
  name?: string;
}

/** Spawn/fork result — the newly created topic. */
export interface SpawnForkResponse {
  topic: TopicDto;
}

/** Export format options. */
export type ExportFormat = "text" | "json" | "markdown";

/** Exported conversation data. */
export interface ExportResponse {
  topicId: string;
  topicTitle: string;
  format: ExportFormat;
  content: string;
}
