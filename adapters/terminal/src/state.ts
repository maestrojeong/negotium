import {
  type BackgroundSessionDto,
  getGlobalAiName,
  type MessageDto,
  type RuntimeBusEvent,
  type TopicDto,
  type VaultEntry,
} from "@negotium/core";
import type { TopicUsageSummary } from "@negotium/core/storage";
import type { TerminalCanvas, TerminalEdge } from "orchgraph";
import { terminalNowMs } from "@/clock";
import { DEFAULT_DECISION_GRAPH_SPACING, type DecisionGraphCanvas } from "@/decision-graph";
import { DEFAULT_SUBAGENT_GRAPH_SPACING } from "@/subagent-graph";

/**
 * Bounds for the Topics/Tasks side column's width — herdr lets the sidebar be
 * dragged wider/narrower the same way, rather than fixing it at one size.
 */
export const SIDE_PANEL_WIDTH_DEFAULT = 36;
export const SIDE_PANEL_WIDTH_MIN = 22;
export const SIDE_PANEL_WIDTH_MAX = 64;
/** Narrowest the right-hand shell pane may be dragged to. */
export const TERMINAL_PANE_WIDTH_MIN = 30;

type Overlay =
  | "help"
  | "status"
  | "context"
  | "topics"
  | "subagents"
  | "decisions"
  | "background-session"
  | "models"
  | "effort"
  | "vault"
  | "confirm-delete"
  | null;

export type SubagentGraphEdgeKind = "owns" | "owns-parent-only" | "tell" | "tell-bidirectional";

export interface SubagentGraphCanvas extends Omit<TerminalCanvas, "title" | "edges"> {
  title: string;
  rootDetail?: string;
  rootRunning?: boolean;
  edges: Array<TerminalEdge & { kind?: SubagentGraphEdgeKind }>;
}

/**
 * Terminal-local message shape: tool timeline messages carry an explicit
 * success/failure outcome so the renderer never has to parse text to tell a
 * failed file change from an applied one. Absent on server messages and on
 * providers that do not flag failures (e.g. Claude), where `editedAt` alone
 * keeps meaning "tool finished".
 */
export type TerminalMessage = MessageDto & { toolResult?: "ok" | "error" };

interface ToolActivity {
  id: string;
  label: string;
  output?: string;
  status?: string;
  sessionAction?: "ask" | "tell";
  sessionTarget?: string;
}

export interface TopicActivity {
  running: boolean;
  queryId?: string;
  snapshot?: true;
  startedAtMs?: number;
  status?: string;
  error?: string;
  tools: ToolActivity[];
  contextProgress?: {
    assistantTokens: number;
    toolTokens: number;
  };
}

export type VaultMode = "list" | "key" | "value" | "description" | "confirm-delete";

/** Sub-mode while the composer is capturing a value for an agent-initiated `request_vault_secret` card. */
export type VaultRequestMode = "value" | "confirm-decline";

/** Severity of a footer notice. See `AppState.noticeLevel`. */
export type NoticeLevel = "info" | "success" | "warn" | "error";

export interface MessageHistoryStatus {
  hasMore: boolean;
  loading: boolean;
}

