import {
  type AgentKind,
  isVaultCommandLine,
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
  runTerminalVaultCommand,
  runtimeEventInvalidatesSelection,
  runtimeEventWaitsForMessageLoad,
  selectableEfforts,
  type TerminalMouseEvent,
  vaultFormBlocksOverlaySwitch,
} from "@/app-helpers";
import {
  INITIAL_MESSAGE_HISTORY_LIMIT,
  MESSAGE_HISTORY_PAGE_SIZE,
  type MessageHistoryPage,
  type NegotiumClient,
} from "@/client";
import { copyToClipboard } from "@/clipboard";
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
  renderAppFrame,
  stripAnsi,
  WORKING_FRAME_INTERVAL_MS,
} from "@/render";
import { placeTerminalCursor, TerminalScreenRenderer } from "@/screen-renderer";
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
  applyRuntimeEvent,
  createInitialState,
  focusCreatedTopic,
  moveTopicPickerSelection,
  openTopicPicker,
  pickedBackgroundSession,
  pickedTopic,
  selectTopic,
  setBackgroundSessions,
  setMessageHistoryStatus,
  setMessages,
  setTopics,
  startTopicCreation,
  toggleTaskSidebar,
  upsertMessage,
} from "@/state";
import { InputHistory, TextBuffer } from "@/text-buffer";

export const ENTER_ALT_SCREEN =
  "\u001b]11;#0a0b0f\u0007\u001b[?1049h\u001b[48;2;10;11;15m\u001b[2J\u001b[H\u001b[?25l\u001b[?2004h\u001b[?1002h\u001b[?1006h";
export const EXIT_ALT_SCREEN =
  "\u001b[0m\u001b[?7h\u001b[?1006l\u001b[?1002l\u001b[?2004l\u001b[?25h\u001b[?1049l\u001b]111\u0007";
const NEW_TOPIC_KEYS = new Set(["n", "ㅜ"]);
const DELETE_TOPIC_KEYS = new Set(["d", "ㅇ", "\u007f", "\b", "\u001b[3~"]);
const CONFIRM_KEYS = new Set(["y", "ㅛ"]);
const CANCEL_KEYS = new Set(["n", "ㅜ"]);

