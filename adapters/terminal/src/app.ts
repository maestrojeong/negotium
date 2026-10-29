import { hostname } from "node:os";
import {
  type AgentKind,
  isVaultCommandLine,
  type MessageDto,
  normalizeVaultKey,
  type RuntimeBusEvent,
  SELECTABLE_MODELS,
  type TopicDto,
  VAULT_DESCRIPTION_MAX_LENGTH,
  VAULT_VALUE_MAX_BYTES,
  VAULT_VALUE_MIN_BYTES,
  validateVaultKey,
} from "@negotium/core";
import {
  animationFrameAt,
  codeCopyTargetAt,
  consumeMouseInput,
  ctrlCExitsTopicPicker,
  escapeStopsActiveTurn,
  maestroVaultKeyForModel,
  normalizeKeySequences,
  pasteCollapseDisabled,
  runtimeEventInvalidatesSelection,
  runtimeEventWaitsForMessageLoad,
  sanitizePastedText,
  selectableEfforts,
  splitBracketedPaste,
  type TerminalMouseEvent,
  terminalDeletionShortcut,
  terminalNewlineShortcut,
  topicFilterInsertion,
  topicFilterPasteText,
  topicPickerTargetAt,
  topicStepDirection,
  vaultFormBlocksOverlaySwitch,
  type WheelEvent,
} from "@/app-helpers";
import {
  INITIAL_MESSAGE_HISTORY_LIMIT,
  MESSAGE_HISTORY_PAGE_SIZE,
  type MessageHistoryPage,
  type NegotiumClient,
} from "@/client";
import { copyToClipboard } from "@/clipboard";
import { CollapsedPasteStore, cursorForTextOffset, textOffsetForCursor } from "@/collapsed-pastes";
import { type ColorDepth, detectColorDepth, rgbToAnsi16, rgbToAnsi256 } from "@/color-depth";
import { runTerminalCommand } from "@/command-router";
import { commandSuggestions, completeCommand, isKnownTerminalCommand } from "@/commands";
import {
  adjustDecisionGraphSpacing,
  buildDecisionGraph,
  renderDecisionGraph,
} from "@/decision-graph";
import {
  completePathToken,
  isRecursivePathQuery,
  type PathSuggestion,
  pathSuggestions,
  stripResolvedPathTriggers,
  warmPathSuggestions,
} from "@/path-suggest";
import {
  type CodeCopyTarget,
  type ConversationBounds,
  maxConversationScrollOffset,
  maxSidePanelWidth,
  maxTaskPanelScrollOffset,
  maxTerminalPaneWidth,
  maxTopicsPanelScrollOffset,
  preserveConversationScrollAnchor,
  renderAppFrame,
  type SideColumnBounds,
  type SidePanelResizeHandle,
  type SidePanelTrack,
  scrollbarThumb,
  scrollOffsetFromDragRow,
  stripAnsi,
  type TerminalPaneBounds,
  type TopicPickerTarget,
  WORKING_FRAME_INTERVAL_MS,
} from "@/render";
import {
  END_SYNCHRONIZED_UPDATE,
  placeTerminalCursor,
  TerminalScreenRenderer,
} from "@/screen-renderer";
import {
  highlightScreenSelection,
  type ScreenPoint,
  type ScreenSelection,
  screenSelectionText,
} from "@/selection";
import { ptySupport, ShellPane } from "@/shell-pane";
import {
  type AppState,
  activeMessages,
  activeQuestion,
  activeTopic,
  activeVaultRequest,
  adjacentTopicId,
  appendTopicFilter,
  applyRuntimeEvent,
  backspaceTopicFilter,
  closeTerminalPane,
  composerHoldsSecret,
  createInitialState,
  cycleTopicsPanelSort,
  focusCreatedTopic,
  focusTerminalPane,
  moveTopicPickerSelection,
  openTerminalPane,
  openTopicPicker,
  pickedBackgroundSession,
  pickedTopic,
  type SubagentGraphCanvas,
  scrollTaskPanel,
  scrollTopicsPanel,
  selectTopic,
  setBackgroundSessions,
  setMessageHistoryStatus,
  setMessages,
  setSidePanelWidth,
  setTaskPanelScrollOffset,
  setTerminalPaneWidth,
  setTopicFilter,
  setTopics,
  setTopicsPanelScrollOffset,
  setTopicUsage,
  startTopicCreation,
  toggleTopicsPanel,
  upsertMessage,
} from "@/state";
import {
  adjustSubagentGraphSpacing,
  applySubagentGraphStates,
  buildSubagentGraph,
  layoutSubagentGraph,
  subagentGraphSignature,
} from "@/subagent-graph";
import { installTerminalRestore, upgradeTerminalRestore } from "@/terminal-restore";
import { type BufferCursor, InputHistory, TextBuffer } from "@/text-buffer";

// `[?1l` resets DECCKM (application cursor key mode) so arrow/Home/End keys
// arrive as CSI rather than SS3. `?1049h` does not save this mode, so the exit
// sequence re-asserts the same reset instead of restoring an unknown previous
// value: DECCKM-reset is the terminal default and every app that sets it (vim,
// less) clears it on its own exit, so both sides agreeing on `?1l` never leaves
// the parent shell in a state we did not put it in. XTSAVE/XTRESTORE
// (`[?1s`/`[?1r`) would be the textbook pair, but a terminal without
// XTRESTORE can misparse `CSI ? 1 r` as DECSTBM and clobber the scroll region.
//
// `\u001b[>1u` pushes exactly one kitty-keyboard flag, `DISAMBIGUATE_ESCAPE_CODES`.
// That single flag is what makes a bare Escape arrive as `CSI 27 u` instead of a
// lone `ESC` byte that is indistinguishable from the start of any other escape
// sequence, and it is what makes Shift-Enter/Ctrl-Enter reach us at all.
// Deliberately *not* pushed: `REPORT_EVENT_TYPES` and
// `REPORT_ALL_KEYS_AS_ESCAPE_CODES`. Those are the flags that force per-terminal
// exception tables (iTerm2 leaking key releases into the parent shell, tmux's
// xterm extended-key format dropping Shift-Enter). With flag 1 alone no terminal
// needs special casing, so we push unconditionally with no capability probe and
// let unsupporting terminals ignore the sequence.
// `\u001b[<u` pops that one stack entry back off and is the *first* thing in the exit
// sequence, so even a truncated restore hands the keyboard back first.
export const KITTY_KEYBOARD_PUSH = "\u001b[>1u";
export const KITTY_KEYBOARD_POP = "\u001b[<u";

/** Escape hatch: `NEGOTIUM_TUI_DISABLE_KITTY_KEYBOARD=1` skips push *and* pop. */
export function kittyKeyboardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.NEGOTIUM_TUI_DISABLE_KITTY_KEYBOARD;
  return value !== "1" && value !== "true" && value !== "yes";
}

/** `theme.canvas` from `render.ts`. Kept in sync by the alt-screen tests. */
const CANVAS_RGB = [10, 11, 15] as const;

/**
 * Background SGR for the initial canvas wipe, at the depth actually detected.
 *
 * Mirrors `render.ts`'s `bg()` — an ansi16 terminal receiving `CSI 48;2;…` may
 * ignore it (leaving the wipe transparent) or, worse, misparse the parameters,
 * so the one paint that happens outside the renderer must downshift like every
 * other one does.
 */
function canvasFill(depth: ColorDepth): string {
  switch (depth) {
    case "none":
      return "";
    case "ansi16": {
      const code = rgbToAnsi16(CANVAS_RGB);
      return `\u001b[${code < 8 ? 40 + code : 100 + (code - 8)}m`;
    }
    case "ansi256":
      return `\u001b[48;5;${rgbToAnsi256(CANVAS_RGB)}m`;
    default:
      return `\u001b[48;2;${CANVAS_RGB[0]};${CANVAS_RGB[1]};${CANVAS_RGB[2]}m`;
  }
}

/**
 * OSC 7 ("current working directory") for `cwd`.
 *
 * Terminal.app (and iTerm2, Ghostty, WezTerm) open a new tab or window "in the
 * same directory" from the last OSC 7 its tab saw. The shell only reports it at
 * a prompt, so re-announcing it around the TUI keeps a tab opened alongside the
 * TUI starting where the user launched it rather than in the home directory.
 */
export function workingDirectoryReport(cwd: string, host: string = hostname()): string {
  const path = cwd
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `\u001b]7;file://${host}${path}\u0007`;
}

export function altScreenSequences(
  env: NodeJS.ProcessEnv = process.env,
  // Test seam mirroring `ColorDepthProbe.savedDepth`: leave undefined to read
  // the real `<state dir>/tui-color` file (production behaviour), or pass
  // `null` to test env-only detection without a machine's persisted setting
  // leaking in.
  savedDepth?: string | null,
  cwd: string = process.cwd(),
): {
  enter: string;
  exit: string;
  abortEnter: string;
} {
  const push = kittyKeyboardEnabled(env) ? KITTY_KEYBOARD_PUSH : "";
  const pop = kittyKeyboardEnabled(env) ? KITTY_KEYBOARD_POP : "";
  // These bytes only ever reach a real terminal, so the TTY test in
  // `detectColorDepth` is short-circuited here; what matters is whether the
  // user asked for no colour (`NO_COLOR`, `TERM=dumb`, `NEGOTIUM_TUI_COLOR`).
  // Under `none` the truecolour canvas fill is skipped, so the terminal keeps
  // its own theme.
  //
  // The canvas is painted with SGR background on every cell rather than by
  // repainting the terminal's own default background (OSC 11 / OSC 111):
  // macOS Terminal.app copies a tab's *current* colours into any tab or window
  // opened from it, so while the TUI was up every new tab came up with the
  // TUI's near-black canvas instead of the user's profile background.
  const depth = detectColorDepth({ env, isTty: true, savedDepth });
  const fillCanvas = canvasFill(depth);
  const reportCwd = workingDirectoryReport(cwd);
  // Private-mode resets only. Every one of these is a no-op on a terminal where
  // the mode was never set, which is what makes them safe to emit at a point
  // where we may not have changed anything yet.
  // Mode 1003 ("any-event" tracking) is a superset of 1002 ("button-event"
  // tracking): it adds plain motion reports with no button held, which is
  // what lets the topic picker highlight a row on hover instead of only on
  // click. Every existing consumer of a mouse event already ignores motion
  // it doesn't care about (`(event.button & 3) !== 0 && kind !== "release"`
  // guards in `#handleMouseSelection` / `#handleGraphMouse`), so the extra
  // reports this enables are a cheap early-return outside the picker, not a
  // new cost paid everywhere.
  const modeResets =
    "\u001b[0m\u001b[?7h\u001b[?1l\u001b[?1006l\u001b[?1003l\u001b[?2004l\u001b[?25h\u001b[?1049l";
  return {
    enter: `${reportCwd}\u001b[?1049h${fillCanvas}\u001b[2J\u001b[H\u001b[?25l\u001b[?2004h\u001b[?1003h\u001b[?1006h\u001b[?1l${push}`,
    // `END_SYNCHRONIZED_UPDATE` leads: every render patch opens with
    // `CSI ?2026h`, so a process that dies mid-patch leaves the terminal
    // holding its output back. Ending the update is idempotent — a terminal
    // that never saw a begin, or does not implement DECSET 2026 at all, ignores
    // it — so two bytes buy an unconditional way out of a frozen screen.
    exit: `${END_SYNCHRONIZED_UPDATE}${pop}${modeResets}${reportCwd}`,
    // What to emit if the process dies *between* claiming the terminal and
    // finishing the `enter` write. Two pieces of `exit` are deliberately absent
    // because it is not idempotent:
    //
    //  - The kitty pop removes one entry from the keyboard stack. Popping
    //    without having pushed takes an entry that belongs to an outer app.
    //
    // Everything that remains is a mode reset, harmless on a mode that was
    // never set, so a half-written `enter` is still undone.
    abortEnter: `${END_SYNCHRONIZED_UPDATE}${modeResets}`,
  };
}

export const ENTER_ALT_SCREEN = altScreenSequences().enter;
export const EXIT_ALT_SCREEN = altScreenSequences().exit;
export const ABORT_ENTER_ALT_SCREEN = altScreenSequences().abortEnter;
/**
 * Topic-picker actions live on control chords, not bare letters.
 *
 * The picker is a type-to-filter surface now, so every printable key — Latin
 * and Hangul jamo alike — has to reach the query buffer. The old bare `n`/`d`
 * (and their two-set jamo twins `ㅜ`/`ㅇ`) plus Backspace/Delete bindings were
 * exactly the keys a filter needs most, and `d` in particular turned "filter
 * for a topic starting with d" into a *destructive* confirmation prompt.
 *
 * `Ctrl-D` is the Unix EOF convention, but this app puts stdin in raw mode,
 * where 0x04 arrives as an ordinary byte and never terminates the stream. That
 * was measured, not assumed: injecting bytes into a real `pty.fork()` pty with
 * `setRawMode(true)` applied delivers `0x04` to the application verbatim, and
 * the same holds inside a tmux session (measured on macOS + tmux 3.7b; other
 * terminals and multi-hop ssh are unverified). It is also scoped to the picker
 * overlay, so it cannot leak into composer editing, where Ctrl-D is not bound
 * at all.
 */
const NEW_TOPIC_KEY = "\u000e"; // Ctrl-N
const DELETE_TOPIC_KEY = "\u0004"; // Ctrl-D
const TERMINAL_PANE_KEY = "\u0014"; // Ctrl-T
/** Backspace, in both the DEL and BS encodings terminals send. */
const FILTER_BACKSPACE_KEYS = new Set(["\u007f", "\b"]);
const CONFIRM_KEYS = new Set(["y", "ㅛ"]);
const CANCEL_KEYS = new Set(["n", "ㅜ"]);
/**
 * How long a partial escape sequence may be held before it is treated as
 * ordinary keys. The two halves of a torn sequence arrive from the same
 * terminal write, microseconds apart; a human keypress never does. Short
 * enough to be imperceptible on the Esc key, long enough to bridge a stdin
 * chunk boundary.
 */
const INPUT_CARRY_FLUSH_MS = 15;

export {
  animationFrameAt,
  codeCopyTargetAt,
  consumeMouseInput,
  ctrlCExitsTopicPicker,
  escapeStopsActiveTurn,
  maestroVaultKeyForModel,
  normalizeKeySequences,
  pasteCollapseDisabled,
  runTerminalVaultCommand,
  runtimeEventInvalidatesSelection,
  runtimeEventWaitsForMessageLoad,
  sanitizePastedText,
  splitBracketedPaste,
  terminalDeletionShortcut,
  terminalNewlineShortcut,
  topicFilterInsertion,
  topicFilterPasteText,
  topicPickerTargetAt,
  vaultFormBlocksOverlaySwitch,
} from "@/app-helpers";

export function terminalNeedsAnimation(state: AppState): boolean {
  const activeRunning = Boolean(
    state.activeTopicId && state.activity[state.activeTopicId]?.running,
  );
  const overlayRunning =
    (state.overlay === "topics" || state.overlay === "subagents") &&
    state.topics.some((topic) => state.activity[topic.id]?.running);
  return activeRunning || overlayRunning || state.backgroundSessions.length > 0;
}

export interface TerminalAppOptions {
  userId: string;
  preferredTopic?: string;
  defaultAgent?: AgentKind;
}