export interface AppState {
  userId: string;
  aiName: string;
  topics: TopicDto[];
  backgroundSessions: BackgroundSessionDto[];
  activeTopicId: string | null;
  messages: Record<string, TerminalMessage[]>;
  topicUsage: Record<string, TopicUsageSummary>;
  messageHistory: Record<string, MessageHistoryStatus>;
  activity: Record<string, TopicActivity>;
  /**
   * Topics whose agent finished a reply (or errored) while another topic was
   * on screen. Client-local only: never persisted and never sent to the node.
   * Cleared as soon as the topic becomes the active one.
   */
  unread: Record<string, true>;
  input: string;
  inputCursor: { row: number; col: number };
  suggestionIndex: number;
  topicPickerIndex: number;
  topicPickerBackgroundId?: string;
  /**
   * Type-to-filter query for the topic picker overlay.
   *
   * Kept separate from `topics` so the full list stays authoritative for
   * `activeTopic`/`selectTopic`/`applyRuntimeEvent`; only the picker's visible
   * entries and its keyboard navigation consult this. Reset whenever the
   * overlay opens or a topic is selected.
   */
  topicFilter: string;
  modelPickerIndex: number;
  effortPickerIndex: number;
  pendingDeleteTopicId?: string;
  /** Topic awaiting y/n confirmation for a private → public switch. */
  creatingTopic: boolean;
  scrollOffset: number;
  backgroundScrollOffset: number;
  subagentGraph?: SubagentGraphCanvas;
  subagentGraphLoading: boolean;
  subagentGraphOffset: { x: number; y: number };
  subagentGraphSpacing: number;
  decisionGraph?: DecisionGraphCanvas;
  decisionGraphLoading: boolean;
  decisionGraphOffset: { x: number; y: number };
  decisionGraphSpacing: number;
  askChoiceIndex: number;
  taskPanelScrollOffset: number;
  /** One toggle (Ctrl-P) for the whole side column — Topics and Tasks are sections within it, not independently hidden. */
  topicsPanelEnabled: boolean;
  topicsPanelScrollOffset: number;
  /** Width of the side column, dragged via its right border. Clamped to `SIDE_PANEL_WIDTH_MIN`/`MAX`. */
  sidePanelWidth: number;
  /** Whether the right-hand shell pane (Ctrl-T) is shown. */
  terminalPaneOpen: boolean;
  /** Whether keystrokes go to that shell instead of the composer. */
  terminalPaneFocused: boolean;
  /** Width dragged via the pane's left border; null sizes it from the terminal width. */
  terminalPaneWidth: number | null;
  /** Ctrl-R cycles this — herdr's sidebar has the same "grouped vs priority" sort toggle. */
  topicsPanelSort: "activity" | "name";
  /**
   * Hover highlight for the always-visible Topics panel — separate from
   * `topicPickerIndex`/`topicPickerBackgroundId`, which belong only to the
   * `Ctrl-O` overlay's own keyboard cursor. Moving the mouse over the panel
   * while chatting must never disturb where the overlay will reopen.
   */
  sidePanelHoverTopicId?: string;
  /** Same as {@link sidePanelHoverTopicId}, for the panel's background-session rows. */
  sidePanelHoverBackgroundSessionId?: string;
  overlay: Overlay;
  topicPickerRoot: boolean;
  notice?: string;
  /**
   * Severity for `notice`, driving both the footer glyph and its colour.
   *
   * Kept as a sibling field rather than folding `notice` into an object so the
   * dozens of existing `{ ...state, notice }` updates stay valid. Every site
   * that writes `notice` writes `noticeLevel` alongside it (including the
   * `undefined` clears), so a level can never outlive the text it describes.
   * An unset level renders as `warn`, which is the pre-severity behaviour.
   */
  noticeLevel?: NoticeLevel;
  vaultEntries: VaultEntry[];
  vaultPickerIndex: number;
  vaultMode: VaultMode;
  vaultDraftKey?: string;
  vaultDraftDescription: string;
  vaultEditing: boolean;
  vaultNotice?: string;
  /** Mode while answering an agent-initiated `request_vault_secret` card (not the manual `/vault` form above). */
  vaultRequestMode: VaultRequestMode;
  /** Blocks a double-Enter while the answer round trip to the node is in flight. */
  vaultRequestSubmitting: boolean;
  /** Inline error/info shown next to the capture pane, distinct from `vaultNotice` (the manual form's). */
  vaultRequestNotice?: string;
}

export function createInitialState(userId: string): AppState {
  return {
    userId,
    aiName: getGlobalAiName(),
    topics: [],
    backgroundSessions: [],
    activeTopicId: null,
    messages: {},
    topicUsage: {},
    messageHistory: {},
    activity: {},
    unread: {},
    input: "",
    inputCursor: { row: 0, col: 0 },
    suggestionIndex: 0,
    topicPickerIndex: 0,
    topicFilter: "",
    modelPickerIndex: 0,
    effortPickerIndex: 0,
    creatingTopic: false,
    scrollOffset: 0,
    backgroundScrollOffset: 0,
    subagentGraphLoading: false,
    subagentGraphOffset: { x: 0, y: 0 },
    subagentGraphSpacing: DEFAULT_SUBAGENT_GRAPH_SPACING,
    decisionGraphLoading: false,
    decisionGraphOffset: { x: 0, y: 0 },
    decisionGraphSpacing: DEFAULT_DECISION_GRAPH_SPACING,
    askChoiceIndex: 0,
    taskPanelScrollOffset: 0,
    topicsPanelEnabled: true,
    topicsPanelScrollOffset: 0,
    sidePanelWidth: SIDE_PANEL_WIDTH_DEFAULT,
    terminalPaneOpen: false,
    terminalPaneFocused: false,
    terminalPaneWidth: null,
    topicsPanelSort: "activity",
    overlay: null,
    topicPickerRoot: false,
    vaultEntries: [],
    vaultPickerIndex: 0,
    vaultMode: "list",
    vaultDraftDescription: "",
    vaultEditing: false,
    vaultRequestMode: "value",
    vaultRequestSubmitting: false,
  };
}

export function toggleTopicsPanel(state: AppState): AppState {
  return { ...state, topicsPanelEnabled: !state.topicsPanelEnabled };
}

export function cycleTopicsPanelSort(state: AppState): AppState {
  return { ...state, topicsPanelSort: state.topicsPanelSort === "activity" ? "name" : "activity" };
}

export function openTerminalPane(state: AppState): AppState {
  return { ...state, terminalPaneOpen: true, terminalPaneFocused: true };
}

export function closeTerminalPane(state: AppState): AppState {
  return { ...state, terminalPaneOpen: false, terminalPaneFocused: false };
}

export function focusTerminalPane(state: AppState, focused: boolean): AppState {
  const next = focused && state.terminalPaneOpen;
  return next === state.terminalPaneFocused ? state : { ...state, terminalPaneFocused: next };
}

/** Clamps against the pane's own minimum and whatever room `maxWidth` leaves the conversation. */
export function setTerminalPaneWidth(state: AppState, width: number, maxWidth: number): AppState {
  const next = Math.max(TERMINAL_PANE_WIDTH_MIN, Math.min(Math.round(width), maxWidth));
  return next === state.terminalPaneWidth ? state : { ...state, terminalPaneWidth: next };
}