export {
  animationFrameAt,
  codeCopyTargetAt,
  consumeMouseInput,
  ctrlCExitsTopicPicker,
  escapeStopsActiveTurn,
  maestroVaultKeyForModel,
  runTerminalVaultCommand,
  runtimeEventInvalidatesSelection,
  runtimeEventWaitsForMessageLoad,
  vaultFormBlocksOverlaySwitch,
} from "@/app-helpers";

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
  #renderQueued = false;
  #renderTimer: ReturnType<typeof setTimeout> | undefined;
  #pathSearchTimer: ReturnType<typeof setTimeout> | undefined;
  #pathSearchGeneration = 0;
  #animationTimer: ReturnType<typeof setInterval> | undefined;
  #backgroundRefreshTimer: ReturnType<typeof setInterval> | undefined;
  #backgroundRefreshRunning = false;
  #animationFrame = animationFrameAt();
  #topicsRefreshGeneration = 0;
  readonly #messageLoadGeneration = new Map<string, number>();
  readonly #messageHistory = new Map<
    string,
    { cursor?: string; hasMore: boolean; loading: boolean }
  >();
  readonly #queuedRuntimeEvents = new Map<string, RuntimeBusEvent[]>();
  #selection: ScreenSelection | null = null;
  #plainFrameLines: string[] = [];
  #codeCopyTargets: CodeCopyTarget[] = [];
  #lastInterruptAt = 0;
  #running = false;
  #stopRequested = false;
  #finishRun: (() => void) | null = null;
  #onData = (chunk: Buffer | string) => this.#handleInput(String(chunk));
  #onResize = () => {
    this.#selection = null;
    this.#screen.invalidate();
    this.#queueRender();
  };
  #onSignal = () => this.#requestExit();

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

      process.stdout.write(ENTER_ALT_SCREEN);
      uiActive = true;
      process.stdin.setEncoding("utf8");
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", this.#onData);
      process.stdout.on("resize", this.#onResize);
      process.once("SIGINT", this.#onSignal);
      process.once("SIGTERM", this.#onSignal);
      this.#render();
      this.#animationTimer = setInterval(() => {
        const activeRunning = Boolean(
          this.#state.activeTopicId && this.#state.activity[this.#state.activeTopicId]?.running,
        );
        const pickerRunning =
          this.#state.overlay === "topics" &&
          this.#state.topics.some((topic) => this.#state.activity[topic.id]?.running);
        if (!activeRunning && !pickerRunning && this.#state.backgroundSessions.length === 0) return;
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
    this.#state = applyRuntimeEvent(this.#state, event);
    if (
      event.type === "topic-created" ||
      event.type === "topic-updated" ||
      event.type === "topic-deleted"
    ) {
      const previous = this.#state.activeTopicId;
      void this.#refreshTopicsAfterEvent(previous);
    }
    this.#queueRender();
  }

  async #refreshTopicsAfterEvent(previous: string | null): Promise<void> {
    try {
      await this.#refreshTopics();
      if (this.#state.activeTopicId && this.#state.activeTopicId !== previous) {
        await this.#loadActiveMessages();
      }
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: `Node connection error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.#queueRender();
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
        for (const event of queued) this.#state = applyRuntimeEvent(this.#state, event);
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
      this.#state = applyRuntimeEvent(this.#state, event);
    }
    this.#messageLoadGeneration.delete(topic.id);
    const queued = this.#queuedRuntimeEvents.get(topic.id) ?? [];
    this.#queuedRuntimeEvents.delete(topic.id);
    for (const event of queued) this.#state = applyRuntimeEvent(this.#state, event);
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

  #syncInput(): void {
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

  #replaceInput(value: string): void {
    this.#input.setText(value);
    this.#syncInput();
    this.#queueRender();
  }

  #handleInput(raw: string): void {
    if (!this.#running) return;
    const mouse = consumeMouseInput(raw);
    if (mouse.scrollDelta !== 0) {
      this.#selection = null;
      this.#scroll(mouse.scrollDelta);
    }
    for (const event of mouse.events) this.#handleMouseSelection(event);
    let chunk = mouse.input;
    if (!chunk) return;
    this.#selection = null;
    const pasteStart = "\u001b[200~";
    const pasteEnd = "\u001b[201~";
    if (this.#pasting) {
      const end = chunk.indexOf(pasteEnd);
      if (end < 0) {
        this.#input.insert(chunk);
        this.#syncInput();
        this.#queueRender();
        return;
      }
      this.#input.insert(chunk.slice(0, end));
      this.#pasting = false;
      chunk = chunk.slice(end + pasteEnd.length);
      this.#syncInput();
      if (!chunk) {
        this.#queueRender();
        return;
      }
    }
    const start = chunk.indexOf(pasteStart);
    if (start >= 0) {
      const before = chunk.slice(0, start);
      if (before) this.#handleInput(before);
      this.#pasting = true;
      this.#handleInput(chunk.slice(start + pasteStart.length));
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
    if (chunk === "\u0010") {
      this.#cycleTopic(-1); // Ctrl-P
      return;
    }
    if (chunk === "\u000e") {
      this.#cycleTopic(1); // Ctrl-N
      return;
    }
    if (chunk === "\u000f") {
      // Switching overlays would render the composer as ordinary plaintext.
      // Keep secret/description entry inside the masking Vault overlay.
      if (editingVaultSecret) return;
      this.#toggleTopics();
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
    if (chunk === "\u001bb" || chunk === "\u001b[1;5D") {
      this.#input.moveWordLeft();
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u001bf" || chunk === "\u001b[1;5C") {
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
    if (chunk === "\u0017") {
      this.#input.deleteWordLeft(); // Ctrl-W
      this.#syncInput();
      this.#queueRender();
      return;
    }
    if (chunk === "\u0015") {
      this.#input.clearBeforeCursor(); // Ctrl-U
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
        const previous = this.#history.previous(this.#input.text);
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
        if (next !== null) this.#replaceInput(next);
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
    if (chunk === "\u001b\r" || chunk === "\u001b\n") {
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
      };
      this.#queueRender();
      return;
    }

    const text = this.#input.text.trim();
    if (!text) return;
    const inVaultCommandScreen =
      this.#state.overlay === "vault" && this.#state.vaultMode === "list";
    if (inVaultCommandScreen && !isVaultCommandLine(text)) {
      this.#input.setText("");
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
      this.#syncInput();
      this.#state = { ...this.#state, creatingTopic: false, notice: undefined };
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
    this.#syncInput();
    const keepVaultOpen = this.#state.overlay === "vault";
    this.#state = {
      ...this.#state,
      overlay: keepVaultOpen ? "vault" : null,
      notice: undefined,
    };
    if (text.startsWith("/")) {
      await this.#runCommand(text);
      return;
    }
    const topic = activeTopic(this.#state);
    if (!topic) {
      this.#state = { ...this.#state, notice: "No topic selected" };
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
      };
    }
    this.#queueRender();
  }

  async #runCommand(commandLine: string): Promise<void> {
    if (isVaultCommandLine(commandLine)) {
      const outcome = await runTerminalVaultCommand(this.#client, commandLine);
      if (outcome.kind === "open-manager") await this.#openVault();
      else if (this.#state.overlay === "vault") await this.#openVault(outcome.notice);
      else {
        this.#state = { ...this.#state, notice: outcome.notice };
        this.#queueRender();
      }
      return;
    }
    const [command = "", ...args] = commandLine.slice(1).trim().split(/\s+/);
    if (command === "quit" || command === "exit") {
      this.#requestExit();
      return;
    }
    if (command === "abort") {
      await this.#abort();
      return;
    }
    if (command === "help") {
      this.#state = { ...this.#state, overlay: "help" };
      this.#queueRender();
      return;
    }
    if (command === "status") {
      this.#state = { ...this.#state, overlay: "status" };
      this.#queueRender();
      return;
    }
    if (command === "model") {
      if (args.length > 0) {
        this.#state = { ...this.#state, notice: "Usage: /model" };
        this.#queueRender();
        return;
      }
      const topic = activeTopic(this.#state);
      if (!topic) {
        this.#state = { ...this.#state, notice: "No topic selected" };
        this.#queueRender();
        return;
      }
      const currentModel = topic.effectiveModel ?? topic.defaultModel;
      const currentIndex = SELECTABLE_MODELS.findIndex(
        (candidate) => candidate.model === currentModel,
      );
      this.#state = {
        ...this.#state,
        overlay: "models",
        modelPickerIndex: Math.max(0, currentIndex),
      };
      this.#queueRender();
      return;
    }
    if (command === "effort") {
      if (args.length > 0) {
        this.#state = { ...this.#state, notice: "Usage: /effort" };
        this.#queueRender();
        return;
      }
      const topic = activeTopic(this.#state);
      if (!topic) {
        this.#state = { ...this.#state, notice: "No topic selected" };
        this.#queueRender();
        return;
      }
      const currentEffort = topic.effectiveEffort ?? topic.defaultEffort;
      const currentIndex = selectableEfforts(topic).indexOf(currentEffort);
      this.#state = {
        ...this.#state,
        overlay: "effort",
        effortPickerIndex: Math.max(0, currentIndex),
      };
      this.#queueRender();
      return;
    }
    if (command === "public" || command === "private") {
      if (args.length > 0) {
        this.#state = { ...this.#state, notice: `Usage: /${command}` };
        this.#queueRender();
        return;
      }
      const topic = activeTopic(this.#state);
      if (!topic) {
        this.#state = { ...this.#state, notice: "No topic selected" };
        this.#queueRender();
        return;
      }
      try {
        const notice = await this.#client.setAccessMode(
          topic,
          command === "public" ? "shared" : "private",
        );
        await this.#refreshTopics(topic.title);
        this.#state = { ...this.#state, notice };
      } catch (error) {
        this.#state = {
          ...this.#state,
          notice: error instanceof Error ? error.message : String(error),
        };
      }
      this.#queueRender();
      return;
    }
    if (command === "compact") {
      const topic = activeTopic(this.#state);
      if (!topic) {
        this.#state = { ...this.#state, notice: "No topic selected" };
        this.#queueRender();
        return;
      }
      const queryId = `terminal-compact-${Date.now()}`;
      this.#state = applyRuntimeEvent(
        { ...this.#state, notice: "Compacting context…" },
        {
          type: "ai-status",
          topicId: topic.id,
          payload: { kind: "ai_active", queryId },
        },
      );
      this.#queueRender();
      try {
        const notice = await this.#client.compactTopic(topic);
        this.#state = applyRuntimeEvent(
          { ...this.#state, notice },
          {
            type: "ai-status",
            topicId: topic.id,
            payload: { kind: "ai_done", queryId },
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#state = applyRuntimeEvent(
          { ...this.#state, notice: message },
          {
            type: "ai-status",
            topicId: topic.id,
            payload: { kind: "ai_error", queryId, error: message },
          },
        );
      }
      this.#queueRender();
      return;
    }
    if (command === "topics") {
      this.#toggleTopics(true);
      return;
    }
    if (command === "new") {
      if (args.length > 0) {
        this.#state = { ...this.#state, notice: "Usage: /new" };
        this.#queueRender();
        return;
      }
      const topic = activeTopic(this.#state);
      if (!topic) {
        this.#state = { ...this.#state, notice: "No topic selected" };
        this.#queueRender();
        return;
      }
      try {
        const notice = await this.#client.resetTopic(topic);
        this.#state = { ...this.#state, notice };
      } catch (error) {
        this.#state = {
          ...this.#state,
          notice: error instanceof Error ? error.message : String(error),
        };
      }
      this.#queueRender();
      return;
    }
    if (command === "fork" || command === "spawn") {
      const topic = activeTopic(this.#state);
      if (!topic) {
        this.#state = { ...this.#state, notice: "No topic selected" };
        this.#queueRender();
        return;
      }
      await this.#deriveTopic(topic, command === "fork", args.join(" ") || undefined);
      return;
    }
    if (command === "del") {
      if (args.length > 0) {
        this.#state = { ...this.#state, notice: "Usage: /del" };
        this.#queueRender();
        return;
      }
      const topic = activeTopic(this.#state);
      if (!topic) {
        this.#state = { ...this.#state, notice: "No topic selected" };
        this.#queueRender();
        return;
      }
      this.#requestTopicDelete(topic);
      return;
    }
    if (command === "copy") {
      if (args.length > 0) {
        this.#state = { ...this.#state, notice: "Usage: /copy" };
        this.#queueRender();
        return;
      }
      void this.#copy();
      return;
    }
    this.#state = { ...this.#state, notice: `Unknown command: /${command}` };
    this.#queueRender();
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
      };
    }
    this.#queueRender();
  }

  #cycleTopic(delta: number): void {
    if (this.#state.topics.length === 0) return;
    const index = this.#state.topics.findIndex((topic) => topic.id === this.#state.activeTopicId);
    const next =
      (Math.max(0, index) + delta + this.#state.topics.length) % this.#state.topics.length;
    void this.#activateTopic(this.#state.topics[next].id);
  }

  #toggleTopics(forceOpen = false): void {
    this.#state =
      forceOpen || this.#state.overlay !== "topics"
        ? openTopicPicker(this.#state)
        : { ...this.#state, overlay: null };
    this.#queueRender();
  }

  #handleTopicPickerInput(chunk: string): void {
    const key = chunk.toLowerCase();
    if (chunk === "\u001b[A") this.#moveTopicPicker(-1);
    else if (chunk === "\u001b[B") this.#moveTopicPicker(1);
    else if (chunk === "\r") this.#selectPickedTopic();
    else if (NEW_TOPIC_KEYS.has(key)) {
      this.#openNewTopicComposer();
    } else if (DELETE_TOPIC_KEYS.has(key)) {
      const topic = pickedTopic(this.#state);
      if (topic) this.#requestTopicDelete(topic);
      else {
        this.#state = { ...this.#state, notice: "Background sessions are read-only" };
        this.#queueRender();
      }
    } else if (chunk === "\u001b") {
      if (this.#state.topicPickerRoot) this.#requestExit();
      else {
        this.#state = { ...this.#state, overlay: null };
        this.#queueRender();
      }
    }
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
      this.#state = { ...this.#state, notice: `Created ${created.title}` };
    } catch (error) {
      const failed = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
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
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
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
      this.#state = { ...this.#state, overlay: "background-session", notice: undefined };
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
      this.#state = { ...this.#state, notice: "Vault management is unavailable for this client." };
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
      this.#state = { ...this.#state, notice };
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
            this.#state = { ...this.#state, overlay: null, vaultNotice: undefined, notice };
            this.#queueRender();
            return;
          } catch (error) {
            this.#state = {
              ...this.#state,
              overlay: null,
              vaultNotice: undefined,
              notice: error instanceof Error ? error.message : String(error),
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
    this.#state = { ...this.#state, overlay: null, notice: `Switching to ${selected.model}…` };
    this.#queueRender();
    try {
      const notice = await this.#client.setModel(topic, selected.model);
      await this.#refreshTopics(topic.title);
      this.#state = { ...this.#state, notice };
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
      this.#state = { ...this.#state, notice: message };
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
    this.#state = { ...this.#state, overlay: null, notice: `Setting effort to ${effort}…` };
    this.#queueRender();
    try {
      const notice = await this.#client.setEffort(topic, effort);
      await this.#refreshTopics(topic.title);
      this.#state = { ...this.#state, notice };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
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
        ? openTopicPicker(this.#state, notice, true)
        : { ...this.#state, overlay: null, notice };
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
    };
    this.#queueRender();
    try {
      await this.#client.deleteTopic(topic);
      await this.#refreshTopics();
      this.#state = openTopicPicker(this.#state, `Deleted ${topic.title}`, topicPickerRoot);
      if (!topicPickerRoot) await this.#loadActiveMessages();
    } catch (error) {
      const failed = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
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
      };
      this.#queueRender();
      return;
    }
    try {
      const result = await copyToClipboard(text);
      this.#state = {
        ...this.#state,
        notice: `Last response copied via ${result.method}${result.truncated ? " (truncated)" : ""}`,
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
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

  async #copySelection(text: string): Promise<void> {
    try {
      const result = await copyToClipboard(text);
      this.#state = {
        ...this.#state,
        notice: `Selection copied via ${result.method}${result.truncated ? " (truncated)" : ""}`,
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
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
      };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: `Copy failed: ${error instanceof Error ? error.message : String(error)}`,
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
      this.#state = { ...this.#state, notice: "Start of conversation" };
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

  async #abort(): Promise<void> {
    const topic = activeTopic(this.#state);
    let aborted = false;
    try {
      aborted = topic ? await this.#client.abort(topic.id) : false;
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
      };
      this.#queueRender();
      return;
    }
    this.#state = {
      ...this.#state,
      notice: aborted ? "Turn aborted" : "Nothing is running",
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
    this.#state = { ...this.#state, notice: "Press Ctrl-C again to exit" };
    this.#queueRender();
  }

  #requestExit(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#finishRun?.();
    this.#finishRun = null;
  }

  async #cleanup(clientStartAttempted: boolean, uiActive: boolean): Promise<void> {
    if (this.#renderTimer) clearTimeout(this.#renderTimer);
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
      process.off("SIGINT", this.#onSignal);
      process.off("SIGTERM", this.#onSignal);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(EXIT_ALT_SCREEN);
    }
    if (clientStartAttempted) await this.#client.stop();
  }
}
