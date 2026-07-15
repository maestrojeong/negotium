import { type AgentKind, type RuntimeBusEvent, SELECTABLE_MODELS } from "@negotium/core";
import {
  INITIAL_MESSAGE_HISTORY_LIMIT,
  MESSAGE_HISTORY_PAGE_SIZE,
  type MessageHistoryPage,
  type NegotiumClient,
} from "@/client";
import { copyToClipboard } from "@/clipboard";
import { commandSuggestions, completeCommand } from "@/commands";
import {
  maxConversationScrollOffset,
  plainTranscript,
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
  openTopicPicker,
  selectTopic,
  setMessageHistoryStatus,
  setMessages,
  setTopics,
  startTopicCreation,
  upsertMessage,
} from "@/state";
import { InputHistory, TextBuffer } from "@/text-buffer";

export const ENTER_ALT_SCREEN =
  "\u001b]11;#0a0b0f\u0007\u001b[?1049h\u001b[48;2;10;11;15m\u001b[2J\u001b[H\u001b[?25l\u001b[?2004h\u001b[?1002h\u001b[?1006h";
const EXIT_ALT_SCREEN =
  "\u001b[0m\u001b[?1006l\u001b[?1002l\u001b[?2004l\u001b[?25h\u001b[?1049l\u001b]111\u0007";
const NEW_TOPIC_KEYS = new Set(["n", "ㅜ"]);
const DELETE_TOPIC_KEYS = new Set(["d", "ㅇ", "\u007f", "\b", "\u001b[3~"]);
const CONFIRM_KEYS = new Set(["y", "ㅛ"]);
const CANCEL_KEYS = new Set(["n", "ㅜ"]);
// biome-ignore lint/complexity/useRegexLiterals: avoids a literal terminal control byte in source.
const SGR_MOUSE_PATTERN = new RegExp("\\u001b\\[<(\\d+);(\\d+);(\\d+)([mM])", "g");

export interface TerminalMouseEvent extends ScreenPoint {
  button: number;
  kind: "press" | "drag" | "release";
}