/** Clamps against both the panel's own min/max and whatever room `maxWidth` leaves for the conversation. */
export function setSidePanelWidth(state: AppState, width: number, maxWidth: number): AppState {
  const next = Math.min(
    SIDE_PANEL_WIDTH_MAX,
    Math.max(SIDE_PANEL_WIDTH_MIN, Math.min(Math.round(width), maxWidth)),
  );
  return next === state.sidePanelWidth ? state : { ...state, sidePanelWidth: next };
}

/** Clamps against `maxOffset`, computed by the renderer from current content. */
export function scrollTopicsPanel(state: AppState, delta: number, maxOffset: number): AppState {
  const next = Math.min(maxOffset, Math.max(0, state.topicsPanelScrollOffset + delta));
  return next === state.topicsPanelScrollOffset
    ? state
    : { ...state, topicsPanelScrollOffset: next };
}

export function scrollTaskPanel(state: AppState, delta: number, maxOffset: number): AppState {
  const next = Math.min(maxOffset, Math.max(0, state.taskPanelScrollOffset + delta));
  return next === state.taskPanelScrollOffset ? state : { ...state, taskPanelScrollOffset: next };
}

export function setTopicsPanelScrollOffset(
  state: AppState,
  offset: number,
  maxOffset: number,
): AppState {
  const next = Math.min(maxOffset, Math.max(0, offset));
  return next === state.topicsPanelScrollOffset
    ? state
    : { ...state, topicsPanelScrollOffset: next };
}

export function setTaskPanelScrollOffset(
  state: AppState,
  offset: number,
  maxOffset: number,
): AppState {
  const next = Math.min(maxOffset, Math.max(0, offset));
  return next === state.taskPanelScrollOffset ? state : { ...state, taskPanelScrollOffset: next };
}

export function activeTopic(state: AppState): TopicDto | null {
  return state.topics.find((topic) => topic.id === state.activeTopicId) ?? null;
}

export function activeMessages(state: AppState): TerminalMessage[] {
  return state.activeTopicId ? (state.messages[state.activeTopicId] ?? []) : [];
}

export function setTopicUsage(state: AppState, usage: TopicUsageSummary): AppState {
  return {
    ...state,
    topicUsage: { ...state.topicUsage, [usage.topicId]: usage },
  };
}

/**
 * Rows on a decision card: the AI's choices, then "type your own answer" and
 * "skip". The two extra rows are the Terminal's, not the AI's.
 */
export function askRowCount(choiceCount: number): number {
  return choiceCount + 2;
}

export function activeQuestion(state: AppState): TerminalMessage | null {
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

/**
 * The question text if `topicId` is blocked on an unanswered
 * `ask_user_question`, for any topic — not just the active one, unlike
 * {@link activeQuestion}. This is what lets the Topics panel mark a topic as
 * "waiting on you" instead of just idle, herdr's "never hunt for the stuck
 * one" (`ai_active`/`ai_idle` already reach every topic's `activity` the same
 * way; this reads the matching unanswered question out of `state.messages`).
 *
 * A topic visited once and then switched away from can lag behind a new
 * question until it is reopened — its runtime events queue behind the
 * in-flight history load the same way any other message-ordering-sensitive
 * event does — but a topic never opened at all, or the currently active one,
 * always reflects the question the moment it arrives.
 */
export function blockedQuestionText(state: AppState, topicId: string): string | undefined {
  const messages = state.messages[topicId] ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.kind === "ask_user_question" &&
      message.askUserQuestion &&
      !message.askUserQuestion.expired &&
      !message.askUserQuestion.selectedLabel
    ) {
      return message.askUserQuestion.question;
    }
  }
  return undefined;
}

/**
 * Oldest pending request first (FIFO), unlike `activeQuestion`'s newest-first:
 * a secret request that loses a race to a newer one should not starve behind
 * it, since answering it hands a value to the vault rather than picking
 * between options that may go stale.
 */
export function activeVaultRequest(state: AppState): TerminalMessage | null {
  return (
    activeMessages(state).find(
      (message) =>
        message.kind === "vault_secret_request" && message.vaultSecretRequest?.status === "pending",
    ) ?? null
  );
}

/** True while the composer buffer holds a secret rather than ordinary chat text. */
export function composerHoldsSecret(state: AppState): boolean {
  if (state.overlay === "vault" && state.vaultMode === "value") return true;
  return state.overlay === null && activeVaultRequest(state) !== null;
}

export function activeTaskPanel(state: AppState): TerminalMessage | null {
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

  const roots = topics.filter((topic) => !attachedChildIds.has(topic.id));
  const orderedRoots = [
    ...roots.filter((topic) => topic.title.toLowerCase() === "general"),
    ...roots.filter((topic) => topic.title.toLowerCase() !== "general"),
  ];
  for (const topic of orderedRoots) {
    if (!attachedChildIds.has(topic.id)) appendTopic(topic);
  }
  // Keep malformed/cyclic relationships discoverable instead of dropping them.
  for (const topic of topics) appendTopic(topic);
  return ordered;
}

