import type { AgentKind, RuntimeBusEvent } from "@negotium/core";
import type { NegotiumClient } from "@/client";
import { renderApp } from "@/render";
import {
  type AppState,
  activeQuestion,
  activeTopic,
  applyRuntimeEvent,
  createInitialState,
  selectTopic,
  setMessages,
  setTopics,
  upsertMessage,
} from "@/state";

const ENTER_ALT_SCREEN = "\u001b[?1049h\u001b[?25l\u001b[?2004h";
const EXIT_ALT_SCREEN = "\u001b[?2004l\u001b[?25h\u001b[?1049l";
const CLEAR_AND_HOME = "\u001b[2J\u001b[H";
const AGENTS = new Set<AgentKind>(["claude", "codex", "maestro"]);

export interface TerminalAppOptions {
  userId: string;
  preferredTopic?: string;
  defaultAgent?: AgentKind;
}

export class TerminalApp {
  readonly #client: NegotiumClient;
  readonly #options: TerminalAppOptions;
  #state: AppState;
  #renderQueued = false;
  #running = false;
  #stopRequested = false;
  #finishRun: (() => void) | null = null;
  #onData = (chunk: Buffer | string) => this.#handleInput(String(chunk));
  #onResize = () => this.#queueRender();
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
      if (this.#stopRequested) return;
      this.#refreshTopics(this.#options.preferredTopic);
      if (this.#state.topics.length === 0) {
        const created = this.#client.createTopic(
          this.#options.preferredTopic ?? "chat",
          this.#options.defaultAgent,
        );
        this.#state = setTopics(this.#state, [created], created.title);
      }
      this.#loadActiveMessages();
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
    this.#state = applyRuntimeEvent(this.#state, event);
    if (
      event.type === "topic-created" ||
      event.type === "topic-updated" ||
      event.type === "topic-deleted"
    ) {
      const previous = this.#state.activeTopicId;
      this.#refreshTopics();
      if (this.#state.activeTopicId && this.#state.activeTopicId !== previous) {
        this.#loadActiveMessages();
      }
    }
    this.#queueRender();
  }

  #refreshTopics(preferredTitle?: string): void {
    this.#state = setTopics(this.#state, this.#client.listTopics(), preferredTitle);
  }

  #loadActiveMessages(): void {
    const topic = activeTopic(this.#state);
    if (!topic) return;
    this.#state = setMessages(this.#state, topic.id, this.#client.listMessages(topic.id));
  }

  #queueRender(): void {
    if (!this.#running || this.#renderQueued) return;
    this.#renderQueued = true;
    queueMicrotask(() => {
      this.#renderQueued = false;
      if (this.#running) this.#render();
    });
  }

  #render(): void {
    const columns = process.stdout.columns ?? 100;
    const rows = process.stdout.rows ?? 30;
    process.stdout.write(`${CLEAR_AND_HOME}${renderApp(this.#state, columns, rows)}`);
  }

  #handleInput(raw: string): void {
    if (!this.#running) return;
    const chunk = raw.replaceAll("\u001b[200~", "").replaceAll("\u001b[201~", "");
    if (chunk === "\u0003") {
      this.#requestExit(); // Ctrl-C
      return;
    }
    if (chunk === "\u0018") {
      this.#abort(); // Ctrl-X
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
      this.#state = {
        ...this.#state,
        overlay: this.#state.overlay === "topics" ? null : "topics",
      };
      this.#queueRender();
      return;
    }
    if (chunk === "\u000c") {
      this.#render(); // Ctrl-L
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
    if (chunk === "\u001b[A") {
      this.#moveAskChoice(-1);
      return;
    }
    if (chunk === "\u001b[B") {
      this.#moveAskChoice(1);
      return;
    }
    if (chunk === "\r" || chunk === "\n") {
      this.#submit();
      return;
    }
    if (chunk === "\u007f" || chunk === "\b") {
      this.#state = {
        ...this.#state,
        input: [...this.#state.input].slice(0, -1).join(""),
      };
      this.#queueRender();
      return;
    }
    if (chunk === "\u001b") {
      this.#state = { ...this.#state, overlay: null, input: "" };
      this.#queueRender();
      return;
    }
    if (chunk.startsWith("\u001b")) return;

    const printable = [...chunk.replaceAll("\r", " ").replaceAll("\n", " ").replaceAll("\t", " ")]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code > 0x1f && code !== 0x7f;
      })
      .join("");
    if (printable) {
      this.#state = {
        ...this.#state,
        input: `${this.#state.input}${printable}`,
      };
      this.#queueRender();
    }
  }

  #submit(): void {
    const ask = activeQuestion(this.#state);
    if (ask?.askUserQuestion?.choices.length) {
      const index = Math.min(this.#state.askChoiceIndex, ask.askUserQuestion.choices.length - 1);
      const choice = ask.askUserQuestion.choices[index];
      const result = this.#client.answerQuestion(ask.topicId, ask.id, choice.label);
      this.#state = {
        ...this.#state,
        askChoiceIndex: 0,
        notice: result.ok ? undefined : result.error,
      };
      this.#queueRender();
      return;
    }

    const text = this.#state.input.trim();
    if (!text) return;
    this.#state = {
      ...this.#state,
      input: "",
      overlay: null,
      notice: undefined,
    };
    if (text.startsWith("/")) {
      this.#runCommand(text);
      return;
    }
    const topic = activeTopic(this.#state);
    if (!topic) {
      this.#state = { ...this.#state, notice: "No topic selected" };
      this.#queueRender();
      return;
    }
    const message = this.#client.sendMessage(topic, text);
    this.#state = upsertMessage(this.#state, message);
    this.#queueRender();
  }

  #runCommand(commandLine: string): void {
    const [command = "", ...args] = commandLine.slice(1).trim().split(/\s+/);
    if (command === "quit" || command === "exit") {
      this.#requestExit();
      return;
    }
    if (command === "abort") {
      this.#abort();
      return;
    }
    if (command === "help") {
      this.#state = { ...this.#state, overlay: "help" };
      this.#queueRender();
      return;
    }
    if (command === "topics") {
      this.#state = { ...this.#state, overlay: "topics" };
      this.#queueRender();
      return;
    }
    if (command === "topic") {
      const title = args.join(" ").toLowerCase();
      const topic = this.#state.topics.find((candidate) => candidate.title.toLowerCase() === title);
      if (!topic) {
        this.#state = {
          ...this.#state,
          notice: `Topic not found: ${args.join(" ")}`,
        };
        this.#queueRender();
        return;
      }
      this.#activateTopic(topic.id);
      return;
    }
    if (command === "new") {
      const maybeAgent = args.at(-1) as AgentKind | undefined;
      const agent = maybeAgent && AGENTS.has(maybeAgent) ? maybeAgent : this.#options.defaultAgent;
      const nameParts = maybeAgent && AGENTS.has(maybeAgent) ? args.slice(0, -1) : args;
      const title = nameParts.join(" ").trim();
      if (!title) {
        this.#state = { ...this.#state, notice: "Usage: /new <name> [agent]" };
        this.#queueRender();
        return;
      }
      try {
        const created = this.#client.createTopic(title, agent);
        this.#refreshTopics(created.title);
        this.#loadActiveMessages();
      } catch (error) {
        this.#state = {
          ...this.#state,
          notice: error instanceof Error ? error.message : String(error),
        };
      }
      this.#queueRender();
      return;
    }
    this.#state = { ...this.#state, notice: `Unknown command: /${command}` };
    this.#queueRender();
  }

  #activateTopic(topicId: string): void {
    this.#state = selectTopic(this.#state, topicId);
    this.#loadActiveMessages();
    this.#queueRender();
  }

  #cycleTopic(delta: number): void {
    if (this.#state.topics.length === 0) return;
    const index = this.#state.topics.findIndex((topic) => topic.id === this.#state.activeTopicId);
    const next =
      (Math.max(0, index) + delta + this.#state.topics.length) % this.#state.topics.length;
    this.#activateTopic(this.#state.topics[next].id);
  }

  #moveAskChoice(delta: number): void {
    const choices = activeQuestion(this.#state)?.askUserQuestion?.choices;
    if (!choices?.length) return;
    const next = (this.#state.askChoiceIndex + delta + choices.length) % choices.length;
    this.#state = { ...this.#state, askChoiceIndex: next };
    this.#queueRender();
  }

  #scroll(delta: number): void {
    this.#state = {
      ...this.#state,
      scrollOffset: Math.max(0, this.#state.scrollOffset + delta),
    };
    this.#queueRender();
  }

  #abort(): void {
    const topic = activeTopic(this.#state);
    const aborted = topic ? this.#client.abort(topic.id) : false;
    this.#state = {
      ...this.#state,
      notice: aborted ? "Turn aborted" : "Nothing is running",
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