export class TerminalApp {
  readonly #client: NegotiumClient;
  readonly #options: TerminalAppOptions;
  #state: AppState;
  readonly #input = new TextBuffer();
  readonly #screen = new TerminalScreenRenderer();
  readonly #historyByTopic = new Map<string, InputHistory>();
  readonly #draftsByTopic = new Map<string, { text: string; cursor: BufferCursor }>();
  #vaultDraftValue = "";
  #pendingModelSwitch: { topicId: string; model: string } | undefined;
  #pasting = false;
  #pasteChunks: string[] = [];
  /** Trailing bytes of an incomplete escape sequence. See `splitBracketedPaste`. */
  #inputCarry = "";
  #inputCarryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #collapsedPastes = new CollapsedPasteStore();
  #renderQueued = false;
  #renderTimer: ReturnType<typeof setTimeout> | undefined;
  #pathSearchTimer: ReturnType<typeof setTimeout> | undefined;
  #pathSearchGeneration = 0;
  #animationTimer: ReturnType<typeof setInterval> | undefined;
  #backgroundRefreshTimer: ReturnType<typeof setInterval> | undefined;
  #backgroundRefreshRunning = false;
  #animationFrame = animationFrameAt();
  #topicsRefreshGeneration = 0;
  readonly #topicUsageRefreshGeneration = new Map<string, number>();
  readonly #messageLoadGeneration = new Map<string, number>();
  readonly #messageHistory = new Map<
    string,
    { cursor?: string; hasMore: boolean; loading: boolean }
  >();
  readonly #queuedRuntimeEvents = new Map<string, RuntimeBusEvent[]>();
  #selection: ScreenSelection | null = null;
  /** True between a selection's press and its release — the drag is live. */
  #selectionDragging = false;
  #subagentGraphDragPoint: ScreenPoint | null = null;
  #plainFrameLines: string[] = [];
  #codeCopyTargets: CodeCopyTarget[] = [];
  #topicPickerTargets: TopicPickerTarget[] = [];
  #sidePanelTracks: SidePanelTrack[] = [];
  #sideColumnBounds: SideColumnBounds | null = null;
  #sidePanelResizeHandle: SidePanelResizeHandle | null = null;
  /** Which side-panel scrollbar thumb, if any, a press/drag is currently dragging. */
  #sidePanelDrag: {
    panel: "topics" | "tasks";
    track: SidePanelTrack;
    grabRowOffset: number;
  } | null = null;
  /** Set while a `│` divider is being dragged to resize the column beside it. */
  #sidePanelResizeDrag: {
    target: "side" | "terminal";
    startX: number;
    startWidth: number;
  } | null = null;
  /** The live shell behind the right-hand pane; kept running while the pane is hidden. */
  #shell: ShellPane | null = null;
  #terminalPane: TerminalPaneBounds | null = null;
  #conversationBounds: ConversationBounds | null = null;
  #lastInterruptAt = 0;
  #subagentGraphGeneration = 0;
  #subagentGraphAbortController: AbortController | null = null;
  #subagentGraphSpacingTimer: ReturnType<typeof setTimeout> | null = null;
  // Caches the last laid-out canvas keyed by structural signature so live
  // running-state changes re-render via nodeStates overlay without rerunning ELK.
  #subagentGraphCache: { signature: string; canvas: SubagentGraphCanvas } | null = null;
  #pendingSubagentGraphSpacing: number | null = null;
  #decisionGraphGeneration = 0;
  #decisionGraphAbortController: AbortController | null = null;
  #decisionGraphSpacingTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingDecisionGraphSpacing: number | null = null;
  #running = false;
  #stopRequested = false;
  #finishRun: (() => void) | null = null;
  #onData = (chunk: Buffer | string) => this.#handleInput(String(chunk));
  #onResize = () => {
    this.#selection = null;
    this.#screen.invalidate();
    this.#queueRender();
  };
  #uninstallTerminalRestore: (() => void) | null = null;

  constructor(client: NegotiumClient, options: TerminalAppOptions) {
    this.#client = client;
    this.#options = options;
    this.#state = createInitialState(options.userId);
  }

  /**
   * Input recall (up/down arrow) scoped to the active topic. Each topic's
   * history is loaded from the client once, on first use, and cached here;
   * an empty-string bucket covers the moment before any topic is active
   * (e.g. the startup topic picker) and matches the store's default bucket
   * for pre-migration rows.
   */
  get #history(): InputHistory {
    const topicId = this.#state.activeTopicId ?? "";
    let history = this.#historyByTopic.get(topicId);
    if (!history) {
      history = new InputHistory(this.#client.listInputHistory?.(topicId) ?? []);
      this.#historyByTopic.set(topicId, history);
    }
    return history;
  }

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("terminal-adapter requires an interactive TTY");
    }
    let clientStartAttempted = false;
    let uiActive = false;
    try {
      clientStartAttempted = true;
      await this.#client.start((event) => this.#handleRuntimeEvent(event));
      if (this.#stopRequested) return;
      await this.#refreshTopics(this.#options.preferredTopic ?? "General");
      await this.#refreshBackgroundSessions();
      if (this.#options.preferredTopic) {
        const preferred = this.#state.topics.find(
          (topic) => topic.title.toLowerCase() === this.#options.preferredTopic?.toLowerCase(),
        );
        if (!preferred) {
          const created = await this.#client.createTopic(
            this.#options.preferredTopic,
            this.#options.defaultAgent,
          );
          this.#state = focusCreatedTopic(this.#state, created);
          await this.#refreshTopics(created.title);
          this.#selectTopicKeepingDrafts(created.id);
        }
      }
      if (!this.#options.preferredTopic) {
        this.#state = openTopicPicker(this.#state, this.#state.notice, true);
      } else {
        await this.#loadActiveMessages();
      }
      this.#running = true;

      // Claim the terminal *before* the first byte reaches it. The claim is
      // exclusive, so a second adapter in the same process is rejected here —
      // with nothing written, no raw mode touched and the running adapter's
      // hooks untouched, which is what makes the rejection safe.
      //
      // It also closes the window between "the terminal is half configured" and
      // "something can put it back". The hooks start armed with the reduced
      // `abortEnter` sequence, which undoes a partial entry without touching
      // anything we have not set yet, and are upgraded to the full restore the
      // moment the entry is complete.
      this.#uninstallTerminalRestore = installTerminalRestore(ABORT_ENTER_ALT_SCREEN, {
        onSignal: () => this.#requestExit(),
      });
      try {
        process.stdout.write(ENTER_ALT_SCREEN);
      } catch (error) {
        // Never entered, so hand the claim straight back: a host retrying the
        // adapter must not be told the terminal is still owned.
        this.#uninstallTerminalRestore();
        this.#uninstallTerminalRestore = null;
        throw error;
      }
      upgradeTerminalRestore(EXIT_ALT_SCREEN);
      uiActive = true;
      process.stdin.setEncoding("utf8");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", this.#onData);
      process.stdout.on("resize", this.#onResize);
      this.#render();
      this.#animationTimer = setInterval(() => {
        if (!terminalNeedsAnimation(this.#state)) return;
        // Derive the frame from elapsed time so a delayed timer callback does
        // not make the larger topic-picker render appear to spin slowly.
        this.#animationFrame = animationFrameAt();
        this.#queueRender();
      }, WORKING_FRAME_INTERVAL_MS);
      // Keep this timer referenced. Bun heavily throttles an unref'ed timer
      // while the TUI is otherwise waiting on stdin, which makes the spinner
      // advance in regular bursts instead of at the requested frame rate.
      this.#backgroundRefreshTimer = setInterval(() => {
        void this.#refreshBackgroundSessions();
      }, 1_000);
      this.#backgroundRefreshTimer.unref?.();

      await new Promise<void>((resolve) => {
        this.#finishRun = resolve;
      });
    } finally {
      this.#running = false;
      await this.#cleanup(clientStartAttempted, uiActive);
    }
  }

  /** Request a graceful, idempotent shutdown from an embedding host. */
  stop(): void {
    this.#stopRequested = true;
    this.#requestExit();
  }

  #applyRuntimeEvent(event: RuntimeBusEvent): void {
    const previousState = this.#state;
    const heldSecretBefore = composerHoldsSecret(previousState)
      ? activeVaultRequest(previousState)?.id
      : undefined;
    this.#state = preserveConversationScrollAnchor(
      previousState,
      applyRuntimeEvent(previousState, event),
      process.stdout.columns ?? 100,
      process.stdout.rows ?? 30,
    );
    // The card this turn's typed value belonged to resolved, expired, or was
    // answered from elsewhere (another window, or the turn aborting) before
    // Enter was pressed here. Discard rather than let the next Enter send the
    // half-typed secret as an ordinary chat message.
    if (
      heldSecretBefore !== undefined &&
      activeVaultRequest(this.#state)?.id !== heldSecretBefore
    ) {
      this.#input.setText("");
      this.#syncInput();
      this.#state = {
        ...this.#state,
        vaultRequestMode: "value",
        vaultRequestSubmitting: false,
        vaultRequestNotice: undefined,
        notice: "A vault request expired — the typed value was discarded",
        noticeLevel: "info",
      };
    }
  }

  #handleRuntimeEvent(event: RuntimeBusEvent): void {
    // Background topics can emit progress events every few seconds. They do
    // not change the active conversation, so they must not interrupt a drag
    // selection on this screen.
    //
    // An in-progress drag is never dropped, even for the active topic: while
    // a reply streams in, events land many times a second, and clearing here
    // left every later drag frame ignored (`#handleMouseSelection` bails on a
    // null selection), so a multi-line drag only ever kept its first row.
    if (!this.#selectionDragging && runtimeEventInvalidatesSelection(this.#state, event)) {
      this.#selection = null;
    }
    // Only message-order-sensitive events wait for the in-flight history load to
    // finish; ai-status (running/done) is safe to apply immediately so the
    // "is it running" indicator never lags behind a topic switch's network round-trip.
    if (this.#messageLoadGeneration.has(event.topicId) && runtimeEventWaitsForMessageLoad(event)) {
      const queued = this.#queuedRuntimeEvents.get(event.topicId) ?? [];
      queued.push(event);
      this.#queuedRuntimeEvents.set(event.topicId, queued);
      return;
    }
    this.#applyRuntimeEvent(event);
    if (
      (event.type === "message" && (event.payload as MessageDto).usage) ||
      (event.type === "message-updated" &&
        (event.payload as { patch?: Partial<MessageDto> }).patch?.usage)
    ) {
      void this.#refreshTopicUsage(event.topicId);
    }
    if (
      event.type === "topic-created" ||
      event.type === "topic-updated" ||
      event.type === "topic-deleted"
    ) {
      const previous = this.#state.activeTopicId;
      const refreshSubagentGraph = this.#state.overlay === "subagents";
      if (refreshSubagentGraph) {
        this.#subagentGraphGeneration += 1;
        this.#subagentGraphAbortController?.abort();
        this.#subagentGraphAbortController = null;
        this.#state = {
          ...this.#state,
          subagentGraph: undefined,
          subagentGraphLoading: true,
        };
      }
      void this.#refreshTopicsAfterEvent(previous, refreshSubagentGraph);
    }
    this.#queueRender();
  }

  async #refreshTopicsAfterEvent(
    previous: string | null,
    refreshSubagentGraph = false,
  ): Promise<void> {
    try {
      await this.#refreshTopics();
      if (this.#state.activeTopicId && this.#state.activeTopicId !== previous) {
        await this.#loadActiveMessages();
      }
      if (refreshSubagentGraph && this.#state.overlay === "subagents") {
        await this.#reloadSubagentGraphAfterTopicEvent();
      }
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: `Node connection error: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  // Cache the laid-out canvas by structural signature and publish it with a live
  // running-state overlay. Later same-structure updates reuse this canvas.
  #storeSubagentGraph(
    rawCanvas: SubagentGraphCanvas,
    signature: string,
    runningTopicIds: ReadonlySet<string>,
    rootId: string,
  ): void {
    this.#subagentGraphCache = { signature, canvas: rawCanvas };
    this.#state = {
      ...this.#state,
      subagentGraph: applySubagentGraphStates(rawCanvas, runningTopicIds, rootId),
      subagentGraphLoading: false,
    };
  }

  async #reloadSubagentGraphAfterTopicEvent(): Promise<void> {
    const topicId = this.#state.activeTopicId;
    if (!topicId || this.#state.overlay !== "subagents") return;
    const runningTopicIds = new Set(
      Object.entries(this.#state.activity)
        .filter(([, activity]) => activity.running)
        .map(([candidateId]) => candidateId),
    );
    const graph = buildSubagentGraph(this.#state.topics, topicId, runningTopicIds);
    const signature = subagentGraphSignature(graph, this.#state.subagentGraphSpacing);

    // Fast path: graph structure is unchanged, so only running states can differ.
    // Overlay them onto the cached canvas without rerunning ELK layout.
    if (this.#subagentGraphCache?.signature === signature) {
      this.#subagentGraphGeneration += 1;
      this.#subagentGraphAbortController?.abort();
      this.#subagentGraphAbortController = null;
      this.#state = {
        ...this.#state,
        subagentGraph: applySubagentGraphStates(
          this.#subagentGraphCache.canvas,
          runningTopicIds,
          topicId,
        ),
        subagentGraphLoading: false,
      };
      this.#queueRender();
      return;
    }

    const generation = ++this.#subagentGraphGeneration;
    this.#subagentGraphAbortController?.abort();
    const layoutController = new AbortController();
    this.#subagentGraphAbortController = layoutController;
    try {
      const canvas = await layoutSubagentGraph(
        graph,
        this.#state.subagentGraphSpacing,
        layoutController.signal,
      );
      if (generation !== this.#subagentGraphGeneration || this.#state.overlay !== "subagents") {
        return;
      }
      this.#subagentGraphAbortController = null;
      this.#storeSubagentGraph(canvas, signature, runningTopicIds, topicId);
    } catch (error) {
      if (generation !== this.#subagentGraphGeneration) return;
      this.#subagentGraphAbortController = null;
      this.#state = {
        ...this.#state,
        overlay: null,
        subagentGraphLoading: false,
        notice: `Graph layout failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
  }

  async #refreshTopics(preferredTitle?: string): Promise<void> {
    const generation = ++this.#topicsRefreshGeneration;
    const topics = await this.#client.listTopics();
    if (generation !== this.#topicsRefreshGeneration) return;
    this.#state = setTopics(this.#state, topics, preferredTitle);
  }

  async #refreshBackgroundSessions(): Promise<void> {
    if (!this.#client.listBackgroundSessions || this.#backgroundRefreshRunning) return;
    this.#backgroundRefreshRunning = true;
    try {
      const sessions = await this.#client.listBackgroundSessions();
      const before = JSON.stringify(this.#state.backgroundSessions);
      this.#state = setBackgroundSessions(this.#state, sessions);
      if (JSON.stringify(this.#state.backgroundSessions) !== before) this.#queueRender();
    } catch {
      // Topic conversations remain usable while the optional operational view reconnects.
    } finally {
      this.#backgroundRefreshRunning = false;
    }
  }

  async #refreshTopicUsage(topicId: string): Promise<void> {
    if (!this.#client.listTopicUsage) return;
    const generation = (this.#topicUsageRefreshGeneration.get(topicId) ?? 0) + 1;
    this.#topicUsageRefreshGeneration.set(topicId, generation);
    try {
      const usage = await this.#client.listTopicUsage(topicId);
      if (this.#topicUsageRefreshGeneration.get(topicId) !== generation) return;
      this.#state = setTopicUsage(this.#state, usage);
      if (this.#state.activeTopicId === topicId) this.#queueRender();
    } catch {
      // Usage is supplementary; a stats read must not block the conversation.
    }
  }

  async #loadActiveMessages(): Promise<void> {
    const topic = activeTopic(this.#state);
    if (!topic) return;
    const generation = (this.#messageLoadGeneration.get(topic.id) ?? 0) + 1;
    this.#messageLoadGeneration.set(topic.id, generation);
    let messagePage: MessageHistoryPage;
    let recentEvents: RuntimeBusEvent[];
    try {
      const messageRequest: Promise<MessageHistoryPage> = this.#client.listMessagePage
        ? Promise.resolve(
            this.#client.listMessagePage(topic.id, undefined, INITIAL_MESSAGE_HISTORY_LIMIT),
          )
        : Promise.resolve(this.#client.listMessages(topic.id)).then((messages) => ({
            messages,
            hasMore: false,
          }));
      [messagePage, recentEvents] = await Promise.all([
        messageRequest,
        this.#client.listRecentEvents?.(topic.id) ?? [],
      ]);
    } catch (error) {
      if (this.#messageLoadGeneration.get(topic.id) === generation) {
        this.#messageLoadGeneration.delete(topic.id);
        const queued = this.#queuedRuntimeEvents.get(topic.id) ?? [];
        this.#queuedRuntimeEvents.delete(topic.id);
        for (const event of queued) this.#applyRuntimeEvent(event);
      }
      throw error;
    }
    if (this.#messageLoadGeneration.get(topic.id) !== generation) return;
    this.#state = setMessages(this.#state, topic.id, messagePage.messages);
    this.#messageHistory.set(topic.id, {
      cursor: messagePage.cursor,
      hasMore: messagePage.hasMore,
      loading: false,
    });
    this.#state = setMessageHistoryStatus(this.#state, topic.id, {
      hasMore: messagePage.hasMore,
      loading: false,
    });
    for (const event of recentEvents) {
      this.#applyRuntimeEvent(event);
    }
    this.#messageLoadGeneration.delete(topic.id);
    const queued = this.#queuedRuntimeEvents.get(topic.id) ?? [];
    this.#queuedRuntimeEvents.delete(topic.id);
    for (const event of queued) this.#applyRuntimeEvent(event);
    void this.#refreshTopicUsage(topic.id);
  }

  async #loadOlderMessages(topicId: string, targetOffset: number): Promise<void> {
    const history = this.#messageHistory.get(topicId);
    if (!this.#client.listMessagePage || !history?.hasMore || history.loading) return;
    const cursor = history.cursor;
    if (!cursor) return;
    this.#messageHistory.set(topicId, { ...history, loading: true });
    this.#state = setMessageHistoryStatus(this.#state, topicId, {
      hasMore: history.hasMore,
      loading: true,
    });
    this.#queueRender();

    try {
      const page = await this.#client.listMessagePage(topicId, cursor, MESSAGE_HISTORY_PAGE_SIZE);
      const latestHistory = this.#messageHistory.get(topicId);
      if (!latestHistory || latestHistory.cursor !== cursor) return;

      const current = this.#state.messages[topicId] ?? [];
      const currentIds = new Set(current.map((message) => message.id));
      const older = page.messages.filter((message) => !currentIds.has(message.id));
      this.#state = setMessages(this.#state, topicId, [...older, ...current]);
      this.#messageHistory.set(topicId, {
        cursor: page.cursor,
        hasMore: page.hasMore,
        loading: false,
      });
      this.#state = setMessageHistoryStatus(this.#state, topicId, {
        hasMore: page.hasMore,
        loading: false,
      });
      if (this.#state.activeTopicId === topicId) {
        const maxOffset = maxConversationScrollOffset(
          this.#state,
          process.stdout.columns ?? 100,
          process.stdout.rows ?? 30,
        );
        this.#state = {
          ...this.#state,
          scrollOffset: Math.min(maxOffset, Math.max(0, targetOffset)),
          notice:
            older.length === 0 || !page.hasMore
              ? "Start of conversation"
              : `Loaded ${older.length} older messages`,
          noticeLevel: "info",
        };
      }
    } catch (error) {
      const latestHistory = this.#messageHistory.get(topicId);
      if (latestHistory?.cursor === cursor) {
        this.#messageHistory.set(topicId, { ...latestHistory, loading: false });
        this.#state = setMessageHistoryStatus(this.#state, topicId, {
          hasMore: latestHistory.hasMore,
          loading: false,
        });
      }
      this.#state = {
        ...this.#state,
        notice: `History load failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  #queueRender(): void {
    if (!this.#running || this.#renderQueued) return;
    this.#renderQueued = true;
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = undefined;
      this.#renderQueued = false;
      if (this.#running) this.#render();
    }, 16);
  }

  #render(): void {
    const columns = process.stdout.columns ?? 100;
    const rows = process.stdout.rows ?? 30;
    const rendered = renderAppFrame(this.#state, columns, rows, this.#animationFrame, undefined, {
      shell: this.#shell?.snapshot() ?? null,
    });
    this.#codeCopyTargets = rendered.codeCopyTargets;
    this.#topicPickerTargets = rendered.topicPickerTargets;
    this.#sidePanelTracks = rendered.sidePanelTracks;
    this.#sideColumnBounds = rendered.sideColumnBounds;
    this.#sidePanelResizeHandle = rendered.sidePanelResizeHandle;
    this.#terminalPane = rendered.terminalPane;
    this.#conversationBounds = rendered.conversationBounds;
    // The PTY follows whatever size the pane was just drawn at; the shell
    // repaints itself for the new size, which queues the next frame.
    if (this.#shell && rendered.terminalPane) {
      this.#shell.resize(rendered.terminalPane.cols, rendered.terminalPane.rows);
    }
    const baseFrame = rendered.frame;
    this.#plainFrameLines = stripAnsi(baseFrame).split("\n");
    const frame = this.#selection
      ? highlightScreenSelection(baseFrame, this.#selection)
      : baseFrame;
    // Terminal emulators anchor IME preedit text to the hardware cursor. The
    // placement goes through the renderer so it lands inside the synchronized
    // block with the patch, rather than as a second write the terminal can be
    // caught between.
    const patch = this.#screen.update(frame, rows, rendered.cursor);
    const cursorOnly = patch || !rendered.cursor ? "" : placeTerminalCursor(rendered.cursor);
    if (patch || cursorOnly) process.stdout.write(`${patch}${cursorOnly}`);
  }

  async #toggleSubagentGraph(): Promise<void> {
    const topicId = this.#state.activeTopicId;
    if (!topicId) return;
    this.#decisionGraphGeneration += 1;
    this.#decisionGraphAbortController?.abort();
    this.#decisionGraphAbortController = null;
    if (this.#state.overlay === "subagents") {
      this.#subagentGraphGeneration += 1;
      this.#subagentGraphAbortController?.abort();
      this.#subagentGraphAbortController = null;
      this.#subagentGraphDragPoint = null;
      this.#state = { ...this.#state, overlay: null, subagentGraphLoading: false };
      this.#queueRender();
      return;
    }
    const runningTopicIds = new Set(
      Object.entries(this.#state.activity)
        .filter(([, activity]) => activity.running)
        .map(([candidateId]) => candidateId),
    );
    const graph = buildSubagentGraph(this.#state.topics, topicId, runningTopicIds);
    if (graph.nodes.length === 0) {
      this.#state = { ...this.#state, notice: "No subagents in this topic", noticeLevel: "info" };
      this.#queueRender();
      return;
    }

    const generation = ++this.#subagentGraphGeneration;
    this.#subagentGraphAbortController?.abort();
    const layoutController = new AbortController();
    this.#subagentGraphAbortController = layoutController;
    this.#subagentGraphDragPoint = null;
    this.#state = {
      ...this.#state,
      overlay: "subagents",
      subagentGraph: undefined,
      subagentGraphLoading: true,
      subagentGraphOffset: { x: 0, y: 0 },
      notice: undefined,
      noticeLevel: undefined,
    };
    this.#queueRender();
    try {
      const canvas = await layoutSubagentGraph(
        graph,
        this.#state.subagentGraphSpacing,
        layoutController.signal,
      );
      if (generation !== this.#subagentGraphGeneration || this.#state.overlay !== "subagents") {
        return;
      }
      this.#storeSubagentGraph(
        canvas,
        subagentGraphSignature(graph, this.#state.subagentGraphSpacing),
        runningTopicIds,
        topicId,
      );
      this.#subagentGraphAbortController = null;
    } catch (error) {
      if (generation !== this.#subagentGraphGeneration) return;
      this.#subagentGraphAbortController = null;
      this.#state = {
        ...this.#state,
        overlay: null,
        subagentGraphLoading: false,
        notice: `Graph layout failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  async #toggleDecisionGraph(): Promise<void> {
    const topic = activeTopic(this.#state);
    if (!topic || !this.#client.listDecisions) return;
    if (this.#state.overlay === "decisions") {
      this.#decisionGraphGeneration += 1;
      this.#decisionGraphAbortController?.abort();
      this.#decisionGraphAbortController = null;
      this.#subagentGraphDragPoint = null;
      this.#state = { ...this.#state, overlay: null, decisionGraphLoading: false };
      this.#queueRender();
      return;
    }

    this.#subagentGraphGeneration += 1;
    this.#subagentGraphAbortController?.abort();
    this.#subagentGraphAbortController = null;
    const generation = ++this.#decisionGraphGeneration;
    this.#decisionGraphAbortController?.abort();
    const controller = new AbortController();
    this.#decisionGraphAbortController = controller;
    this.#subagentGraphDragPoint = null;
    this.#state = {
      ...this.#state,
      overlay: "decisions",
      decisionGraph: undefined,
      decisionGraphLoading: true,
      decisionGraphOffset: { x: 0, y: 0 },
      notice: undefined,
      noticeLevel: undefined,
    };
    this.#queueRender();
    try {
      const decisions = await this.#client.listDecisions(topic.id);
      if (generation !== this.#decisionGraphGeneration || this.#state.overlay !== "decisions") {
        return;
      }
      if (decisions.length === 0) {
        this.#decisionGraphAbortController = null;
        this.#state = {
          ...this.#state,
          overlay: null,
          decisionGraphLoading: false,
          notice: "No decisions recorded in this topic",
          noticeLevel: "info",
        };
        this.#queueRender();
        return;
      }
      const rendered = await renderDecisionGraph(
        buildDecisionGraph(decisions, topic.title),
        this.#state.decisionGraphSpacing,
        controller.signal,
      );
      if (generation !== this.#decisionGraphGeneration || this.#state.overlay !== "decisions") {
        return;
      }
      let saveWarning: string | undefined;
      try {
        await this.#client.saveDecisionGraph?.(topic.id, rendered.svg);
      } catch (error) {
        saveWarning = `Decision graph shown but SVG save failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.#decisionGraphAbortController = null;
      this.#state = {
        ...this.#state,
        decisionGraph: rendered.canvas,
        decisionGraphLoading: false,
        ...(saveWarning ? { notice: saveWarning, noticeLevel: "warn" } : {}),
      };
    } catch (error) {
      if (generation !== this.#decisionGraphGeneration) return;
      this.#decisionGraphAbortController = null;
      this.#state = {
        ...this.#state,
        overlay: null,
        decisionGraphLoading: false,
        notice: `Decision graph failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  #changeDecisionGraphSpacing(delta: number): void {
    const previous = this.#pendingDecisionGraphSpacing ?? this.#state.decisionGraphSpacing;
    const spacing = adjustDecisionGraphSpacing(previous, delta);
    if (spacing === previous) return;
    this.#pendingDecisionGraphSpacing = spacing;
    if (this.#decisionGraphSpacingTimer) clearTimeout(this.#decisionGraphSpacingTimer);
    this.#decisionGraphSpacingTimer = setTimeout(() => {
      this.#decisionGraphSpacingTimer = null;
      const target = this.#pendingDecisionGraphSpacing;
      this.#pendingDecisionGraphSpacing = null;
      if (target !== null) void this.#applyDecisionGraphSpacing(target);
    }, 120);
  }

  async #applyDecisionGraphSpacing(spacing: number): Promise<void> {
    const topic = activeTopic(this.#state);
    if (!topic || this.#state.overlay !== "decisions" || !this.#client.listDecisions) return;
    const generation = ++this.#decisionGraphGeneration;
    this.#decisionGraphAbortController?.abort();
    const controller = new AbortController();
    this.#decisionGraphAbortController = controller;
    this.#state = { ...this.#state, decisionGraphSpacing: spacing, decisionGraphLoading: true };
    this.#queueRender();
    try {
      const decisions = await this.#client.listDecisions(topic.id);
      const rendered = await renderDecisionGraph(
        buildDecisionGraph(decisions, topic.title),
        spacing,
        controller.signal,
      );
      if (generation !== this.#decisionGraphGeneration || this.#state.overlay !== "decisions") {
        return;
      }
      let saveWarning: string | undefined;
      try {
        await this.#client.saveDecisionGraph?.(topic.id, rendered.svg);
      } catch (error) {
        saveWarning = `Decision graph shown but SVG save failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.#decisionGraphAbortController = null;
      this.#state = {
        ...this.#state,
        decisionGraph: rendered.canvas,
        decisionGraphLoading: false,
        ...(saveWarning ? { notice: saveWarning, noticeLevel: "warn" } : {}),
      };
    } catch (error) {
      if (generation !== this.#decisionGraphGeneration) return;
      this.#decisionGraphAbortController = null;
      this.#state = {
        ...this.#state,
        decisionGraphLoading: false,
        notice: `Decision graph failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  #changeSubagentGraphSpacing(delta: number): void {
    // Batch rapid [ / ] key-repeat into one worker layout after the burst settles.
    const previousSpacing = this.#pendingSubagentGraphSpacing ?? this.#state.subagentGraphSpacing;
    const spacing = adjustSubagentGraphSpacing(previousSpacing, delta);
    if (spacing === previousSpacing) return;
    this.#pendingSubagentGraphSpacing = spacing;
    if (this.#subagentGraphSpacingTimer) clearTimeout(this.#subagentGraphSpacingTimer);
    this.#subagentGraphSpacingTimer = setTimeout(() => {
      this.#subagentGraphSpacingTimer = null;
      const target = this.#pendingSubagentGraphSpacing;
      this.#pendingSubagentGraphSpacing = null;
      if (target !== null && target !== this.#state.subagentGraphSpacing) {
        void this.#applySubagentGraphSpacing(target);
      }
    }, 120);
  }

  async #applySubagentGraphSpacing(spacing: number): Promise<void> {
    const topicId = this.#state.activeTopicId;
    if (!topicId || this.#state.overlay !== "subagents") return;
    const previousSpacing = this.#state.subagentGraphSpacing;
    if (spacing === previousSpacing) return;

    const runningTopicIds = new Set(
      Object.entries(this.#state.activity)
        .filter(([, activity]) => activity.running)
        .map(([candidateId]) => candidateId),
    );
    const graph = buildSubagentGraph(this.#state.topics, topicId, runningTopicIds);
    const generation = ++this.#subagentGraphGeneration;
    this.#subagentGraphAbortController?.abort();
    const layoutController = new AbortController();
    this.#subagentGraphAbortController = layoutController;
    this.#state = {
      ...this.#state,
      subagentGraphSpacing: spacing,
      subagentGraphLoading: true,
      notice: undefined,
      noticeLevel: undefined,
    };
    this.#queueRender();

    try {
      const canvas = await layoutSubagentGraph(graph, spacing, layoutController.signal);
      if (generation !== this.#subagentGraphGeneration || this.#state.overlay !== "subagents") {
        return;
      }
      this.#storeSubagentGraph(
        canvas,
        subagentGraphSignature(graph, this.#state.subagentGraphSpacing),
        runningTopicIds,
        topicId,
      );
      this.#subagentGraphAbortController = null;
    } catch (error) {
      if (generation !== this.#subagentGraphGeneration) return;
      this.#subagentGraphAbortController = null;
      this.#state = {
        ...this.#state,
        subagentGraphSpacing: previousSpacing,
        subagentGraphLoading: false,
        notice: `Graph layout failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  #syncInput(): void {
    this.#collapsedPastes.reconcile(this.#input.text);
    const count = this.#suggestionCount();
    this.#state = {
      ...this.#state,
      input: this.#input.text,
      inputCursor: this.#input.cursor,
      suggestionIndex: count === 0 ? 0 : Math.min(this.#state.suggestionIndex, count - 1),
    };
    this.#schedulePathSearch();
  }

  #schedulePathSearch(): void {
    if (this.#pathSearchTimer) clearTimeout(this.#pathSearchTimer);
    const generation = ++this.#pathSearchGeneration;
    if (composerHoldsSecret(this.#state)) return;
    const cursor = this.#input.cursor;
    const lineText = this.#input.text.split("\n")[cursor.row] ?? "";
    if (!isRecursivePathQuery(lineText, cursor.col)) {
      this.#pathSearchTimer = undefined;
      return;
    }
    this.#pathSearchTimer = setTimeout(() => {
      this.#pathSearchTimer = undefined;
      const search = warmPathSuggestions(lineText, cursor.col);
      if (pathSuggestions(lineText, cursor.col)?.searching) this.#queueRender();
      void search.then((changed) => {
        if (!changed || !this.#running || generation !== this.#pathSearchGeneration) return;
        const count = this.#suggestionCount();
        this.#state = {
          ...this.#state,
          suggestionIndex: count === 0 ? 0 : Math.min(this.#state.suggestionIndex, count - 1),
        };
        this.#queueRender();
      });
    }, 120);
  }

  /**
   * Swaps the composer contents wholesale. The caret defaults to the end, which
   * is right for a history entry or a completion, but a restored *draft* passes
   * the position it was abandoned at — see the Down-arrow handler.
   */
  #replaceInput(value: string, cursor?: BufferCursor): void {
    this.#collapsedPastes.clear();
    this.#input.setText(value, cursor ?? "end");
    this.#syncInput();
    this.#queueRender();
  }

  /**
   * Splits raw stdin on bracketed-paste markers before anything else. Paste
   * payloads bypass the mouse and key parsers entirely: feeding them through
   * `consumeMouseInput` made an SGR mouse report embedded in pasted text vanish
   * from the buffer while firing a phantom click.
   *
   * Bytes that follow a completed paste *in the same read burst* are treated as
   * text rather than dispatched as keys or mouse events. This is a mitigation,
   * not a guarantee, and the distinction matters:
   *
   * Bracketed paste cannot be made airtight from inside the application. The
   * end marker and the payload are the same bytes on the wire, so content that
   * contains `ESC [ 2 0 1 ~` ends the paste as far as any reader is concerned;
   * whatever follows looks exactly like typed input. Most current terminals
   * filter the marker out of pasted content before sending it, which is what
   * keeps real exposure low, and redesigning the protocol here would not change
   * what the terminal put on the wire.
   *
   * What this *does* remove is the ability of such content to act. A spoofed
   * end marker can still split one paste into two, but the tail cannot fire a
   * click, a Ctrl-chord or an Enter — it goes through `sanitizePastedText` and
   * lands in the composer, visible, where the user decides what happens next.
   * The trade-off is that a genuine keystroke arriving in the same chunk as the
   * end of a paste is typed instead of executed; human reaction time makes that
   * essentially unreachable, whereas the same chunk is exactly where injected
   * content lives. Recorded in docs/TERMINAL-DEFERRED.md.
   */
  #handleInput(raw: string): void {
    if (!this.#running) return;
    if (this.#inputCarryTimer) {
      clearTimeout(this.#inputCarryTimer);
      this.#inputCarryTimer = undefined;
    }
    const split = splitBracketedPaste(raw, this.#pasting, this.#inputCarry);
    let collecting = this.#pasting;
    let commits = 0;
    this.#pasting = split.pasting;
    this.#inputCarry = split.carry;
    this.#scheduleInputCarryFlush();
    for (const segment of split.segments) {
      if (segment.kind === "keys") {
        // Text only once a paste has ended in this burst — see the note above.
        if (commits > 0) this.#commitPaste(segment.text);
        else this.#handleKeySegment(segment.text);
        continue;
      }
      if (!collecting) {
        this.#pasteChunks = [];
        collecting = true;
      }
      this.#pasteChunks.push(segment.text);
      if (segment.kind === "paste-chunk") continue;
      const payload = this.#pasteChunks.join("");
      this.#pasteChunks = [];
      collecting = false;
      commits += 1;
      this.#commitPaste(payload);
    }
    if (commits > 0) this.#queueRender();
  }

  /**
   * A held-back marker fragment is only ever resolved by more input. Outside a
   * paste that is not guaranteed to arrive: a lone `ESC` keypress is a proper
   * prefix of `ESC [ 2 0 0 ~`, so without this the Esc key would stall until the
   * user pressed something else. Inside a paste we keep waiting instead — the
   * terminal owes us the end marker, and flushing early would tear it again.
   */
  #scheduleInputCarryFlush(): void {
    if (!this.#inputCarry || this.#pasting) return;
    this.#inputCarryTimer = setTimeout(() => {
      this.#inputCarryTimer = undefined;
      this.#flushInputCarry();
    }, INPUT_CARRY_FLUSH_MS);
    this.#inputCarryTimer.unref?.();
  }

  #flushInputCarry(): void {
    const carry = this.#inputCarry;
    if (!carry || this.#pasting || !this.#running) return;
    this.#inputCarry = "";
    this.#handleKeySegment(carry);
  }

  /**
   * The topic picker owns the keyboard while it is open, so a paste has to land
   * in the filter rather than in the composer hidden behind it: appending to
   * `#input` put the text somewhere the user could not see, and it reappeared
   * only after closing the picker. Appending to the filter is what typing does,
   * and pasting a topic name to jump to it is the obvious intent.
   *
   * The filter is a single line, so newlines collapse to spaces — dropping all
   * but the first line would silently discard input, and the filter is a
   * substring match where a space is just another character.
   */
  #commitPaste(payload: string): void {
    this.#selection = null;
    if (this.#state.terminalPaneFocused && this.#shell) {
      this.#shell.paste(payload);
      return;
    }
    if (this.#state.overlay === "topics") {
      const filterText = topicFilterPasteText(payload);
      if (filterText) {
        this.#state = appendTopicFilter(this.#state, filterText);
        this.#queueRender();
      }
      return;
    }
    const pasted = sanitizePastedText(payload);
    if (pasted) {
      if (pasteCollapseDisabled(this.#state)) {
        this.#input.insert(pasted);
      } else {
        const inserted = this.#collapsedPastes.insert(
          pasted,
          this.#input.text,
          textOffsetForCursor(this.#input.text, this.#input.cursor),
        );
        this.#input.setText(
          inserted.text,
          cursorForTextOffset(inserted.text, inserted.cursorOffset),
        );
      }
    }
    this.#syncInput();
  }

  #handleKeySegment(segment: string): void {
    const mouse = consumeMouseInput(segment);
    const { scrollDelta, horizontalScrollDelta } = this.#routeWheelEvents(mouse.wheelEvents);
    if (
      horizontalScrollDelta !== 0 &&
      (this.#state.overlay === "subagents" || this.#state.overlay === "decisions")
    ) {
      this.#selection = null;
      this.#panActiveGraph(-horizontalScrollDelta, 0);
    }
    if (scrollDelta !== 0) {
      this.#selection = null;
      this.#scroll(scrollDelta);
    }
    for (const event of mouse.events) {
      if (this.#state.overlay === "subagents" || this.#state.overlay === "decisions") {
        this.#handleGraphMouse(event);
        continue;
      }
      // The scrollbar thumb's column and the resize handle's hit region
      // overlap by design (the handle is grabbable on the panel's own last
      // column, not just the one-column gap past it) — check the scrollbar
      // first so a press on the thumb scrolls instead of always resizing.
      if (this.#handleSidePanelScrollbarDrag(event)) continue;
      this.#focusPaneUnderPress(event);
      if (this.#handleSidePanelResizeDrag(event)) continue;
      if (this.#handlePickableRowMouse(event)) continue;
      this.#handleMouseSelection(event);
    }
    const chunk = normalizeKeySequences(mouse.input);
    if (!chunk) return;
    this.#selection = null;
    if (chunk === TERMINAL_PANE_KEY) {
      this.#toggleTerminalPane();
      return;
    }
    // Everything else typed while the shell pane has focus belongs to the
    // shell — Ctrl-C included — exactly as in a plain terminal. `terminalPaneFocused`
    // is a preference bit and stays true even when the window is too narrow
    // for the layout to actually draw the pane (`this.#terminalPane` goes
    // null then); route to the shell only while it is really on screen, or
    // every keystroke — including the one meant to interrupt — vanishes into
    // an invisible shell.
    if (this.#state.terminalPaneFocused && this.#shell && this.#terminalPane) {
      this.#shell.write(chunk);
      return;
    }
    if (chunk === "\u0003") {
      this.#handleInterrupt(); // Ctrl-C
      return;
    }
    if (this.#state.overlay === "topics" && this.#state.topicPickerRoot) {
      this.#lastInterruptAt = 0;
      this.#handleTopicPickerInput(chunk);
      return;
    }
    this.#lastInterruptAt = 0;
    const editingVaultSecret = vaultFormBlocksOverlaySwitch(this.#state);
    if (chunk === "\u0018") {
      void this.#abort(); // Ctrl-X
      return;
    }
    if (chunk === "\u000f") {
      // Switching overlays would render the composer as ordinary plaintext.
      // Keep secret/description entry inside the masking Vault overlay.
      if (editingVaultSecret) return;
      this.#toggleTopics();
      return;
    }
    if (chunk === "\u0007") {
      if (editingVaultSecret) return;
      void this.#toggleSubagentGraph();
      return;
    }
    if (chunk === "\u0004" && this.#state.overlay !== "topics") {
      if (editingVaultSecret) return;
      void this.#toggleDecisionGraph(); // Ctrl-D
      return;
    }
    if (chunk === NEW_TOPIC_KEY && this.#sideColumnBounds !== null && !this.#state.creatingTopic) {
      // Ctrl-N: with the side column actually on screen (not just the user's
      // Ctrl-P preference — a narrow terminal or the Ctrl-O/subagents/
      // decisions/vault overlays hide it even when enabled), starting a new
      // topic from the session view mirrors the topic picker's own Ctrl-N.
      if (editingVaultSecret) return;
      // The composer may be holding a masked vault-secret value or an
      // in-progress answer to the agent's own question; typing a topic name
      // there would feed it into the wrong place instead of creating a topic.
      if (composerHoldsSecret(this.#state) || activeQuestion(this.#state)) return;
      // Don't clobber a half-written draft message; let the user send or
      // clear it first.
      if (this.#input.text) {
        this.#state = {
          ...this.#state,
          notice: "Clear the message box first, then Ctrl-N to start a new topic",
          noticeLevel: "warn",
        };
        this.#queueRender();
        return;
      }
      this.#openNewTopicComposer();
      return;
    }
    const stepDirection = topicStepDirection(chunk);
    if (stepDirection !== null && this.#state.overlay === null) {
      // Ctrl/Alt-↑ ↓: previous/next topic in panel order without opening the
      // Ctrl-O picker. Never while a masked vault secret or a half-answered
      // agent question owns the composer — switching away would strand it.
      if (editingVaultSecret || composerHoldsSecret(this.#state)) return;
      this.#stepTopic(stepDirection);
      return;
    }
    if (chunk === "\u0010") {
      if (editingVaultSecret) return;
      this.#state = toggleTopicsPanel(this.#state); // Ctrl-P: topics + tasks side panel
      this.#queueRender();
      return;
    }
    if (chunk === "\u0012") {
      if (editingVaultSecret) return;
      this.#state = cycleTopicsPanelSort(this.#state); // Ctrl-R
      this.#queueRender();
      return;
    }
    if (chunk === "\u0019") {
      void this.#copy(); // Ctrl-Y
      return;
    }
    if (chunk === "\u0005") {
      this.#loadOlderHistory(); // Ctrl-E
      return;
    }
    if (chunk === "\u000c") {
      this.#screen.invalidate();
      this.#render(); // Ctrl-L
      return;
    }
    if (this.#state.overlay === "subagents") {
      if (chunk === "\u001b") {
        this.#subagentGraphGeneration += 1;
        this.#subagentGraphAbortController?.abort();
        this.#subagentGraphAbortController = null;
        this.#subagentGraphDragPoint = null;
        this.#state = { ...this.#state, overlay: null, subagentGraphLoading: false };
      } else if (chunk === "\u001b[A" || chunk === "k") {
        this.#panSubagentGraph(0, -2);
        return;
      } else if (chunk === "\u001b[B" || chunk === "j") {
        this.#panSubagentGraph(0, 2);
        return;
      } else if (chunk === "\u001b[D" || chunk === "h") {
        this.#panSubagentGraph(-4, 0);
        return;
      } else if (chunk === "\u001b[C" || chunk === "l") {
        this.#panSubagentGraph(4, 0);
        return;
      } else if (chunk === "\u001b[5~") {
        this.#panSubagentGraph(0, -8);
        return;
      } else if (chunk === "\u001b[6~") {
        this.#panSubagentGraph(0, 8);
        return;
      } else if (chunk === "[" || chunk === "]") {
        this.#changeSubagentGraphSpacing(chunk === "[" ? -1 : 1);
        return;
      }
      this.#queueRender();
      return;
    }
    if (this.#state.overlay === "decisions") {
      if (chunk === "\u001b") {
        this.#decisionGraphGeneration += 1;
        this.#decisionGraphAbortController?.abort();
        this.#decisionGraphAbortController = null;
        this.#subagentGraphDragPoint = null;
        this.#state = { ...this.#state, overlay: null, decisionGraphLoading: false };
      } else if (chunk === "\u001b[A" || chunk === "k") {
        this.#panDecisionGraph(0, -2);
        return;
      } else if (chunk === "\u001b[B" || chunk === "j") {
        this.#panDecisionGraph(0, 2);
        return;
      } else if (chunk === "\u001b[D" || chunk === "h") {
        this.#panDecisionGraph(-4, 0);
        return;
      } else if (chunk === "\u001b[C" || chunk === "l") {
        this.#panDecisionGraph(4, 0);
        return;
      } else if (chunk === "\u001b[5~") {
        this.#panDecisionGraph(0, -8);
        return;
      } else if (chunk === "\u001b[6~") {
        this.#panDecisionGraph(0, 8);
        return;
      } else if (chunk === "[" || chunk === "]") {
        this.#changeDecisionGraphSpacing(chunk === "[" ? -1 : 1);
        return;
      }
      this.#queueRender();
      return;
    }
    if (chunk === "\u0001" || chunk === "\u001b[H" || chunk === "\u001b[1~") {
      this.#input.moveHome();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001b[F" || chunk === "\u001b[4~") {
      this.#input.moveEnd();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001b[D" || chunk === "\u0002") {
      this.#input.moveLeft();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001b[C" || chunk === "\u0006") {
      this.#input.moveRight();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001bb" || chunk === "\u001b[1;5D" || chunk === "\u001b[1;3D") {
      this.#input.moveWordLeft();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001bf" || chunk === "\u001b[1;5C" || chunk === "\u001b[1;3C") {
      this.#input.moveWordRight();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001b[3~") {
      this.#input.deleteForward();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    const deletionShortcut = terminalDeletionShortcut(chunk);
    if (deletionShortcut) {
      if (deletionShortcut === "word-left") this.#input.deleteWordLeft();
      else this.#input.clearBeforeCursor();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u000b") {
      this.#input.clearAfterCursor(); // Ctrl-K
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001b[5~") {
      this.#scroll(8); // PageUp
      return;
    }
    if (chunk === "\u001b[6~") {
      this.#scroll(-8); // PageDown
      return;
    }
    if (this.#state.overlay === "confirm-delete") {
      const key = chunk.toLowerCase();
      if (CONFIRM_KEYS.has(key)) void this.#confirmTopicDelete();
      else if (CANCEL_KEYS.has(key) || chunk === "\u001b") {
        const cancelled = { ...this.#state, overlay: null, pendingDeleteTopicId: undefined };
        this.#state = this.#state.topicPickerRoot
          ? openTopicPicker(cancelled, undefined, true)
          : cancelled;
        this.#queueRender();
      }
      return;
    }
    if (this.#state.overlay === "background-session") {
      if (chunk === "\u001b") {
        this.#state = { ...this.#state, overlay: "topics" };
        this.#queueRender();
      }
      return;
    }
    if (this.#state.overlay === "topics") {
      this.#handleTopicPickerInput(chunk);
      return;
    }
    if (this.#state.overlay === "models") {
      if (chunk === "\u001b[A") this.#moveModelPicker(-1);
      else if (chunk === "\u001b[B") this.#moveModelPicker(1);
      else if (chunk === "\r") void this.#selectPickedModel();
      else if (chunk === "\u001b") {
        this.#state = { ...this.#state, overlay: null };
        this.#queueRender();
      }
      return;
    }
    if (this.#state.overlay === "effort") {
      if (chunk === "\u001b[A") this.#moveEffortPicker(-1);
      else if (chunk === "\u001b[B") this.#moveEffortPicker(1);
      else if (chunk === "\r") void this.#selectPickedEffort();
      else if (chunk === "\u001b") {
        this.#state = { ...this.#state, overlay: null };
        this.#queueRender();
      }
      return;
    }
    if (this.#state.overlay === "vault") {
      if (this.#state.vaultMode === "confirm-delete") {
        this.#handleVaultListInput(chunk);
        return;
      }
      if (this.#state.vaultMode === "list" && this.#state.vaultEntries.length > 0) {
        // The list has no cap on how many secrets it holds, but the overlay
        // only has a few rows of room; without this the entries past the
        // first screenful were invisible with no indication more existed.
        if (chunk === "\u001b[A") {
          this.#moveVaultPicker(-1);
          return;
        }
        if (chunk === "\u001b[B") {
          this.#moveVaultPicker(1);
          return;
        }
      }
      if (chunk === "\u001b") {
        this.#cancelVaultForm();
        return;
      }
    }
    // A pending `request_vault_secret` card owns the composer: no history
    // walk, no path/command suggestions, no paste collapsing, and Esc
    // clears the typed value before it ever offers to decline — so a
    // reflexive Esc never throws away a secret the user was still typing.
    if (!this.#state.overlay && activeVaultRequest(this.#state)) {
      if (this.#state.vaultRequestMode === "confirm-decline") {
        if (chunk === "y" || chunk === "Y") {
          void this.#answerVaultRequest(null);
        } else if (chunk === "n" || chunk === "N" || chunk === "\u001b") {
          this.#state = { ...this.#state, vaultRequestMode: "value" };
          this.#queueRender();
        }
        return;
      }
      if (chunk === "\u001b") {
        if (this.#input.text.length > 0) {
          this.#input.setText("");
          this.#syncInput();
          this.#state = { ...this.#state, vaultRequestNotice: undefined };
        } else {
          this.#state = { ...this.#state, vaultRequestMode: "confirm-decline" };
        }
        this.#queueRender();
        return;
      }
      if (chunk === "\r") {
        void this.#submit();
        return;
      }
      if (terminalNewlineShortcut(chunk)) {
        this.#input.insert("\n");
        this.#syncInput();
        this.#queueRender();
        return;
      }
      if (chunk === "\u007f" || chunk === "\b") {
        this.#input.backspace();
        this.#syncInput();
        this.#queueRender();
        return;
      }
      if (chunk.startsWith("\u001b")) return;
      const secretPrintable = [
        ...chunk.replaceAll("\r", "").replaceAll("\n", "").replaceAll("\t", " "),
      ]
        .filter((character) => {
          const code = character.charCodeAt(0);
          return code > 0x1f && code !== 0x7f;
        })
        .join("");
      if (secretPrintable) {
        this.#input.insert(secretPrintable);
        this.#syncInput();
        this.#queueRender();
      }
      return;
    }
    if (chunk === "\u001b[A") {
      if (activeQuestion(this.#state)) this.#moveAskChoice(-1);
      else if (this.#suggestionCount() > 0) this.#moveSuggestion(-1);
      else if (this.#input.isOnFirstLine) {
        // Search on the text in front of the caret; remember the whole draft
        // *and* where the caret was, so walking back down restores the edit
        // exactly as it was abandoned.
        const previous = this.#history.previous(
          this.#input.text,
          this.#input.textBeforeCursor,
          this.#input.cursor,
        );
        if (previous !== null) this.#replaceInput(previous);
      } else {
        this.#input.moveUp();
        this.#syncInput();
        this.#queueRender();
      }
      return;
    }
    if (chunk === "\u001b[B") {
      if (activeQuestion(this.#state)) this.#moveAskChoice(1);
      else if (this.#suggestionCount() > 0) this.#moveSuggestion(1);
      else if (this.#input.isOnLastLine) {
        const next = this.#history.next();
        // Back on the draft: restore its caret too. History entries have no
        // caret of their own and land at the end, like text just typed.
        if (next !== null) {
          this.#replaceInput(next, this.#history.atDraft ? this.#history.draftCursor : undefined);
        }
      } else {
        this.#input.moveDown();
        this.#syncInput();
        this.#queueRender();
      }
      return;
    }
    if (chunk === "\t" || chunk === "\u001b[Z") {
      const completed = completeCommand(this.#input.text, this.#state.suggestionIndex);
      if (completed !== null) this.#replaceInput(completed);
      else this.#applyPathCompletion(true);
      return;
    }
    if (chunk === "\r") {
      // Enter completes the highlighted path (keeping the `@` trigger live so
      // the user can keep drilling or return to re-search). When completion is
      // a no-op — the token already equals a fully resolved path — fall through
      // to submit so a second Enter sends the message.
      if (
        this.#state.overlay !== "vault" &&
        !activeQuestion(this.#state) &&
        commandSuggestions(this.#input.text).length === 0 &&
        this.#pathItems().length > 0 &&
        this.#applyPathCompletion(true)
      ) {
        return;
      }
      void this.#submit();
      return;
    }
    if (terminalNewlineShortcut(chunk)) {
      this.#input.insert("\n");
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u007f" || chunk === "\b") {
      this.#input.backspace();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001b") {
      if (escapeStopsActiveTurn(this.#state)) {
        void this.#abort();
        return;
      }
      this.#input.setText("");
      this.#history.reset();
      this.#syncInput();
      const cancelled = { ...this.#state, overlay: null, creatingTopic: false };
      this.#state = this.#state.topicPickerRoot
        ? openTopicPicker(cancelled, undefined, true)
        : cancelled;
      this.#queueRender();
      return;
    }
    if (chunk.startsWith("\u001b")) return;

    const printable = [...chunk.replaceAll("\r", "").replaceAll("\n", "").replaceAll("\t", " ")]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code > 0x1f && code !== 0x7f;
      })
      .join("");
    if (printable) {
      this.#input.insert(printable);
      this.#syncInput();
      this.#queueRender();
    }
  }

  async #submit(): Promise<void> {
    if (
      this.#state.overlay === "vault" &&
      this.#state.vaultMode !== "list" &&
      this.#state.vaultMode !== "confirm-delete"
    ) {
      await this.#submitVaultField();
      return;
    }
    if (!this.#state.overlay && activeVaultRequest(this.#state)) {
      await this.#submitVaultRequest();
      return;
    }
    const ask = activeQuestion(this.#state);
    if (ask?.askUserQuestion?.choices.length) {
      const index = Math.min(this.#state.askChoiceIndex, ask.askUserQuestion.choices.length - 1);
      const choice = ask.askUserQuestion.choices[index];
      const result = await this.#client.answerQuestion(ask.topicId, ask.id, choice.label);
      this.#state = {
        ...this.#state,
        askChoiceIndex: 0,
        notice: result.ok ? undefined : result.error,
        noticeLevel: result.ok ? undefined : "error",
      };
      this.#queueRender();
      return;
    }

    const displayText = this.#input.text.trim();
    const text = this.#collapsedPastes.expand(displayText).trim();
    if (!text) return;
    const inVaultCommandScreen =
      this.#state.overlay === "vault" && this.#state.vaultMode === "list";
    if (inVaultCommandScreen && !isVaultCommandLine(text)) {
      this.#input.setText("");
      this.#collapsedPastes.clear();
      this.#syncInput();
      this.#state = {
        ...this.#state,
        vaultNotice: "Use /vault set KEY VALUE or /vault del KEY.",
      };
      this.#queueRender();
      return;
    }
    if (this.#state.creatingTopic) {
      this.#input.setText("");
      this.#collapsedPastes.clear();
      this.#syncInput();
      this.#state = {
        ...this.#state,
        creatingTopic: false,
        notice: undefined,
        noticeLevel: undefined,
      };
      await this.#createTopic(text);
      return;
    }
    // Vault commands may contain plaintext credentials. Never persist them in
    // the terminal input history, including malformed commands that show help.
    if (!isVaultCommandLine(text)) {
      this.#history.record(text);
      this.#client.appendInputHistory?.(this.#state.activeTopicId ?? "", text);
    }
    this.#input.setText("");
    this.#collapsedPastes.clear();
    this.#syncInput();
    const keepVaultOpen = this.#state.overlay === "vault";
    this.#state = {
      ...this.#state,
      overlay: keepVaultOpen ? "vault" : null,
      notice: undefined,
      noticeLevel: undefined,
    };
    // Only an actual command name after the `/` goes to the command runner —
    // text that merely starts with `/` (an absolute path pasted or typed in,
    // e.g. `/example-report.pdf`) is sent as an ordinary message instead of
    // erroring as an unknown command. `isKnownTerminalCommand` matches the
    // bare command name only, so `/vault@bot set KEY value` (a bot-mention
    // form `isVaultCommandLine` already accepts) would otherwise miss here
    // and fall through to being sent as a plain chat message — with the
    // plaintext secret going straight to the model and the transcript.
    if (isKnownTerminalCommand(text) || isVaultCommandLine(text)) {
      await this.#runCommand(text);
      return;
    }
    const topic = activeTopic(this.#state);
    if (!topic) {
      this.#state = { ...this.#state, notice: "No topic selected", noticeLevel: "info" };
      this.#queueRender();
      return;
    }
    const optimisticQueryId = `terminal-pending-${Date.now()}`;
    this.#state = applyRuntimeEvent(
      { ...this.#state, scrollOffset: 0 },
      {
        type: "ai-status",
        topicId: topic.id,
        payload: { kind: "ai_active", queryId: optimisticQueryId },
      },
    );
    this.#queueRender();
    try {
      const message = await this.#client.sendMessage(topic, stripResolvedPathTriggers(text));
      this.#state = upsertMessage(this.#state, message);
    } catch (error) {
      if (this.#state.activity[topic.id]?.queryId === optimisticQueryId) {
        this.#state = applyRuntimeEvent(this.#state, {
          type: "ai-status",
          topicId: topic.id,
          payload: {
            kind: "ai_error",
            queryId: optimisticQueryId,
            error: "Message could not be sent",
          },
        });
      }
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  async #runCommand(commandLine: string): Promise<void> {
    const app = this;
    await runTerminalCommand(commandLine, {
      client: this.#client,
      get state() {
        return app.#state;
      },
      set state(value) {
        app.#state = value;
      },
      queueRender: () => this.#queueRender(),
      requestExit: () => this.#requestExit(),
      abort: () => this.#abort(),
      openVault: (notice) => this.#openVault(notice),
      refreshTopics: (preferredTitle) => this.#refreshTopics(preferredTitle),
      toggleTopics: (forceOpen) => this.#toggleTopics(forceOpen),
      deriveTopic: (topic, copyHistory, name) => this.#deriveTopic(topic, copyHistory, name),
      requestTopicDelete: (topic) => this.#requestTopicDelete(topic),
      copy: () => this.#copy(),
    });
  }

  /**
   * Switches the active topic and swaps the composer with it: the half-typed
   * message is parked under the topic being left and the target topic's own
   * parked draft (if any) is restored, so a draft never leaks into another
   * conversation.
   */
  #selectTopicKeepingDrafts(topicId: string): void {
    const heldSecret = composerHoldsSecret(this.#state);
    const previous = this.#state.activeTopicId;
    this.#state = selectTopic(this.#state, topicId);
    if (previous === this.#state.activeTopicId) return;
    if (previous) {
      // A secret typed for one topic's request must never park as a draft —
      // it would resurface (unmasked, as ordinary text) if this topic is
      // revisited after the request already resolved.
      if (heldSecret) this.#draftsByTopic.delete(previous);
      else {
        const text = this.#collapsedPastes.expand(this.#input.text);
        if (text) this.#draftsByTopic.set(previous, { text, cursor: this.#input.cursor });
        else this.#draftsByTopic.delete(previous);
      }
    }
    if (heldSecret) {
      this.#state = {
        ...this.#state,
        vaultRequestMode: "value",
        vaultRequestSubmitting: false,
        vaultRequestNotice: undefined,
      };
    }
    const draft = this.#state.activeTopicId
      ? this.#draftsByTopic.get(this.#state.activeTopicId)
      : undefined;
    this.#collapsedPastes.clear();
    this.#input.setText(draft?.text ?? "", draft?.cursor ?? "end");
    this.#syncInput();
  }

  async #activateTopic(topicId: string): Promise<void> {
    this.#selectTopicKeepingDrafts(topicId);
    // Paint the switch (title, spinner from already-known state.activity, etc.)
    // immediately instead of waiting on the message-history network round-trip.
    this.#queueRender();
    try {
      await this.#loadActiveMessages();
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  /** Moves to the previous (-1) or next (1) topic in panel order, wrapping. */
  #stepTopic(delta: -1 | 1): void {
    const topicId = adjacentTopicId(this.#state, delta);
    if (topicId === null) return;
    void this.#activateTopic(topicId);
  }

  #toggleTopics(forceOpen = false): void {
    this.#state =
      forceOpen || this.#state.overlay !== "topics"
        ? openTopicPicker(this.#state)
        : { ...this.#state, overlay: null };
    this.#queueRender();
  }

  #handleTopicPickerInput(chunk: string): void {
    if (chunk === "\u001b[A") {
      this.#moveTopicPicker(-1);
      return;
    }
    if (chunk === "\u001b[B") {
      this.#moveTopicPicker(1);
      return;
    }
    if (chunk === "\r") {
      this.#selectPickedTopic();
      return;
    }
    if (chunk === NEW_TOPIC_KEY) {
      this.#openNewTopicComposer();
      return;
    }
    if (chunk === DELETE_TOPIC_KEY) {
      const topic = pickedTopic(this.#state);
      if (topic) {
        this.#requestTopicDelete(topic);
        return;
      }
      // No selection at all (the filter matched nothing) is not the same as a
      // background session being highlighted: there is nothing to explain, so
      // say nothing.
      if (!this.#state.topicPickerBackgroundId) return;
      this.#state = {
        ...this.#state,
        notice: "Background sessions are read-only",
        noticeLevel: "warn",
      };
      this.#queueRender();
      return;
    }
    if (FILTER_BACKSPACE_KEYS.has(chunk)) {
      if (this.#state.topicFilter.length === 0) return;
      this.#state = backspaceTopicFilter(this.#state);
      this.#queueRender();
      return;
    }
    if (chunk === "\u001b") {
      // Two-stage Escape, the convention in fuzzy pickers (fzf, VS Code's
      // command palette, Telescope): the first press undoes the narrowing, the
      // second leaves. Closing outright on the first press would make a typo in
      // a long query cost the whole overlay — and in root mode it quits the app,
      // which is far too destructive to hang off a key the user is pressing to
      // "get back to the full list".
      if (this.#state.topicFilter.length > 0) {
        this.#state = setTopicFilter(this.#state, "");
        this.#queueRender();
        return;
      }
      if (this.#state.topicPickerRoot) this.#requestExit();
      else {
        this.#state = { ...this.#state, overlay: null };
        this.#queueRender();
      }
      return;
    }
    const typed = topicFilterInsertion(chunk);
    if (typed === null) return;
    this.#state = appendTopicFilter(this.#state, typed);
    this.#queueRender();
  }

  #openNewTopicComposer(): void {
    this.#state = startTopicCreation(this.#state);
    this.#replaceInput("");
  }

  async #createTopic(title: string): Promise<void> {
    const topicPickerRoot = this.#state.topicPickerRoot;
    try {
      const created = await this.#client.createTopic(title, this.#options.defaultAgent);
      this.#state = focusCreatedTopic(this.#state, created);
      await this.#refreshTopics(created.title);
      this.#selectTopicKeepingDrafts(created.id);
      await this.#loadActiveMessages();
      this.#state = { ...this.#state, notice: `Created ${created.title}`, noticeLevel: "success" };
    } catch (error) {
      const failed: AppState = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
      this.#state = topicPickerRoot ? openTopicPicker(failed, failed.notice, true) : failed;
    }
    this.#queueRender();
  }

  async #deriveTopic(topic: TopicDto, copyHistory: boolean, name?: string): Promise<void> {
    try {
      const derived = await this.#client.deriveTopic(topic, copyHistory, name);
      this.#state = focusCreatedTopic(this.#state, derived);
      await this.#refreshTopics(derived.title);
      this.#selectTopicKeepingDrafts(derived.id);
      await this.#loadActiveMessages();
      this.#state = {
        ...this.#state,
        notice: copyHistory ? `forked into "${derived.title}"` : `spawned "${derived.title}"`,
        noticeLevel: "success",
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  #moveTopicPicker(delta: number): void {
    this.#state = moveTopicPickerSelection(this.#state, delta);
    this.#queueRender();
  }

  #moveVaultPicker(delta: number): void {
    if (this.#state.vaultEntries.length === 0) return;
    this.#state = {
      ...this.#state,
      vaultPickerIndex: Math.min(
        this.#state.vaultEntries.length - 1,
        Math.max(0, this.#state.vaultPickerIndex + delta),
      ),
    };
    this.#queueRender();
  }

  #selectPickedTopic(): void {
    const background = pickedBackgroundSession(this.#state);
    if (background) {
      this.#state = {
        ...this.#state,
        overlay: "background-session",
        backgroundScrollOffset: 0,
        notice: undefined,
        noticeLevel: undefined,
      };
      this.#queueRender();
      return;
    }
    const topic = pickedTopic(this.#state);
    if (topic) void this.#activateTopic(topic.id);
  }

  #moveModelPicker(delta: number): void {
    const count = SELECTABLE_MODELS.length;
    if (count === 0) return;
    this.#state = {
      ...this.#state,
      modelPickerIndex: (this.#state.modelPickerIndex + delta + count) % count,
    };
    this.#queueRender();
  }

  async #openVault(vaultNotice?: string): Promise<void> {
    if (!this.#client.listVaultEntries || !this.#client.runVaultCommand) {
      this.#state = {
        ...this.#state,
        notice: "Vault management is unavailable for this client.",
        noticeLevel: "warn",
      };
      this.#queueRender();
      return;
    }
    try {
      const entries = await this.#client.listVaultEntries();
      this.#vaultDraftValue = "";
      this.#state = {
        ...this.#state,
        overlay: "vault",
        notice: undefined,
        noticeLevel: undefined,
        vaultEntries: entries,
        vaultPickerIndex: Math.min(this.#state.vaultPickerIndex, Math.max(0, entries.length - 1)),
        vaultMode: "list",
        vaultDraftKey: undefined,
        vaultDraftDescription: "",
        vaultEditing: false,
        vaultNotice,
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  /**
   * Jump straight to the Vault "paste the secret" step for `key`, skipping
   * the key-name prompt. Used when a model switch fails auth so the user
   * isn't left staring at a bare error — they land directly on the form for
   * the exact credential that's missing.
   */
  async #openVaultForKey(key: string, notice: string): Promise<void> {
    if (!this.#client.listVaultEntries || !this.#client.saveVaultEntry) {
      this.#pendingModelSwitch = undefined;
      this.#state = { ...this.#state, notice, noticeLevel: "info" };
      this.#queueRender();
      return;
    }
    try {
      const entries = await this.#client.listVaultEntries();
      this.#vaultDraftValue = "";
      this.#state = {
        ...this.#state,
        overlay: "vault",
        notice: undefined,
        noticeLevel: undefined,
        vaultEntries: entries,
        vaultPickerIndex: Math.min(this.#state.vaultPickerIndex, Math.max(0, entries.length - 1)),
        vaultMode: "value",
        vaultDraftKey: key,
        vaultDraftDescription: "",
        vaultEditing: false,
        vaultNotice: notice,
      };
      this.#replaceInput("");
    } catch (error) {
      this.#pendingModelSwitch = undefined;
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  #handleVaultListInput(chunk: string): void {
    if (this.#state.vaultMode === "confirm-delete") {
      const key = chunk.toLowerCase();
      if (CONFIRM_KEYS.has(key)) void this.#deleteSelectedVaultEntry();
      else if (CANCEL_KEYS.has(key) || chunk === "\u001b") {
        this.#state = { ...this.#state, vaultMode: "list", vaultNotice: undefined };
        this.#queueRender();
      }
      return;
    }

    if (chunk === "\u001b") {
      this.#vaultDraftValue = "";
      this.#pendingModelSwitch = undefined;
      this.#state = { ...this.#state, overlay: null, vaultNotice: undefined };
      this.#queueRender();
    }
  }

  #cancelVaultForm(): void {
    this.#vaultDraftValue = "";
    this.#pendingModelSwitch = undefined;
    this.#input.setText("");
    this.#syncInput();
    this.#state = {
      ...this.#state,
      vaultMode: "list",
      vaultDraftKey: undefined,
      vaultDraftDescription: "",
      vaultEditing: false,
      vaultNotice: undefined,
    };
    this.#queueRender();
  }

  async #submitVaultField(): Promise<void> {
    const raw = this.#input.text;
    if (this.#state.vaultMode === "key") {
      const key = normalizeVaultKey(raw);
      if (!validateVaultKey(key)) {
        this.#state = {
          ...this.#state,
          vaultNotice: "Use A-Z, 0-9, and _. The key must start with a letter.",
        };
        this.#queueRender();
        return;
      }
      if (this.#state.vaultEntries.some((entry) => entry.key === key)) {
        this.#state = {
          ...this.#state,
          vaultNotice: `${key} already exists. Select it to update.`,
        };
        this.#queueRender();
        return;
      }
      this.#state = {
        ...this.#state,
        vaultMode: "value",
        vaultDraftKey: key,
        vaultNotice: undefined,
      };
      this.#replaceInput("");
      return;
    }

    if (this.#state.vaultMode === "value") {
      const valueBytes = Buffer.byteLength(raw, "utf8");
      if (valueBytes < VAULT_VALUE_MIN_BYTES || valueBytes > VAULT_VALUE_MAX_BYTES) {
        this.#state = {
          ...this.#state,
          vaultNotice: `Secret must be ${VAULT_VALUE_MIN_BYTES}-${VAULT_VALUE_MAX_BYTES} bytes.`,
        };
        this.#queueRender();
        return;
      }
      this.#vaultDraftValue = raw;
      this.#state = { ...this.#state, vaultMode: "description", vaultNotice: undefined };
      this.#replaceInput(this.#state.vaultDraftDescription);
      return;
    }

    if (raw.length > VAULT_DESCRIPTION_MAX_LENGTH) {
      this.#state = {
        ...this.#state,
        vaultNotice: `Description must not exceed ${VAULT_DESCRIPTION_MAX_LENGTH} characters.`,
      };
      this.#queueRender();
      return;
    }
    const key = this.#state.vaultDraftKey;
    if (!key || !this.#client.saveVaultEntry) return;

    this.#input.setText("");
    this.#syncInput();
    const pending = this.#pendingModelSwitch;
    try {
      const result = await this.#client.saveVaultEntry(key, this.#vaultDraftValue, raw);
      this.#vaultDraftValue = "";

      // If this key was saved to unblock a model switch (see
      // `#selectPickedModel`), retry that switch right away instead of
      // leaving the user back on the Vault list to redo it manually.
      if (pending && maestroVaultKeyForModel(pending.model) === result.key) {
        this.#pendingModelSwitch = undefined;
        const topic = this.#state.topics.find((candidate) => candidate.id === pending.topicId);
        if (topic) {
          try {
            const notice = await this.#client.setModel(topic, pending.model);
            await this.#refreshTopics(topic.title);
            this.#state = {
              ...this.#state,
              overlay: null,
              vaultNotice: undefined,
              notice,
              noticeLevel: "success",
            };
            this.#queueRender();
            return;
          } catch (error) {
            this.#state = {
              ...this.#state,
              overlay: null,
              vaultNotice: undefined,
              notice: error instanceof Error ? error.message : String(error),
              noticeLevel: "error",
            };
            this.#queueRender();
            return;
          }
        }
      }

      const entries = this.#client.listVaultEntries ? await this.#client.listVaultEntries() : [];
      const selectedIndex = Math.max(
        0,
        entries.findIndex((entry) => entry.key === result.key),
      );
      this.#state = {
        ...this.#state,
        vaultEntries: entries,
        vaultPickerIndex: selectedIndex,
        vaultMode: "list",
        vaultDraftKey: undefined,
        vaultDraftDescription: "",
        vaultEditing: false,
        vaultNotice: `${result.updated ? "Updated" : "Added"} ${result.key}.`,
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        vaultMode: "list",
        vaultNotice: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.#vaultDraftValue = "";
    }
    this.#queueRender();
  }

  async #submitVaultRequest(): Promise<void> {
    const request = activeVaultRequest(this.#state);
    if (!request?.vaultSecretRequest) return;
    if (this.#state.vaultRequestSubmitting) return;
    // A paste's trailing newline is almost never part of the secret; a secret
    // that legitimately is a multi-line PEM keeps every other newline.
    const raw = this.#input.text.replace(/\r?\n$/, "");
    const valueBytes = Buffer.byteLength(raw, "utf8");
    if (valueBytes < VAULT_VALUE_MIN_BYTES || valueBytes > VAULT_VALUE_MAX_BYTES) {
      this.#state = {
        ...this.#state,
        vaultRequestNotice: raw.length
          ? `Value must be ${VAULT_VALUE_MIN_BYTES}-${VAULT_VALUE_MAX_BYTES} bytes.`
          : "Type the value, or press Esc to decline.",
      };
      this.#queueRender();
      return;
    }
    await this.#answerVaultRequest(raw);
  }

  /** `value: null` declines. Shared by both the submit-with-text and y/n-decline paths. */
  async #answerVaultRequest(value: string | null): Promise<void> {
    const request = activeVaultRequest(this.#state);
    if (!request) return;
    this.#state = { ...this.#state, vaultRequestSubmitting: true };
    this.#queueRender();
    try {
      const result = await this.#client.answerVaultRequest(request.topicId, request.id, value);
      if (result.ok) {
        // Kept on failure (e.g. a transient network error) so the user can
        // just press Enter again instead of retyping a 40-character secret.
        this.#input.setText("");
        this.#syncInput();
      }
      this.#state = {
        ...this.#state,
        vaultRequestMode: "value",
        vaultRequestSubmitting: false,
        vaultRequestNotice: result.ok ? undefined : result.error,
        notice: result.ok
          ? value === null
            ? `Declined ${request.vaultSecretRequest?.key} — the agent was told`
            : `✓ Saved ${request.vaultSecretRequest?.key} to Vault`
          : this.#state.notice,
        noticeLevel: result.ok ? (value === null ? "info" : "success") : this.#state.noticeLevel,
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        vaultRequestSubmitting: false,
        vaultRequestNotice: error instanceof Error ? error.message : String(error),
      };
    }
    this.#queueRender();
  }

  async #deleteSelectedVaultEntry(): Promise<void> {
    const selected = this.#state.vaultEntries[this.#state.vaultPickerIndex];
    if (!selected || !this.#client.deleteVaultEntry) return;
    try {
      const deleted = await this.#client.deleteVaultEntry(selected.key);
      const entries = this.#client.listVaultEntries ? await this.#client.listVaultEntries() : [];
      this.#state = {
        ...this.#state,
        vaultEntries: entries,
        vaultPickerIndex: Math.min(this.#state.vaultPickerIndex, Math.max(0, entries.length - 1)),
        vaultMode: "list",
        vaultNotice: deleted ? `Deleted ${selected.key}.` : `${selected.key} no longer exists.`,
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        vaultMode: "list",
        vaultNotice: error instanceof Error ? error.message : String(error),
      };
    }
    this.#queueRender();
  }

  async #selectPickedModel(): Promise<void> {
    const topic = activeTopic(this.#state);
    const selected = SELECTABLE_MODELS[this.#state.modelPickerIndex];
    if (!topic || !selected) return;
    this.#state = {
      ...this.#state,
      overlay: null,
      notice: `Switching to ${selected.model}…`,
      noticeLevel: "info",
    };
    this.#queueRender();
    try {
      const notice = await this.#client.setModel(topic, selected.model);
      await this.#refreshTopics(topic.title);
      this.#state = { ...this.#state, notice, noticeLevel: "success" };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const vaultKey = maestroVaultKeyForModel(selected.model);
      if (vaultKey && /not authenticated/i.test(message)) {
        this.#pendingModelSwitch = { topicId: topic.id, model: selected.model };
        await this.#openVaultForKey(
          vaultKey,
          `${selected.model} needs ${vaultKey}. Paste the key below to continue.`,
        );
        return;
      }
      this.#state = { ...this.#state, notice: message, noticeLevel: "error" };
    }
    this.#queueRender();
  }

  #moveEffortPicker(delta: number): void {
    const count = selectableEfforts(activeTopic(this.#state)).length;
    this.#state = {
      ...this.#state,
      effortPickerIndex: (this.#state.effortPickerIndex + delta + count) % count,
    };
    this.#queueRender();
  }

  async #selectPickedEffort(): Promise<void> {
    const topic = activeTopic(this.#state);
    const effort = selectableEfforts(topic)[this.#state.effortPickerIndex];
    if (!topic || !effort) return;
    this.#state = {
      ...this.#state,
      overlay: null,
      notice: `Setting effort to ${effort}…`,
      noticeLevel: "info",
    };
    this.#queueRender();
    try {
      const notice = await this.#client.setEffort(topic, effort);
      await this.#refreshTopics(topic.title);
      this.#state = { ...this.#state, notice, noticeLevel: "success" };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  #pathItems(): PathSuggestion[] {
    const cursor = this.#input.cursor;
    const lineText = this.#input.text.split("\n")[cursor.row] ?? "";
    return pathSuggestions(lineText, cursor.col)?.items ?? [];
  }

  /** Active suggestion count: slash commands take precedence over `@` paths. */
  #suggestionCount(): number {
    const commands = commandSuggestions(this.#input.text).length;
    return commands > 0 ? commands : this.#pathItems().length;
  }

  /** Apply the highlighted path suggestion. Returns false when nothing changed. */
  #applyPathCompletion(keepTrigger: boolean): boolean {
    const items = this.#pathItems();
    if (items.length === 0) return false;
    const cursor = this.#input.cursor;
    const lines = this.#input.text.split("\n");
    const lineText = lines[cursor.row] ?? "";
    const selected = items[(this.#state.suggestionIndex + items.length) % items.length];
    const result = completePathToken(lineText, cursor.col, selected, { keepTrigger });
    if (!result) return false;
    // No-op: the token already equals the selected path (e.g. a completed leaf).
    if (result.line === lineText && result.col === cursor.col) return false;
    lines[cursor.row] = result.line;
    this.#input.setText(lines.join("\n"), { row: cursor.row, col: result.col });
    this.#syncInput();
    this.#queueRender();
    return true;
  }

  #moveSuggestion(delta: number): void {
    const count = this.#suggestionCount();
    if (count === 0) return;
    this.#state = {
      ...this.#state,
      suggestionIndex: (this.#state.suggestionIndex + delta + count) % count,
    };
    this.#queueRender();
  }

  #requestTopicDelete(topic: AppState["topics"][number] | undefined): void {
    if (!topic) return;
    if (topic.kind === "manager") {
      const notice = "Manager topics cannot be deleted";
      this.#state = this.#state.topicPickerRoot
        ? openTopicPicker(this.#state, notice, true, "warn")
        : { ...this.#state, overlay: null, notice, noticeLevel: "warn" };
      this.#queueRender();
      return;
    }
    this.#state = {
      ...this.#state,
      overlay: "confirm-delete",
      pendingDeleteTopicId: topic.id,
    };
    this.#queueRender();
  }

  async #confirmTopicDelete(): Promise<void> {
    const topicPickerRoot = this.#state.topicPickerRoot;
    const topic = this.#state.topics.find(
      (candidate) => candidate.id === this.#state.pendingDeleteTopicId,
    );
    if (!topic) {
      const missing = { ...this.#state, overlay: null, pendingDeleteTopicId: undefined };
      this.#state = topicPickerRoot ? openTopicPicker(missing, undefined, true) : missing;
      this.#queueRender();
      return;
    }
    this.#state = {
      ...this.#state,
      overlay: null,
      pendingDeleteTopicId: undefined,
      notice: `Deleting ${topic.title}…`,
      noticeLevel: "info",
    };
    this.#queueRender();
    try {
      await this.#client.deleteTopic(topic);
      await this.#refreshTopics();
      this.#state = openTopicPicker(
        this.#state,
        `Deleted ${topic.title}`,
        topicPickerRoot,
        "success",
      );
      if (!topicPickerRoot) await this.#loadActiveMessages();
    } catch (error) {
      const failed: AppState = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
      this.#state = topicPickerRoot ? openTopicPicker(failed, failed.notice, true) : failed;
    }
    this.#queueRender();
  }

  async #copy(): Promise<void> {
    const text = activeMessages(this.#state)
      .slice()
      .reverse()
      .find((message) => message.authorId === "ai" && message.text.trim())?.text;
    if (!text) {
      this.#state = {
        ...this.#state,
        notice: "No agent response to copy",
        noticeLevel: "warn",
      };
      this.#queueRender();
      return;
    }
    try {
      const result = await copyToClipboard(text);
      this.#state = {
        ...this.#state,
        notice: `Last response copied via ${result.method}${result.truncated ? " (truncated)" : ""}`,
        noticeLevel: "success",
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  /**
   * Routes each wheel tick by screen position: one landing on the Topics or
   * Tasks panel scrolls that panel; everything else is handed back for the
   * caller to apply exactly as before (main conversation scroll / graph
   * pan). The side panel has no "fallback" path through `#scroll` — it is
   * client-only presentation state, so it is scrolled directly here.
   */
  #routeWheelEvents(events: WheelEvent[]): { scrollDelta: number; horizontalScrollDelta: number } {
    let scrollDelta = 0;
    let horizontalScrollDelta = 0;
    if (events.length === 0) return { scrollDelta, horizontalScrollDelta };
    const bounds = this.#sideColumnBounds;
    const pane = this.#terminalPane;
    let touchedPanel = false;
    for (const event of events) {
      if (
        pane &&
        this.#shell &&
        event.x >= pane.xStart &&
        event.x <= pane.xEnd &&
        !event.horizontal
      ) {
        this.#shell.scroll(event.delta);
        touchedPanel = true;
        continue;
      }
      const section =
        bounds && event.x >= bounds.xStart && event.x <= bounds.xEnd
          ? bounds.sections.find((s) => event.y >= s.yStart && event.y <= s.yEnd)
          : undefined;
      if (!section) {
        if (event.horizontal) horizontalScrollDelta += event.delta;
        else scrollDelta += event.delta;
        continue;
      }
      touchedPanel = true;
      const columns = process.stdout.columns ?? 100;
      const rows = process.stdout.rows ?? 30;
      // Same sign flip as `#scroll`'s overlay cases: a wheel-up tick (positive
      // `delta`) moves the panel's own view toward its top, i.e. a smaller
      // offset, the opposite of how the conversation's offset grows upward.
      this.#state =
        section.panel === "topics"
          ? scrollTopicsPanel(
              this.#state,
              -event.delta,
              maxTopicsPanelScrollOffset(this.#state, columns, rows),
            )
          : scrollTaskPanel(
              this.#state,
              -event.delta,
              maxTaskPanelScrollOffset(this.#state, columns, rows),
            );
    }
    if (touchedPanel) this.#queueRender();
    return { scrollDelta, horizontalScrollDelta };
  }

  /**
   * Ctrl-T: open the shell pane with a fresh shell, or close it. Closing ends
   * the shell too (same as typing `exit`) — nothing keeps running unseen.
   */
  #toggleTerminalPane(): void {
    if (this.#state.terminalPaneOpen) {
      const shell = this.#shell;
      this.#shell = null;
      shell?.dispose();
      this.#state = closeTerminalPane(this.#state);
      this.#queueRender();
      return;
    }
    if (!this.#shell) {
      if (!ptySupport()) {
        this.#state = {
          ...this.#state,
          notice: "Shell pane needs Bun >= 1.3.5 (bun upgrade)",
          noticeLevel: "warn",
        };
        this.#queueRender();
        return;
      }
      try {
        const columns = process.stdout.columns ?? 100;
        const rows = process.stdout.rows ?? 30;
        const shell: ShellPane = new ShellPane({
          cols: Math.max(30, Math.floor(columns * 0.3)),
          rows: Math.max(1, rows),
          cwd: process.cwd(),
          onChange: () => this.#queueRender(),
          onExit: () => {
            if (this.#shell !== shell) return;
            this.#shell = null;
            this.#state = {
              ...closeTerminalPane(this.#state),
              notice: "Shell exited",
              noticeLevel: "info",
            };
            this.#queueRender();
          },
        });
        this.#shell = shell;
      } catch (error) {
        this.#state = {
          ...this.#state,
          notice: `Shell pane failed: ${error instanceof Error ? error.message : String(error)}`,
          noticeLevel: "error",
        };
        this.#queueRender();
        return;
      }
    }
    this.#state = openTerminalPane(this.#state);
    const columns = process.stdout.columns ?? 100;
    if (maxTerminalPaneWidth(this.#state, columns) < 30 || columns < 92) {
      this.#state = {
        ...this.#state,
        notice: "Window too narrow for the shell pane — widen it to see the pane",
        noticeLevel: "warn",
      };
    }
    this.#queueRender();
  }

  /** A press inside the shell pane gives it the keyboard; a press anywhere else takes it back. */
  #focusPaneUnderPress(event: TerminalMouseEvent): void {
    if (event.kind !== "press" || (event.button & 3) !== 0) return;
    const pane = this.#terminalPane;
    const inside = !!pane && event.x >= pane.xStart && event.x <= pane.xEnd;
    const next = focusTerminalPane(this.#state, inside && !!this.#shell);
    if (next !== this.#state) {
      this.#state = next;
      this.#queueRender();
    }
  }

  /**
   * Press-and-drag on the side column's right border to resize it, herdr's
   * own draggable sidebar. Checked ahead of the scrollbar/pickable-row
   * handlers since the border sits right against the panel's own last
   * column, and ahead of plain text selection so a border grab never starts
   * one instead.
   */
  #handleSidePanelResizeDrag(event: TerminalMouseEvent): boolean {
    if (event.kind === "press" && (event.button & 3) === 0) {
      const pane = this.#terminalPane;
      if (pane && event.x === pane.dividerX && event.y >= pane.yStart && event.y <= pane.yEnd) {
        this.#sidePanelResizeDrag = { target: "terminal", startX: event.x, startWidth: pane.cols };
        return true;
      }
      const handle = this.#sidePanelResizeHandle;
      if (
        !handle ||
        event.x < handle.xStart ||
        event.x > handle.xEnd ||
        event.y < handle.yStart ||
        event.y > handle.yEnd
      ) {
        // A fresh press starts a new gesture regardless of where it lands —
        // clearing any drag left over from a release this tracker never saw
        // (a mouse protocol can drop one) keeps it from hijacking this and
        // every later gesture as a resize, which read as a multi-line text
        // selection getting "stuck" extending only the panel border.
        this.#sidePanelResizeDrag = null;
        return false;
      }
      this.#sidePanelResizeDrag = {
        target: "side",
        startX: event.x,
        startWidth: this.#state.sidePanelWidth,
      };
      return true;
    }
    const drag = this.#sidePanelResizeDrag;
    if (!drag) return false;
    if (event.kind === "release") {
      this.#sidePanelResizeDrag = null;
      return true;
    }
    const columns = process.stdout.columns ?? 100;
    if (drag.target === "terminal") {
      // The shell pane's divider is on its *left*, so dragging left widens it.
      const nextWidth = drag.startWidth - (event.x - drag.startX);
      this.#state = setTerminalPaneWidth(
        this.#state,
        nextWidth,
        maxTerminalPaneWidth(this.#state, columns),
      );
      this.#queueRender();
      return true;
    }
    const nextWidth = drag.startWidth + (event.x - drag.startX);
    this.#state = setSidePanelWidth(this.#state, nextWidth, maxSidePanelWidth(columns));
    this.#queueRender();
    return true;
  }

  /**
   * Press-and-drag on a panel's scrollbar thumb, following herdr's own
   * scrollbar interaction (`scrollbar_offset_from_drag_row` in
   * `src/client/shell/mouse.rs`): grabbing anywhere on the thumb remembers
   * the offset within it, so the thumb does not jump to re-center under the
   * cursor on the first drag frame. Returns whether the event was consumed.
   */
  #handleSidePanelScrollbarDrag(event: TerminalMouseEvent): boolean {
    if (event.kind === "press" && (event.button & 3) === 0) {
      const track = this.#sidePanelTracks.find(
        (t) => event.x === t.x && event.y >= t.yStart && event.y < t.yStart + t.viewportRows,
      );
      if (!track) {
        // Same reasoning as `#handleSidePanelResizeDrag`: never let a stale
        // drag outlive the gesture that started it.
        this.#sidePanelDrag = null;
        return false;
      }
      const current =
        track.panel === "topics"
          ? this.#state.topicsPanelScrollOffset
          : this.#state.taskPanelScrollOffset;
      const thumb = scrollbarThumb(track.rowCount, track.viewportRows, current);
      this.#sidePanelDrag = {
        panel: track.panel,
        track,
        grabRowOffset: event.y - (track.yStart + thumb.top),
      };
      return true;
    }
    const drag = this.#sidePanelDrag;
    if (!drag) return false;
    if (event.kind === "release") {
      this.#sidePanelDrag = null;
      return true;
    }
    const { track, grabRowOffset, panel } = drag;
    const offset = scrollOffsetFromDragRow(
      track.rowCount,
      track.viewportRows,
      event.y - track.yStart,
      grabRowOffset,
    );
    const columns = process.stdout.columns ?? 100;
    const rows = process.stdout.rows ?? 30;
    this.#state =
      panel === "topics"
        ? setTopicsPanelScrollOffset(
            this.#state,
            offset,
            maxTopicsPanelScrollOffset(this.#state, columns, rows),
          )
        : setTaskPanelScrollOffset(
            this.#state,
            offset,
            maxTaskPanelScrollOffset(this.#state, columns, rows),
          );
    this.#queueRender();
    return true;
  }

  /**
   * Handles a mouse event against either the `Ctrl-O` overlay's rows or the
   * always-visible Topics panel's rows — both populate the same
   * `topicPickerTargets` array (see render.ts's `pickerTarget` metadata),
   * but they drive different state: the overlay moves its own
   * keyboard-cursor fields (`topicPickerIndex` / `topicPickerBackgroundId`)
   * and opens on click or Enter, while the panel has only one topic active
   * at a time, so it switches straight to the clicked topic and tracks
   * hover in `sidePanelHoverTopicId` — separate from the overlay's cursor —
   * so moving the mouse over the panel while chatting never disturbs where
   * `Ctrl-O` will reopen.
   *
   * Returns whether the event was consumed; `false` lets the caller fall
   * through to normal text selection when the point is not on a pickable row.
   */
  #handlePickableRowMouse(event: TerminalMouseEvent): boolean {
    const inOverlay = this.#state.overlay === "topics";
    const hovering = event.kind === "drag" && (event.button & 3) === 3;
    const isClick = event.kind === "press" && (event.button & 3) === 0;
    if (!inOverlay && !hovering && !isClick) return false;
    const target = topicPickerTargetAt(this.#topicPickerTargets, { x: event.x, y: event.y });
    if (inOverlay) {
      if (!target) return true; // nothing under the cursor inside the overlay, still consumed
      const highlighted = this.#highlightPickedTarget(target);
      if (!hovering && highlighted) this.#selectPickedTopic();
      return true;
    }
    // The panel's background-session rows open the same read-only viewport a
    // click in the overlay does, but there is no overlay-cursor highlight
    // step to go through first — the click already names the session.
    if (target?.backgroundSessionId !== undefined) {
      const sessionId = target.backgroundSessionId;
      if (hovering) {
        this.#setSidePanelHover(undefined, sessionId);
        return true;
      }
      this.#setSidePanelHover(undefined, undefined);
      this.#state = {
        ...this.#state,
        overlay: "background-session",
        topicPickerBackgroundId: sessionId,
        backgroundScrollOffset: 0,
        notice: undefined,
        noticeLevel: undefined,
      };
      this.#queueRender();
      return true;
    }
    if (target?.topicIndex === undefined) {
      this.#setSidePanelHover(undefined, undefined);
      return false;
    }
    const topic = this.#state.topics[target.topicIndex];
    if (!topic) return false;
    if (hovering) {
      this.#setSidePanelHover(topic.id, undefined);
      return true;
    }
    this.#setSidePanelHover(undefined, undefined);
    if (topic.id !== this.#state.activeTopicId) void this.#activateTopic(topic.id);
    return true;
  }

  /** Updates the panel's hover highlight, re-rendering only when it actually changes. */
  #setSidePanelHover(topicId: string | undefined, backgroundSessionId: string | undefined): void {
    if (
      this.#state.sidePanelHoverTopicId === topicId &&
      this.#state.sidePanelHoverBackgroundSessionId === backgroundSessionId
    ) {
      return;
    }
    this.#state = {
      ...this.#state,
      sidePanelHoverTopicId: topicId,
      sidePanelHoverBackgroundSessionId: backgroundSessionId,
    };
    this.#queueRender();
  }

  /** Moves the Ctrl-O overlay's own highlight to `target`; returns whether it moved. */
  #highlightPickedTarget(target: TopicPickerTarget): boolean {
    if (target.backgroundSessionId !== undefined) {
      if (this.#state.topicPickerBackgroundId === target.backgroundSessionId) return true;
      this.#state = { ...this.#state, topicPickerBackgroundId: target.backgroundSessionId };
    } else if (target.topicIndex !== undefined) {
      if (
        !this.#state.topicPickerBackgroundId &&
        this.#state.topicPickerIndex === target.topicIndex
      ) {
        return true;
      }
      this.#state = {
        ...this.#state,
        topicPickerIndex: target.topicIndex,
        topicPickerBackgroundId: undefined,
      };
    } else {
      return false;
    }
    this.#queueRender();
    return true;
  }

  #handleMouseSelection(event: TerminalMouseEvent): void {
    if ((event.button & 3) !== 0 && event.kind !== "release") return;
    if (event.kind === "press") {
      const point: ScreenPoint = { x: event.x, y: event.y };
      const codeTarget = codeCopyTargetAt(this.#codeCopyTargets, point);
      if (codeTarget) {
        this.#selection = null;
        void this.#copyCodeBlock(codeTarget.text);
        return;
      }
      // Confine the whole drag to whichever pane it started in — the side
      // Topics/Tasks column, or the conversation — so a drag that only ever
      // touched one of them never pulls text out of the other.
      const bounds = this.#sideColumnBounds;
      const pane = this.#terminalPane;
      const conversation = this.#conversationBounds;
      const paneClip =
        bounds && point.x >= bounds.xStart && point.x <= bounds.xEnd
          ? { xStart: bounds.xStart, xEnd: bounds.xEnd }
          : pane && point.x >= pane.xStart && point.x <= pane.xEnd
            ? { xStart: pane.xStart, xEnd: pane.xEnd }
            : (bounds || pane) && conversation
              ? { xStart: conversation.xStart, xEnd: conversation.xEnd }
              : undefined;
      this.#selection = { anchor: point, focus: point, paneClip };
      this.#selectionDragging = true;
      this.#queueRender();
      return;
    }
    if (event.kind === "release") this.#selectionDragging = false;
    if (!this.#selection) return;
    // The real mouse position is tracked as-is — clamping it to the clip
    // range used to make the drag feel stuck right at the pane border,
    // since the recorded focus point (and therefore which rows count as
    // "in range") could no longer move past it. `screenSelectionText`/
    // `highlightScreenSelection` already clip each row to `paneClip`, which
    // is enough on its own to keep the pane the drag didn't start in out of
    // both the highlight and the copied text.
    this.#selection = { ...this.#selection, focus: { x: event.x, y: event.y } };
    if (event.kind === "drag") {
      this.#queueRender();
      return;
    }

    const selection = this.#selection;
    if (selection.anchor.x === selection.focus.x && selection.anchor.y === selection.focus.y) {
      this.#selection = null;
      this.#queueRender();
      return;
    }
    const text = screenSelectionText(this.#plainFrameLines, selection);
    if (!text) {
      this.#selection = null;
      this.#queueRender();
      return;
    }
    void this.#copySelection(text);
    this.#queueRender();
  }

  #handleGraphMouse(event: TerminalMouseEvent): void {
    if ((event.button & 3) !== 0 && event.kind !== "release") return;
    const point: ScreenPoint = { x: event.x, y: event.y };
    if (event.kind === "press") {
      this.#selection = null;
      this.#subagentGraphDragPoint = point;
      return;
    }
    if (event.kind === "release") {
      this.#subagentGraphDragPoint = null;
      return;
    }
    const previous = this.#subagentGraphDragPoint;
    this.#subagentGraphDragPoint = point;
    if (!previous) return;
    this.#panActiveGraph(previous.x - point.x, previous.y - point.y);
  }

  async #copySelection(text: string): Promise<void> {
    try {
      const result = await copyToClipboard(text);
      this.#state = {
        ...this.#state,
        notice: `Selection copied via ${result.method}${result.truncated ? " (truncated)" : ""}`,
        noticeLevel: "success",
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  async #copyCodeBlock(text: string): Promise<void> {
    try {
      const result = await copyToClipboard(text);
      this.#state = {
        ...this.#state,
        notice: `Code block copied via ${result.method}${result.truncated ? " (truncated)" : ""}`,
        noticeLevel: "success",
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
        noticeLevel: "error",
      };
    }
    this.#queueRender();
  }

  #moveAskChoice(delta: number): void {
    const choices = activeQuestion(this.#state)?.askUserQuestion?.choices;
    if (!choices?.length) return;
    const next = (this.#state.askChoiceIndex + delta + choices.length) % choices.length;
    this.#state = { ...this.#state, askChoiceIndex: next };
    this.#queueRender();
  }

  #loadOlderHistory(): void {
    const topic = activeTopic(this.#state);
    if (!topic || !this.#client.listMessagePage) return;
    const history = this.#messageHistory.get(topic.id);
    if (!history || history.loading) return;
    if (!history.hasMore || !history.cursor) {
      this.#state = { ...this.#state, notice: "Start of conversation", noticeLevel: "info" };
      this.#queueRender();
      return;
    }

    const currentMax = maxConversationScrollOffset(
      this.#state,
      process.stdout.columns ?? 100,
      process.stdout.rows ?? 30,
    );
    this.#state = { ...this.#state, scrollOffset: currentMax };
    void this.#loadOlderMessages(topic.id, currentMax + 8);
  }

  #scroll(delta: number): void {
    if (this.#state.overlay === "subagents" || this.#state.overlay === "decisions") {
      this.#panActiveGraph(0, -delta);
      return;
    }
    if (this.#state.overlay === "vault" && this.#state.vaultMode === "list") {
      // Same sign as the arrow keys: a wheel-up tick (positive delta, same
      // direction as PageUp below) moves the selection toward the top of
      // the list, not into the hidden conversation behind the overlay.
      this.#moveVaultPicker(-delta);
      return;
    }
    if (this.#state.overlay === "background-session") {
      const maxOffset = maxConversationScrollOffset(
        this.#state,
        process.stdout.columns ?? 100,
        process.stdout.rows ?? 30,
      );
      this.#state = {
        ...this.#state,
        backgroundScrollOffset: Math.min(
          maxOffset,
          Math.max(0, this.#state.backgroundScrollOffset + delta),
        ),
      };
      this.#queueRender();
      return;
    }
    const maxOffset = maxConversationScrollOffset(
      this.#state,
      process.stdout.columns ?? 100,
      process.stdout.rows ?? 30,
    );
    const desiredOffset = this.#state.scrollOffset + delta;
    this.#state = {
      ...this.#state,
      scrollOffset: Math.min(maxOffset, Math.max(0, desiredOffset)),
    };
    this.#queueRender();
  }

  #panSubagentGraph(deltaX: number, deltaY: number): void {
    const canvas = this.#state.subagentGraph;
    const viewportWidth = Math.max(1, (process.stdout.columns ?? 100) - 4);
    const viewportHeight = Math.max(1, (process.stdout.rows ?? 30) - 8);
    const current = this.#state.subagentGraphOffset;
    this.#state = {
      ...this.#state,
      subagentGraphOffset: {
        x: Math.min(
          Math.max(0, (canvas?.width ?? 0) - viewportWidth),
          Math.max(0, current.x + deltaX),
        ),
        y: Math.min(
          Math.max(0, (canvas?.height ?? 0) - viewportHeight),
          Math.max(0, current.y + deltaY),
        ),
      },
    };
    this.#queueRender();
  }

  #panDecisionGraph(deltaX: number, deltaY: number): void {
    const canvas = this.#state.decisionGraph;
    const viewportWidth = Math.max(1, (process.stdout.columns ?? 100) - 4);
    const viewportHeight = Math.max(1, (process.stdout.rows ?? 30) - 8);
    const current = this.#state.decisionGraphOffset;
    this.#state = {
      ...this.#state,
      decisionGraphOffset: {
        x: Math.min(
          Math.max(0, (canvas?.width ?? 0) - viewportWidth),
          Math.max(0, current.x + deltaX),
        ),
        y: Math.min(
          Math.max(0, (canvas?.height ?? 0) - viewportHeight),
          Math.max(0, current.y + deltaY),
        ),
      },
    };
    this.#queueRender();
  }

  #panActiveGraph(deltaX: number, deltaY: number): void {
    if (this.#state.overlay === "decisions") this.#panDecisionGraph(deltaX, deltaY);
    else this.#panSubagentGraph(deltaX, deltaY);
  }

  async #abort(): Promise<void> {
    const topic = activeTopic(this.#state);
    let aborted = false;
    try {
      aborted = topic ? await this.#client.abort(topic.id) : false;
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
        noticeLevel: "error",
      };
      this.#queueRender();
      return;
    }
    this.#state = {
      ...this.#state,
      notice: aborted ? "Turn aborted" : "Nothing is running",
      noticeLevel: "info",
    };
    this.#queueRender();
  }

  #handleInterrupt(): void {
    if (ctrlCExitsTopicPicker(this.#state)) {
      this.#requestExit();
      return;
    }
    if (this.#state.topicPickerRoot && this.#state.creatingTopic) {
      this.#lastInterruptAt = 0;
      this.#input.setText("");
      this.#history.reset();
      this.#syncInput();
      this.#state = openTopicPicker(this.#state, undefined, true);
      this.#queueRender();
      return;
    }
    const topic = activeTopic(this.#state);
    if (topic && this.#state.activity[topic.id]?.running) {
      this.#lastInterruptAt = 0;
      // Belt-and-suspenders: `#applyRuntimeEvent` also wipes once the abort's
      // card-expired broadcast lands, but that is a network round trip away.
      if (composerHoldsSecret(this.#state)) {
        this.#input.setText("");
        this.#syncInput();
      }
      void this.#abort();
      return;
    }
    if (this.#input.text || this.#state.overlay || this.#state.creatingTopic) {
      this.#lastInterruptAt = 0;
      if (this.#state.overlay === "vault") this.#vaultDraftValue = "";
      this.#input.setText("");
      this.#history.reset();
      this.#syncInput();
      this.#state = {
        ...this.#state,
        overlay: null,
        pendingDeleteTopicId: undefined,
        creatingTopic: false,
        notice: "Input cleared",
        noticeLevel: "info",
      };
      this.#queueRender();
      return;
    }

    const now = Date.now();
    if (now - this.#lastInterruptAt <= 1_500) {
      this.#requestExit();
      return;
    }
    this.#lastInterruptAt = now;
    this.#state = {
      ...this.#state,
      notice: "Press Ctrl-C again to exit",
      noticeLevel: "warn",
    };
    this.#queueRender();
  }

  #requestExit(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#finishRun?.();
    this.#finishRun = null;
  }

  async #cleanup(clientStartAttempted: boolean, uiActive: boolean): Promise<void> {
    this.#shell?.dispose();
    this.#shell = null;
    this.#subagentGraphGeneration += 1;
    this.#subagentGraphAbortController?.abort();
    this.#subagentGraphAbortController = null;
    this.#decisionGraphGeneration += 1;
    this.#decisionGraphAbortController?.abort();
    this.#decisionGraphAbortController = null;
    if (this.#subagentGraphSpacingTimer) clearTimeout(this.#subagentGraphSpacingTimer);
    if (this.#decisionGraphSpacingTimer) clearTimeout(this.#decisionGraphSpacingTimer);
    if (this.#renderTimer) clearTimeout(this.#renderTimer);
    if (this.#inputCarryTimer) clearTimeout(this.#inputCarryTimer);
    this.#inputCarryTimer = undefined;
    this.#inputCarry = "";
    if (this.#pathSearchTimer) clearTimeout(this.#pathSearchTimer);
    if (this.#animationTimer) clearInterval(this.#animationTimer);
    if (this.#backgroundRefreshTimer) clearInterval(this.#backgroundRefreshTimer);
    this.#renderTimer = undefined;
    this.#pathSearchTimer = undefined;
    this.#animationTimer = undefined;
    this.#backgroundRefreshTimer = undefined;
    this.#renderQueued = false;
    this.#screen.reset();
    if (uiActive) {
      process.stdin.off("data", this.#onData);
      process.stdout.off("resize", this.#onResize);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      // The disposer writes `EXIT_ALT_SCREEN` synchronously and then removes
      // the hooks. It is idempotent, so a signal that already restored the
      // terminal on the way here does not double-emit the sequence, and an
      // embedding host is left with no process-level listeners of ours.
      this.#uninstallTerminalRestore?.();
      this.#uninstallTerminalRestore = null;
    }
    if (clientStartAttempted) await this.#client.stop();
  }
}