export function setBackgroundSessions(
  state: AppState,
  backgroundSessions: BackgroundSessionDto[],
): AppState {
  const orderedSessions = [
    ...backgroundSessions.filter((session) => session.kind === "cron"),
    ...backgroundSessions.filter((session) => session.kind === "memory"),
    ...backgroundSessions.filter((session) => session.kind === "compact"),
  ];
  const selectedStillExists = orderedSessions.some(
    (session) => session.id === state.topicPickerBackgroundId,
  );
  return clampTopicPickerSelection({
    ...state,
    backgroundSessions: orderedSessions,
    topicPickerBackgroundId: selectedStillExists ? state.topicPickerBackgroundId : undefined,
    overlay:
      state.overlay === "background-session" && !selectedStillExists ? "topics" : state.overlay,
  });
}

export function pickedBackgroundSession(state: AppState): BackgroundSessionDto | undefined {
  return state.backgroundSessions.find((session) => session.id === state.topicPickerBackgroundId);
}

/**
 * The topic the picker highlight is actually on.
 *
 * Gated on {@link visibleTopicPickerIds}: a stale index left over from a list
 * refresh, or a filter that matches nothing, must not resolve to a row the user
 * cannot see. Enter and Ctrl-D both go through here, so an invisible selection
 * became "open/delete a topic you never chose". Outside the picker the filter is
 * empty and every topic is visible, so this is a no-op there.
 */
export function pickedTopic(state: AppState): TopicDto | undefined {
  if (state.topicPickerBackgroundId) return undefined;
  const topic = state.topics[state.topicPickerIndex];
  if (!topic) return undefined;
  return visibleTopicPickerIds(state).has(topic.id) ? topic : undefined;
}

/** Index meaning "nothing is selected" — the filter matched no row. */
export const NO_TOPIC_PICKER_SELECTION = -1;

/**
 * Case-insensitive substring match on the title.
 *
 * `toLowerCase()` is Unicode-aware in JS, so Latin case folding works while
 * Hangul (which has no case) simply compares as-is — a plain `includes` already
 * matches "회의" inside "주간 회의록". Initial-consonant (초성) search is out of
 * scope: it needs syllable decomposition and would make the rule non-obvious.
 */
export function topicPickerQueryMatches(title: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length === 0 || title.toLowerCase().includes(needle);
}

/**
 * Topic ids the picker shows under the active filter.
 *
 * Ancestors of a matching subagent are pulled in even when they do not match
 * themselves: `subagentTreePrefix` draws `├─`/`└─` from the lineage, so showing
 * an orphaned child would render a prefix with nothing above it, and the user
 * would lose the context of which room spawned the hit. Parents are context,
 * not results — they are still selectable, which matches how file-tree filters
 * in editors behave.
 */
export function visibleTopicPickerIds(state: AppState): Set<string> {
  const visible = new Set<string>();
  const query = state.topicFilter.trim();
  if (query.length === 0) {
    for (const topic of state.topics) visible.add(topic.id);
    return visible;
  }
  const byId = new Map(state.topics.map((topic) => [topic.id, topic]));
  for (const topic of state.topics) {
    if (!topicPickerQueryMatches(topic.title, query)) continue;
    visible.add(topic.id);
    let current = topic;
    while (current.isSubagent && current.parentTopicId) {
      const parent = byId.get(current.parentTopicId);
      if (!parent || visible.has(parent.id)) break;
      visible.add(parent.id);
      current = parent;
    }
  }
  return visible;
}

/** Background sessions surviving the active filter, matched on their title. */
export function visibleBackgroundSessions(state: AppState): BackgroundSessionDto[] {
  return state.backgroundSessions.filter((session) =>
    topicPickerQueryMatches(session.title, state.topicFilter),
  );
}

interface TopicPickerItem {
  kind: "topic" | "background";
  id: string;
  index?: number;
}

/** Blocked, then running, then idle — lower sorts first under "activity". */
export function topicRank(state: AppState, topic: TopicDto): number {
  if (blockedQuestionText(state, topic.id) !== undefined) return 0;
  if (state.activity[topic.id]?.running) return 1;
  return 2;
}

/**
 * Splits entries — already in `state.topics`' parent-before-every-descendant
 * order (`orderTopicsByParent`, applied in `setTopics`) — into contiguous
 * root+subagent units. A unit is one non-subagent root followed by every
 * subagent that already sits right after it. Sorting whole units, rather
 * than individual topics, means a family with several subagents never gets
 * scattered across the list, and the tree's connector lines never get
 * scrambled by moving one member without the others.
 */
export function groupTopicsIntoUnits<T extends { topic: TopicDto }>(entries: T[]): T[][] {
  const units: T[][] = [];
  for (const entry of entries) {
    const last = units.at(-1);
    if (entry.topic.isSubagent && last) last.push(entry);
    else units.push([entry]);
  }
  return units;
}

/**
 * The one ordering both the always-visible Topics panel and the `Ctrl-O`
 * picker's rendering and arrow-key navigation (`topicPickerItems` below)
 * read from, so they can never disagree about what's where. `state.
 * topicsPanelSort` ("activity" / "name", `Ctrl-R`) decides whole-unit order;
 * a unit's own internal (parent-then-children) order never changes.
 */
