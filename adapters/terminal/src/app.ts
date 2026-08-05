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
  vaultFormBlocksOverlaySwitch,
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
import { commandSuggestions, completeCommand } from "@/commands";
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
  maxConversationScrollOffset,
  preserveConversationScrollAnchor,
  renderAppFrame,
  stripAnsi,
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
import {
  type AppState,
  activeMessages,
  activeQuestion,
  activeTopic,
  appendTopicFilter,
  applyRuntimeEvent,
  backspaceTopicFilter,
  createInitialState,
  focusCreatedTopic,
  moveTopicPickerSelection,
  openTopicPicker,
  pickedBackgroundSession,
  pickedTopic,
  type SubagentGraphCanvas,
  selectTopic,
  setBackgroundSessions,
  setMessageHistoryStatus,
  setMessages,
  setTopicFilter,
  setTopics,
  setTopicUsage,
  startTopicCreation,
  toggleTaskSidebar,
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

export function altScreenSequences(env: NodeJS.ProcessEnv = process.env): {
  enter: string;
  exit: string;
  abortEnter: string;
} {
  const push = kittyKeyboardEnabled(env) ? KITTY_KEYBOARD_PUSH : "";
  const pop = kittyKeyboardEnabled(env) ? KITTY_KEYBOARD_POP : "";
  // These bytes only ever reach a real terminal, so the TTY test in
  // `detectColorDepth` is short-circuited here; what matters is whether the
  // user asked for no colour (`NO_COLOR`, `TERM=dumb`, `NEGOTIUM_TUI_COLOR`).
  // Under `none` neither the OSC 11 background repaint nor the truecolour
  // canvas fill is emitted, so the terminal keeps its own theme — and the
  // matching OSC 111 restore is dropped too, since restoring a colour we never
  // set would clobber a background the user configured themselves.
  const depth = detectColorDepth({ env, isTty: true });
  const colored = depth !== "none";
  const setBackground = colored ? "\u001b]11;#0a0b0f\u0007" : "";
  const fillCanvas = canvasFill(depth);
  const resetBackground = colored ? "\u001b]111\u0007" : "";
  // Private-mode resets only. Every one of these is a no-op on a terminal where
  // the mode was never set, which is what makes them safe to emit at a point
  // where we may not have changed anything yet.
  const modeResets =
    "\u001b[0m\u001b[?7h\u001b[?1l\u001b[?1006l\u001b[?1002l\u001b[?2004l\u001b[?25h\u001b[?1049l";
  return {
    enter: `${setBackground}\u001b[?1049h${fillCanvas}\u001b[2J\u001b[H\u001b[?25l\u001b[?2004h\u001b[?1002h\u001b[?1006h\u001b[?1l${push}`,
    // `END_SYNCHRONIZED_UPDATE` leads: every render patch opens with
    // `CSI ?2026h`, so a process that dies mid-patch leaves the terminal
    // holding its output back. Ending the update is idempotent — a terminal
    // that never saw a begin, or does not implement DECSET 2026 at all, ignores
    // it — so two bytes buy an unconditional way out of a frozen screen.
    exit: `${END_SYNCHRONIZED_UPDATE}${pop}${modeResets}${resetBackground}`,
    // What to emit if the process dies *between* claiming the terminal and
    // finishing the `enter` write. Two pieces of `exit` are deliberately absent
    // because neither is idempotent:
    //
    //  - OSC 111 resets the background to the terminal default. Sending it
    //    without having sent OSC 11 first would discard a background the user
    //    configured themselves.
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
  #history = new InputHistory();
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
  #subagentGraphDragPoint: ScreenPoint | null = null;
  #plainFrameLines: string[] = [];
  #codeCopyTargets: CodeCopyTarget[] = [];
  #lastInterruptAt = 0;
  #subagentGraphGeneration = 0;
  #subagentGraphAbortController: AbortController | null = null;
  #subagentGraphSpacingTimer: ReturnType<typeof setTimeout> | null = null;
  // Caches the last laid-out canvas keyed by structural signature so live
  // running-state changes re-render via nodeStates overlay without rerunning ELK.
  #subagentGraphCache: { signature: string; canvas: SubagentGraphCanvas } | null = null;
  #pendingSubagentGraphSpacing: number | null = null;
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

  async run(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("terminal-adapter requires an interactive TTY");
    }
    let clientStartAttempted = false;
    let uiActive = false;
    try {
      clientStartAttempted = true;
      await this.#client.start((event) => this.#handleRuntimeEvent(event));
      this.#history = new InputHistory(this.#client.listInputHistory?.() ?? []);
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
          this.#state = selectTopic(this.#state, created.id);
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
    this.#state = preserveConversationScrollAnchor(
      previousState,
      applyRuntimeEvent(previousState, event),
      process.stdout.columns ?? 100,
      process.stdout.rows ?? 30,
    );
  }

  #handleRuntimeEvent(event: RuntimeBusEvent): void {
    // Background topics can emit progress events every few seconds. They do
    // not change the active conversation, so they must not interrupt a drag
    // selection on this screen.
    if (runtimeEventInvalidatesSelection(this.#state, event)) this.#selection = null;
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
    const rendered = renderAppFrame(this.#state, columns, rows, this.#animationFrame);
    this.#codeCopyTargets = rendered.codeCopyTargets;
    const baseFrame = rendered.frame;
    this.#plainFrameLines = stripAnsi(baseFrame).split("\n");
    const frame = this.#selection
      ? highlightScreenSelection(baseFrame, this.#selection)
      : baseFrame;
    const patch = this.#screen.update(frame, rows);
    // Terminal emulators anchor IME preedit text to the hardware cursor.
    const cursor = rendered.cursor ? placeTerminalCursor(rendered.cursor) : "";
    if (patch || cursor) process.stdout.write(`${patch}${cursor}`);
  }

  async #toggleSubagentGraph(): Promise<void> {
    const topicId = this.#state.activeTopicId;
    if (!topicId) return;
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
    if (mouse.horizontalScrollDelta !== 0 && this.#state.overlay === "subagents") {
      this.#selection = null;
      this.#panSubagentGraph(-mouse.horizontalScrollDelta, 0);
    }
    if (mouse.scrollDelta !== 0) {
      this.#selection = null;
      this.#scroll(mouse.scrollDelta);
    }
    for (const event of mouse.events) {
      if (this.#state.overlay === "subagents") this.#handleSubagentGraphMouse(event);
      else this.#handleMouseSelection(event);
    }
    const chunk = normalizeKeySequences(mouse.input);
    if (!chunk) return;
    this.#selection = null;
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
    if (chunk === "\u0014") {
      if (editingVaultSecret) return;
      this.#state = toggleTaskSidebar(this.#state);
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
      if (chunk === "\u001b") {
        this.#cancelVaultForm();
        return;
      }
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
      this.#client.appendInputHistory?.(text);
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
    if (text.startsWith("/")) {
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

  async #activateTopic(topicId: string): Promise<void> {
    this.#state = selectTopic(this.#state, topicId);
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
      this.#state = selectTopic(this.#state, created.id);
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
      this.#state = selectTopic(this.#state, derived.id);
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

  #handleMouseSelection(event: TerminalMouseEvent): void {
    if ((event.button & 3) !== 0 && event.kind !== "release") return;
    const point: ScreenPoint = { x: event.x, y: event.y };
    if (event.kind === "press") {
      const codeTarget = codeCopyTargetAt(this.#codeCopyTargets, point);
      if (codeTarget) {
        this.#selection = null;
        void this.#copyCodeBlock(codeTarget.text);
        return;
      }
      this.#selection = { anchor: point, focus: point };
      this.#queueRender();
      return;
    }
    if (!this.#selection) return;
    this.#selection = { ...this.#selection, focus: point };
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

  #handleSubagentGraphMouse(event: TerminalMouseEvent): void {
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
    this.#panSubagentGraph(previous.x - point.x, previous.y - point.y);
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
    if (this.#state.overlay === "subagents") {
      this.#panSubagentGraph(0, -delta);
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
    this.#subagentGraphGeneration += 1;
    this.#subagentGraphAbortController?.abort();
    this.#subagentGraphAbortController = null;
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