export function consumeMouseInput(raw: string): {
  input: string;
  scrollDelta: number;
  events: TerminalMouseEvent[];
} {
  let scrollDelta = 0;
  const events: TerminalMouseEvent[] = [];
  const input = raw.replace(
    SGR_MOUSE_PATTERN,
    (_sequence, rawButton: string, rawX: string, rawY: string, suffix: string) => {
      const button = Number.parseInt(rawButton, 10);
      if (Number.isFinite(button) && (button & 64) !== 0) {
        scrollDelta += (button & 1) === 0 ? 3 : -3;
      } else {
        const x = Number.parseInt(rawX, 10);
        const y = Number.parseInt(rawY, 10);
        if (Number.isFinite(button) && Number.isFinite(x) && Number.isFinite(y)) {
          events.push({
            button,
            x,
            y,
            kind: suffix === "m" ? "release" : (button & 32) !== 0 ? "drag" : "press",
          });
        }
      }
      return "";
    },
  );
  return { input, scrollDelta, events };
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
  #pasting = false;
  #renderQueued = false;
  #renderTimer: ReturnType<typeof setTimeout> | undefined;
  #animationTimer: ReturnType<typeof setInterval> | undefined;
  #animationFrame = 0;
  #topicsRefreshGeneration = 0;
  readonly #messageLoadGeneration = new Map<string, number>();
  readonly #messageHistory = new Map<
    string,
    { cursor?: string; hasMore: boolean; loading: boolean }
  >();
  readonly #queuedRuntimeEvents = new Map<string, RuntimeBusEvent[]>();
  #selection: ScreenSelection | null = null;
  #plainFrameLines: string[] = [];
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
      await this.#loadActiveMessages();
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
        const topic = activeTopic(this.#state);
        if (!topic || !this.#state.activity[topic.id]?.running) return;
        this.#animationFrame += 1;
        this.#queueRender();
      }, WORKING_FRAME_INTERVAL_MS);
      this.#animationTimer.unref?.();

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
    this.#selection = null;
    if (
      this.#messageLoadGeneration.has(event.topicId) &&
      (event.type === "message" || event.type === "message-updated" || event.type === "ai-status")
    ) {
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
    const baseFrame = rendered.frame;
    this.#plainFrameLines = stripAnsi(baseFrame).split("\n");
    const frame = this.#selection
      ? highlightScreenSelection(baseFrame, this.#selection)
      : baseFrame;
    const patch = this.#screen.update(frame);
    // Terminal emulators anchor IME preedit text to the hardware cursor.
    const cursor = rendered.cursor ? placeTerminalCursor(rendered.cursor) : "";
    if (patch || cursor) process.stdout.write(`${patch}${cursor}`);
  }

  #syncInput(): void {
    const suggestions = commandSuggestions(this.#input.text);
    this.#state = {
      ...this.#state,
      input: this.#input.text,
      inputCursor: this.#input.cursor,
      suggestionIndex:
        suggestions.length === 0
          ? 0
          : Math.min(this.#state.suggestionIndex, suggestions.length - 1),
    };
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
    this.#lastInterruptAt = 0;
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
      this.#toggleTopics();
      return;
    }
    if (chunk === "\u0014") {
      this.#state = {
        ...this.#state,
        overlay: this.#state.overlay === "transcript" ? null : "transcript",
      };
      this.#queueRender();
      return;
    }
    if (chunk === "\u0019") {
      void this.#copy(false); // Ctrl-Y
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
        this.#state = { ...this.#state, overlay: null, pendingDeleteTopicId: undefined };
        this.#queueRender();
      }
      return;
    }
    if (this.#state.overlay === "topics") {
      const key = chunk.toLowerCase();
      if (chunk === "\u001b[A") this.#moveTopicPicker(-1);
      else if (chunk === "\u001b[B") this.#moveTopicPicker(1);
      else if (chunk === "\r") this.#selectPickedTopic();
      else if (NEW_TOPIC_KEYS.has(key)) {
        this.#openNewTopicComposer();
      } else if (DELETE_TOPIC_KEYS.has(key)) {
        this.#requestTopicDelete(this.#state.topics[this.#state.topicPickerIndex]);
      } else if (chunk === "\u001b") {
        this.#state = { ...this.#state, overlay: null };
        this.#queueRender();
      }
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
    if (chunk === "\u001b[A") {
      if (activeQuestion(this.#state)) this.#moveAskChoice(-1);
      else if (commandSuggestions(this.#input.text).length > 0) this.#moveSuggestion(-1);
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
      else if (commandSuggestions(this.#input.text).length > 0) this.#moveSuggestion(1);
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
      return;
    }
    if (chunk === "\r") {
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
      this.#input.setText("");
      this.#history.reset();
      this.#syncInput();
      this.#state = { ...this.#state, overlay: null, creatingTopic: false };
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
    if (this.#state.creatingTopic) {
      this.#input.setText("");
      this.#syncInput();
      this.#state = { ...this.#state, creatingTopic: false, notice: undefined };
      await this.#createTopic(text);
      return;
    }
    this.#history.record(text);
    this.#client.appendInputHistory?.(text);
    this.#input.setText("");
    this.#syncInput();
    this.#state = {
      ...this.#state,
      overlay: null,
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
      const message = await this.#client.sendMessage(topic, text);
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
      void this.#copy(args[0]?.toLowerCase() === "all");
      return;
    }
    this.#state = { ...this.#state, notice: `Unknown command: /${command}` };
    this.#queueRender();
  }

  async #activateTopic(topicId: string): Promise<void> {
    this.#state = selectTopic(this.#state, topicId);
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

  #openNewTopicComposer(): void {
    this.#state = startTopicCreation(this.#state);
    this.#replaceInput("");
  }

  async #createTopic(title: string): Promise<void> {
    try {
      const created = await this.#client.createTopic(title, this.#options.defaultAgent);
      this.#state = focusCreatedTopic(this.#state, created);
      await this.#refreshTopics(created.title);
      this.#state = selectTopic(this.#state, created.id);
      await this.#loadActiveMessages();
      this.#state = { ...this.#state, notice: `Created ${created.title}` };
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
      };
    }
    this.#queueRender();
  }

  #moveTopicPicker(delta: number): void {
    if (this.#state.topics.length === 0) return;
    const index =
      (this.#state.topicPickerIndex + delta + this.#state.topics.length) %
      this.#state.topics.length;
    this.#state = { ...this.#state, topicPickerIndex: index };
    this.#queueRender();
  }

  #selectPickedTopic(): void {
    const topic = this.#state.topics[this.#state.topicPickerIndex];
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
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
      };
    }
    this.#queueRender();
  }

  #moveSuggestion(delta: number): void {
    const count = commandSuggestions(this.#input.text).length;
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
      this.#state = { ...this.#state, overlay: null, notice: "Manager topics cannot be deleted" };
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
    const topic = this.#state.topics.find(
      (candidate) => candidate.id === this.#state.pendingDeleteTopicId,
    );
    if (!topic) {
      this.#state = { ...this.#state, overlay: null, pendingDeleteTopicId: undefined };
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
      this.#state = openTopicPicker(this.#state, `Deleted ${topic.title}`);
      await this.#loadActiveMessages();
    } catch (error) {
      this.#state = {
        ...this.#state,
        notice: error instanceof Error ? error.message : String(error),
      };
    }
    this.#queueRender();
  }

  async #copy(all: boolean): Promise<void> {
    const text = all
      ? plainTranscript(this.#state)
      : activeMessages(this.#state)
          .slice()
          .reverse()
          .find((message) => message.authorId === "ai" && message.text.trim())?.text;
    if (!text) {
      this.#state = {
        ...this.#state,
        notice: all ? "Nothing to copy" : "No agent response to copy",
      };
      this.#queueRender();
      return;
    }
    try {
      const result = await copyToClipboard(text);
      this.#state = {
        ...this.#state,
        notice: `${all ? "Transcript" : "Last response"} copied via ${result.method}${result.truncated ? " (truncated)" : ""}`,
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
    const topic = activeTopic(this.#state);
    if (topic && this.#state.activity[topic.id]?.running) {
      this.#lastInterruptAt = 0;
      void this.#abort();
      return;
    }
    if (this.#input.text || this.#state.overlay || this.#state.creatingTopic) {
      this.#lastInterruptAt = 0;
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
    if (this.#animationTimer) clearInterval(this.#animationTimer);
    this.#renderTimer = undefined;
    this.#animationTimer = undefined;
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