export function sortedTopicEntries<T extends { topic: TopicDto }>(
  state: AppState,
  entries: T[],
): T[] {
  const units = groupTopicsIntoUnits(entries);
  if (state.topicsPanelSort === "name") {
    return units
      .slice()
      .sort((a, b) => (a[0]?.topic.title ?? "").localeCompare(b[0]?.topic.title ?? ""))
      .flat();
  }
  return units
    .map((unit, order) => ({
      unit,
      order,
      rank: Math.min(...unit.map(({ topic }) => topicRank(state, topic))),
    }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .flatMap(({ unit }) => unit);
}

/** Selectable rows in picker order — the single source shared by nav and render. */
function topicPickerItems(state: AppState): TopicPickerItem[] {
  const visible = visibleTopicPickerIds(state);
  const indexedTopics = state.topics
    .map((topic, index) => ({ topic, index }))
    .filter(({ topic }) => visible.has(topic.id));
  return [
    ...managerFirstTopicEntries(state, indexedTopics).map(({ topic, index }) => ({
      kind: "topic" as const,
      id: topic.id,
      index,
    })),
    ...visibleBackgroundSessions(state).map((session) => ({
      kind: "background" as const,
      id: session.id,
    })),
  ];
}

/**
 * Pull the highlight back onto a row the filter still shows.
 *
 * Without this, narrowing the list would leave `topicPickerIndex` pointing at a
 * hidden topic, so Enter would open something the user cannot see. When nothing
 * matches, the selection is cleared outright ({@link NO_TOPIC_PICKER_SELECTION})
 * rather than left dangling — Enter and Ctrl-D then do nothing, which is the
 * only honest answer for an empty list.
 *
 * Every path that can change the row set must funnel through here: the filter
 * edits, `setTopics`, `setBackgroundSessions`, and opening the overlay. An
 * asynchronous refresh that drops the selected topic is otherwise indistinguishable
 * from a stale index.
 */
export function clampTopicPickerSelection(state: AppState): AppState {
  const items = topicPickerItems(state);
  if (items.length === 0) {
    // Leaving the old index in place would keep a hidden topic selectable.
    if (state.topicPickerIndex === NO_TOPIC_PICKER_SELECTION && !state.topicPickerBackgroundId) {
      return state;
    }
    return {
      ...state,
      topicPickerIndex: NO_TOPIC_PICKER_SELECTION,
      topicPickerBackgroundId: undefined,
    };
  }
  const currentId = state.topicPickerBackgroundId ?? state.topics[state.topicPickerIndex]?.id;
  if (items.some((item) => item.id === currentId)) return state;
  const first = items[0];
  return first.kind === "topic"
    ? { ...state, topicPickerIndex: first.index ?? 0, topicPickerBackgroundId: undefined }
    : { ...state, topicPickerBackgroundId: first.id };
}

/**
 * Matching and rendering both `trim()` the query, so a whitespace-only filter is
 * invisible and matches everything. Storing it raw made Escape disagree with the
 * screen — it saw a non-empty string, cleared "the filter", and only the *second*
 * press closed the overlay. Normalising here keeps one predicate: filter active
 * iff `topicFilter.length > 0`.
 */
export function setTopicFilter(state: AppState, topicFilter: string): AppState {
  const normalized = topicFilter.trim().length === 0 ? "" : topicFilter;
  return clampTopicPickerSelection({ ...state, topicFilter: normalized });
}

export function appendTopicFilter(state: AppState, text: string): AppState {
  return setTopicFilter(state, state.topicFilter + text);
}

/** Drop one *code point*, so a Hangul syllable does not leave a lone surrogate. */
export function backspaceTopicFilter(state: AppState): AppState {
  const chars = [...state.topicFilter];
  return setTopicFilter(state, chars.slice(0, -1).join(""));
}

export function moveTopicPickerSelection(state: AppState, delta: number): AppState {
  const items = topicPickerItems(state);
  if (items.length === 0) return state;
  const currentId = state.topicPickerBackgroundId ?? state.topics[state.topicPickerIndex]?.id;
  const current = items.findIndex((item) => item.id === currentId);
  const next =
    current < 0
      ? // Nothing was selected (empty filter result that just gained rows):
        // step onto the edge the user is moving towards, not past it.
        items[delta >= 0 ? 0 : items.length - 1]
      : items[(current + delta + items.length) % items.length];
  return next.kind === "topic"
    ? { ...state, topicPickerIndex: next.index ?? 0, topicPickerBackgroundId: undefined }
    : { ...state, topicPickerBackgroundId: next.id };
}

export function setTopics(state: AppState, topics: TopicDto[], preferredTitle?: string): AppState {
  const orderedTopics = orderTopicsByParent(topics);
  const stillVisible = orderedTopics.some((topic) => topic.id === state.activeTopicId);
  // Seed an initial "busy" snapshot for topics the server reports as running
  // but that this client has no live activity entry for yet (e.g. right after
  // opening the picker, before the next ai-status event arrives). Entries with
  // a query id came from live events and remain authoritative; snapshot-only
  // entries are reconciled on the next topic refresh.
  let activity = state.activity;
  for (const topic of orderedTopics) {
    const current = activity[topic.id];
    const snapshotIsNewer =
      topic.runningQueryId &&
      current?.running === false &&
      current.queryId !== topic.runningQueryId;
    if (topic.running && (!current || current.snapshot || snapshotIsNewer)) {
      if (activity === state.activity) activity = { ...state.activity };
      activity[topic.id] = {
        running: true,
        queryId: topic.runningQueryId,
        snapshot: true,
        tools: [],
        startedAtMs:
          current?.snapshot && current.queryId === topic.runningQueryId
            ? current.startedAtMs
            : Date.now(),
      };
    } else if (!topic.running && current?.snapshot) {
      if (activity === state.activity) activity = { ...state.activity };
      delete activity[topic.id];
    }
  }
  const pickedTopicId = state.topics[state.topicPickerIndex]?.id;
  const pickedTopicIndex = orderedTopics.findIndex((topic) => topic.id === pickedTopicId);
  const preferred = preferredTitle
    ? orderedTopics.find((topic) => topic.title.toLowerCase() === preferredTitle.toLowerCase())
    : undefined;
  const nextActive = state.topicPickerRoot
    ? null
    : (preferred?.id ?? (stillVisible ? state.activeTopicId : orderedTopics[0]?.id) ?? null);
  return clampTopicPickerSelection({
    ...state,
    topics: orderedTopics,
    activity,
    unread: withoutUnread(state.unread, nextActive),
    activeTopicId: nextActive,
    scrollOffset: nextActive === state.activeTopicId ? state.scrollOffset : 0,
    askChoiceIndex: nextActive === state.activeTopicId ? state.askChoiceIndex : 0,
    topicPickerIndex:
      // While the picker is open the user's cursor is on the row they chose.
      // Re-anchoring by active topic instead would silently move the highlight
      // under them mid-refresh.
      state.overlay === "topics"
        ? // `-1` when the refresh dropped the highlighted topic; the clamp below
          // then moves onto the first row the filter still shows.
          pickedTopicIndex
        : Math.max(
            0,
            orderedTopics.findIndex((topic) => topic.id === nextActive),
          ),
    topicPickerBackgroundId: state.topicPickerBackgroundId,
  });
}

/** Drops `topicId` from an unread map, returning the same object when absent. */
function withoutUnread(unread: AppState["unread"], topicId: string | null): AppState["unread"] {
  if (topicId === null || !unread[topicId]) return unread;
  const next = { ...unread };
  delete next[topicId];
  return next;
}

/**
 * Managers first, then the regular topics, each group in `sortedTopicEntries`
 * order — the one ordering the Topics panel, the `Ctrl-O` picker and topic
 * stepping all share.
 */
function managerFirstTopicEntries<T extends { topic: TopicDto }>(
  state: AppState,
  entries: T[],
): T[] {
  return [
    ...sortedTopicEntries(
      state,
      entries.filter(({ topic }) => topic.kind === "manager"),
    ),
    ...sortedTopicEntries(
      state,
      entries.filter(({ topic }) => topic.kind !== "manager"),
    ),
  ];
}

/** The topic `delta` rows from the active one in panel order, wrapping at either end. */
export function adjacentTopicId(state: AppState, delta: -1 | 1): string | null {
  const order = managerFirstTopicEntries(
    state,
    state.topics.map((topic) => ({ topic })),
  ).map(({ topic }) => topic.id);
  const current = order.indexOf(state.activeTopicId ?? "");
  if (current < 0 || order.length < 2) return null;
  return order[(current + delta + order.length) % order.length] ?? null;
}

export function selectTopic(state: AppState, topicId: string): AppState {
  if (!state.topics.some((topic) => topic.id === topicId)) return state;
  return {
    ...state,
    unread: withoutUnread(state.unread, topicId),
    activeTopicId: topicId,
    scrollOffset: 0,
    askChoiceIndex: 0,
    overlay: null,
    topicPickerRoot: false,
    creatingTopic: false,
    topicPickerIndex: state.topics.findIndex((topic) => topic.id === topicId),
    topicPickerBackgroundId: undefined,
    topicFilter: "",
    notice: undefined,
    noticeLevel: undefined,
  };
}

/** Select a newly-created topic before asynchronous list refreshes can race it. */
export function focusCreatedTopic(state: AppState, topic: TopicDto): AppState {
  const topics = state.topics.some((candidate) => candidate.id === topic.id)
    ? state.topics.map((candidate) => (candidate.id === topic.id ? topic : candidate))
    : [...state.topics, topic];
  return selectTopic(setTopics(state, topics), topic.id);
}

export function openTopicPicker(
  state: AppState,
  notice = state.notice,
  topicPickerRoot = false,
  // Carried over only when the caller is passing the *same* notice through; a
  // freshly supplied string with no level falls back to the neutral default
  // rather than inheriting the previous notice's severity.
  noticeLevel = notice === state.notice ? state.noticeLevel : undefined,
): AppState {
  const activeIndex = state.topics.findIndex((topic) => topic.id === state.activeTopicId);
  return clampTopicPickerSelection({
    ...state,
    activeTopicId: topicPickerRoot ? null : state.activeTopicId,
    overlay: "topics",
    topicPickerRoot,
    creatingTopic: false,
    topicPickerIndex: Math.max(0, activeIndex >= 0 ? activeIndex : state.topicPickerIndex),
    topicPickerBackgroundId: undefined,
    // A stale query from the previous visit would silently hide most of the
    // list on reopen, so every open starts from the unfiltered view.
    topicFilter: "",
    notice,
    noticeLevel,
  });
}

export function startTopicCreation(state: AppState): AppState {
  return {
    ...state,
    overlay: null,
    creatingTopic: true,
    notice: "Type a new topic name, then press Enter",
    noticeLevel: "info",
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
  patch: Partial<TerminalMessage>,
): AppState {
  const current = state.messages[topicId] ?? [];
  const index = current.findIndex((message) => message.id === messageId);
  if (index < 0) return state;
  const next = [...current];
  next[index] = { ...next[index], ...patch } as TerminalMessage;
  return { ...state, messages: { ...state.messages, [topicId]: next } };
}

function removeMessage(state: AppState, topicId: string, messageId: string): AppState {
  const current = state.messages[topicId] ?? [];
  const next = current.filter((message) => message.id !== messageId);
  if (next.length === current.length) return state;
  return { ...state, messages: { ...state.messages, [topicId]: next } };
}

/**
 * Marks `topicId` unread when its run just ended while another topic is on
 * screen. `wasRunning` keeps replayed or late terminal events for a run this
 * client never saw start from raising a false indicator.
 */
function flagUnreadReply(state: AppState, topicId: string, wasRunning: boolean): AppState {
  if (!wasRunning || topicId === state.activeTopicId) return state;
  return { ...state, unread: { ...state.unread, [topicId]: true } };
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

/**
 * Prefix every logical line of a diff snippet so each keeps its +/- meaning
 * when rendered (and colored) independently. Blank lines stay marked too.
 */
function diffLines(text: string, sign: "-" | "+"): string[] {
  if (!text) return [];
  return text.split("\n").map((line) => `${sign} ${line}`);
}

function logicalLineCount(text: string): number {
  if (!text) return 0;
  const normalized = text.replace(/\r\n?/g, "\n");
  const withoutFinalTerminator = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return withoutFinalTerminator ? withoutFinalTerminator.split("\n").length : 0;
}

function toolTimelineText(status: Record<string, unknown>): string {
  const name = String(status.name ?? "tool");
  const shortName = name.split("__").at(-1)?.toLowerCase() ?? name.toLowerCase();
  const input =
    status.input && typeof status.input === "object"
      ? (status.input as Record<string, unknown>)
      : {};
  const path = compactPath(input.file_path ?? input.path ?? input.file_id);
  if (shortName === "ask_session" || shortName === "tell_session") {
    const target = typeof input.to === "string" && input.to.trim() ? input.to.trim() : "session";
    const message = typeof input.message === "string" ? input.message.trim() : "";
    const action = shortName === "ask_session" ? "Ask session" : "Tell session";
    return [`${action} · ${target}`, message].filter(Boolean).join("\n");
  }
  if (shortName === "edit") {
    const before = typeof input.before === "string" ? input.before : "";
    const after = typeof input.after === "string" ? input.after : "";
    const diffPreview = typeof input.diff_preview === "string" ? input.diff_preview : "";
    const added = logicalLineCount(after);
    const removed = logicalLineCount(before);
    const stats = before || after ? ` (+${added} -${removed})` : "";
    const changed = input.change_kind === "update" ? "~ modified" : "";
    return [
      `Edit · ${path}${stats}`,
      ...(diffPreview
        ? diffPreview.split("\n")
        : [...diffLines(before, "-"), ...diffLines(after, "+")]),
      !before && !after && changed ? changed : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (shortName === "write") {
    const preview = typeof input.preview === "string" ? input.preview : "";
    const diffPreview = typeof input.diff_preview === "string" ? input.diff_preview : "";
    const added =
      typeof input.lines === "number" ? input.lines : preview ? logicalLineCount(preview) : 0;
    const stats = preview || typeof input.lines === "number" ? ` (+${added} -0)` : "";
    const created = input.change_kind === "add" ? "+ created" : "";
    return [
      `Write · ${path}${stats}`,
      ...(diffPreview ? diffPreview.split("\n") : preview ? diffLines(preview, "+") : [created]),
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (shortName === "delete") {
    const before = typeof input.before === "string" ? input.before : "";
    const diffPreview = typeof input.diff_preview === "string" ? input.diff_preview : "";
    const removed = logicalLineCount(before);
    const stats = before ? ` (+0 -${removed})` : "";
    return [
      `Delete · ${path}${stats}`,
      ...(diffPreview
        ? diffPreview.split("\n")
        : before
          ? diffLines(before, "-")
          : [input.change_kind === "delete" ? "- removed" : ""]),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return compactToolLabel(String(status.label ?? status.name ?? "tool"));
}

/**
 * Rewrite a tool timeline message for a failed result: the optimistic
 * change-kind line ("~ modified" / "+ created" / "- removed") becomes an
 * explicit failure line, and messages without one (e.g. diff previews) gain
 * a trailing failure line instead.
 */
function failedToolText(text: string): string {
  const [title = "Tool", ...details] = text.split("\n");
  const failureByMarker: Record<string, string> = {
    "~ modified": "! update failed",
    "+ created": "! create failed",
    "- removed": "! delete failed",
  };
  let marked = false;
  const mapped = details.map((detail) => {
    const failure = failureByMarker[detail];
    if (!failure) return detail;
    marked = true;
    return failure;
  });
  if (!marked && !mapped.some((detail) => detail.startsWith("!"))) mapped.push("! failed");
  return [title, ...mapped].join("\n");
}

/**
 * Titles that already carry their own content (a diff preview or a
 * transferred message) built by {@link toolTimelineText}. Appending raw
 * `tool_output` content under one of these would duplicate or clash with
 * that existing detail, so those tool kinds keep their current text as-is.
 */
const TOOL_OUTPUT_EXCLUDED_PREFIXES = [
  "Edit · ",
  "Write · ",
  "Delete · ",
  "Ask session · ",
  "Tell session · ",
];

/**
 * Generic tools (bash, grep, read, mcp calls, …) fall through to a one-line
 * label in {@link toolTimelineText} — the actual result only arrives later
 * as a separate `tool_output` event. Herdr's terminals show agent output
 * verbatim instead of hiding it; this attaches that output to the tool's
 * timeline message the same way a diff preview is attached, so the Terminal
 * client can render it instead of discarding it.
 */
function appendToolOutput(text: string, content: string): string {
  if (!content.trim()) return text;
  const [title = "Tool"] = text.split("\n");
  if (TOOL_OUTPUT_EXCLUDED_PREFIXES.some((prefix) => title.startsWith(prefix))) return text;
  if (text.includes("\n")) return text; // output already attached once
  const lines = content.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return [title, ...lines].join("\n");
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
  const liveCurrent = { ...current };
  delete liveCurrent.snapshot;
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
  if (kind === "context_progress") {
    if (isStaleTerminalStatus(current, status)) return state;
    return setActivity(state, topicId, {
      ...liveCurrent,
      running: true,
      queryId: typeof status.queryId === "string" ? status.queryId : current.queryId,
      contextProgress: {
        assistantTokens: Math.max(0, Number(status.assistantTokens) || 0),
        toolTokens: Math.max(0, Number(status.toolTokens) || 0),
      },
    });
  }
  if (kind === "ai_done") {
    // A superseded provider can finish unwinding after its replacement has
    // already broadcast ai_active. Its late terminal event must not stop the
    // replacement's spinner or overwrite its status.
    if (isStaleTerminalStatus(current, status)) return state;
    return flagUnreadReply(
      setActivity(state, topicId, {
        ...liveCurrent,
        running: false,
        status: "Done",
      }),
      topicId,
      current.running,
    );
  }
  if (kind === "ai_aborted") {
    if (isStaleTerminalStatus(current, status)) return state;
    return setActivity(state, topicId, {
      ...liveCurrent,
      running: false,
      status: "Aborted",
    });
  }
  if (kind === "ai_error") {
    if (isStaleTerminalStatus(current, status)) return state;
    return flagUnreadReply(
      setActivity(state, topicId, {
        ...liveCurrent,
        running: false,
        status: "Error",
        error: String(status.error ?? "Unknown error"),
      }),
      topicId,
      current.running,
    );
  }
  if (kind === "tool_call") {
    if (isStaleTerminalStatus(current, status)) return state;
    const queryId = String(status.queryId ?? "");
    const toolName = String(status.name ?? "");
    const shortToolName = toolName.split("__").at(-1)?.toLowerCase() ?? toolName.toLowerCase();
    const input =
      status.input && typeof status.input === "object"
        ? (status.input as Record<string, unknown>)
        : {};
    const sessionAction =
      shortToolName === "ask_session"
        ? "ask"
        : shortToolName === "tell_session"
          ? "tell"
          : undefined;
    const sessionTarget =
      sessionAction && typeof input.to === "string" && input.to.trim()
        ? input.to.trim()
        : undefined;
    const tool: ToolActivity = {
      id: String(status.toolUseId ?? `${queryId || "query"}:tool`),
      label: String(status.label ?? status.name ?? "tool"),
      status: "running",
      ...(sessionAction ? { sessionAction } : {}),
      ...(sessionTarget ? { sessionTarget } : {}),
    };
    const withActivity = setActivity(state, topicId, {
      ...liveCurrent,
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
    const failed = status.isError === true;
    const content = String(status.content ?? "");
    const tools = current.tools.map((tool) =>
      tool.id === id ? { ...tool, output: content, status: failed ? "error" : "done" } : tool,
    );
    const withActivity = setActivity(state, topicId, { ...liveCurrent, tools });
    const messageId = toolMessageId(status, id);
    const existing = (withActivity.messages[topicId] ?? []).find(
      (message) => message.id === messageId,
    );
    const withOutput = existing ? appendToolOutput(existing.text, content) : undefined;
    const nextText =
      failed && (!existing || withOutput === existing.text)
        ? failedToolText(existing?.text ?? "")
        : withOutput;
    return patchMessage(withActivity, topicId, messageId, {
      editedAt: createdAt ?? new Date().toISOString(),
      toolResult: failed ? "error" : "ok",
      ...(nextText !== undefined ? { text: nextText } : {}),
    });
  }
  if (kind === "tool_status") {
    if (isStaleTerminalStatus(current, status)) return state;
    return setActivity(state, topicId, {
      ...liveCurrent,
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
