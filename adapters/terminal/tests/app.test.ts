import { expect, test } from "bun:test";
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
  TerminalApp,
  terminalDeletionShortcut,
  terminalNeedsAnimation,
  topicFilterInsertion,
  vaultFormBlocksOverlaySwitch,
} from "@/app";
import {
  INITIAL_MESSAGE_HISTORY_LIMIT,
  INITIAL_MESSAGE_HISTORY_PAGE_COUNT,
  MESSAGE_HISTORY_PAGE_SIZE,
  type NegotiumClient,
} from "@/client";
import { stripAnsi, WORKING_FRAME_INTERVAL_MS } from "@/render";
import { highlightScreenSelection, screenSelectionText } from "@/selection";
import { applyRuntimeEvent, createInitialState, setTopics, startTopicCreation } from "@/state";
import { TerminalAlreadyOwnedError, terminalRestoreInstalled } from "@/terminal-restore";

const TOPIC = {
  id: "topic",
  title: "Terminal",
  kind: "agent" as const,
  agent: "codex" as const,
  defaultModel: "gpt",
  defaultEffort: "medium" as const,
  participants: [{ userId: "local", role: "owner" as const }],
  createdAt: "2026-01-01T00:00:00.000Z",
  lastMessageAt: "2026-01-01T00:00:00.000Z",
};

function setTty(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { configurable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };
}

test("translates SGR mouse wheel events into conversation scrolling", () => {
  expect(consumeMouseInput("\u001b[<64;10;5M\u001b[<64;10;5M\u001b[<65;10;5Mtext")).toEqual({
    input: "text",
    scrollDelta: 3,
    horizontalScrollDelta: 0,
    events: [],
  });
});

test("preserves horizontal and Shift-wheel mouse movement", () => {
  expect(
    consumeMouseInput("\u001b[<66;10;5M\u001b[<67;10;5M\u001b[<68;10;5M\u001b[<68;10;5M"),
  ).toEqual({
    input: "",
    scrollDelta: 0,
    horizontalScrollDelta: 6,
    events: [],
  });
});

test("preloads three message pages before requiring explicit older-history loading", () => {
  expect(MESSAGE_HISTORY_PAGE_SIZE).toBe(50);
  expect(INITIAL_MESSAGE_HISTORY_PAGE_COUNT).toBe(3);
  expect(INITIAL_MESSAGE_HISTORY_LIMIT).toBe(150);
});

test("applies spinner status immediately while message history is loading", () => {
  const statusEvent = (kind: string) => ({
    type: "ai-status" as const,
    topicId: TOPIC.id,
    payload: { kind, queryId: "query" },
  });

  expect(runtimeEventWaitsForMessageLoad(statusEvent("ai_active"))).toBe(false);
  expect(runtimeEventWaitsForMessageLoad(statusEvent("ai_done"))).toBe(false);
  expect(runtimeEventWaitsForMessageLoad(statusEvent("ai_aborted"))).toBe(false);
  expect(runtimeEventWaitsForMessageLoad(statusEvent("tool_status"))).toBe(false);
  expect(runtimeEventWaitsForMessageLoad(statusEvent("tool_call"))).toBe(true);
  expect(runtimeEventWaitsForMessageLoad(statusEvent("tool_output"))).toBe(true);
  expect(
    runtimeEventWaitsForMessageLoad({
      type: "message",
      topicId: TOPIC.id,
      payload: { id: "message" },
    }),
  ).toBe(true);
});

test("keeps a screen selection when a background topic emits an event", () => {
  const state = { ...createInitialState("local"), activeTopicId: TOPIC.id };

  expect(runtimeEventInvalidatesSelection(state, { topicId: "background-topic" })).toBe(false);
  expect(runtimeEventInvalidatesSelection(state, { topicId: TOPIC.id })).toBe(true);
});

test("derives animation frames from elapsed time instead of callback count", () => {
  expect(animationFrameAt(0)).toBe(0);
  expect(animationFrameAt(WORKING_FRAME_INTERVAL_MS - 1)).toBe(0);
  expect(animationFrameAt(WORKING_FRAME_INTERVAL_MS)).toBe(1);
  expect(animationFrameAt(WORKING_FRAME_INTERVAL_MS * 7)).toBe(7);
});

test("keeps graph animation active while only a child agent is working", () => {
  const child = {
    ...TOPIC,
    id: "child",
    title: "Child",
    parentTopicId: TOPIC.id,
    isSubagent: true,
  };
  const state = applyRuntimeEvent(
    {
      ...setTopics(createInitialState("local"), [TOPIC, child]),
      overlay: "subagents" as const,
    },
    {
      type: "ai-status",
      topicId: child.id,
      payload: { kind: "ai_active", queryId: "child-query" },
    },
  );

  expect(terminalNeedsAnimation(state)).toBe(true);
  expect(terminalNeedsAnimation({ ...state, overlay: null })).toBe(false);
});

test("parses left-button drag selection events", () => {
  expect(consumeMouseInput("\u001b[<0;3;4M\u001b[<32;8;4M\u001b[<0;8;4m")).toEqual({
    input: "",
    scrollDelta: 0,
    horizontalScrollDelta: 0,
    events: [
      { button: 0, x: 3, y: 4, kind: "press" },
      { button: 32, x: 8, y: 4, kind: "drag" },
      { button: 0, x: 8, y: 4, kind: "release" },
    ],
  });
});

test("hits the visible code copy header bounds", () => {
  const target = { xStart: 20, xEnd: 25, y: 7, text: "echo copied" };
  expect(codeCopyTargetAt([target], { x: 20, y: 7 })?.text).toBe("echo copied");
  expect(codeCopyTargetAt([target], { x: 25, y: 7 })?.text).toBe("echo copied");
  expect(codeCopyTargetAt([target], { x: 19, y: 7 })).toBeUndefined();
  expect(codeCopyTargetAt([target], { x: 20, y: 8 })).toBeUndefined();
});

test("extracts and highlights screen-column selections with wide glyphs", () => {
  const selection = { anchor: { x: 2, y: 1 }, focus: { x: 4, y: 1 } };
  expect(screenSelectionText(["a한bc"], selection)).toBe("한b");

  const highlighted = highlightScreenSelection("\u001b[31ma한bc\u001b[0m", selection);
  expect(stripAnsi(highlighted)).toBe("a한bc");
  expect(highlighted).toContain("\u001b[7m");
  expect(highlighted).toContain("\u001b[27m");
});

// Explicit escapes: a composed-looking `\u00e9` in the source would silently
// test the wrong thing.
const E_ACUTE = "e\u0301"; // NFD: e + COMBINING ACUTE ACCENT
const HEART_VS16 = "\u2764\ufe0f"; // heart + VARIATION SELECTOR-16

test("keeps combining marks with the cell they decorate when copying a selection", () => {
  const cell = (x: number) => ({ anchor: { x, y: 1 }, focus: { x, y: 1 } });
  const line = `${E_ACUTE}x`;

  // The accent occupies no column of its own, so column arithmetic alone
  // dropped it: selecting the first cell yielded a bare "e". That is silent
  // data loss on the way to the clipboard.
  expect(screenSelectionText([line], cell(1))).toBe(E_ACUTE);
  // It belongs to the *preceding* cell, so selecting the next one must not
  // drag it along.
  expect(screenSelectionText([line], cell(2))).toBe("x");
  expect(screenSelectionText([line], { anchor: { x: 1, y: 1 }, focus: { x: 2, y: 1 } })).toBe(line);

  // A stack of marks all attach to the same base.
  expect(screenSelectionText([`e\u0301\u0308x`], cell(1))).toBe("e\u0301\u0308");
  // Variation selectors and ZWJ are zero-width for the same reason.
  expect(screenSelectionText([`a${HEART_VS16}b`], cell(2))).toBe(HEART_VS16);
  // A defective cluster (mark with no base) still belongs to the first cell.
  expect(screenSelectionText(["\u0301ab"], cell(1))).toBe("\u0301a");
});

test("extends the selection highlight over combining marks", () => {
  const highlighted = highlightScreenSelection(`${E_ACUTE}x`, {
    anchor: { x: 1, y: 1 },
    focus: { x: 1, y: 1 },
  });
  // Plain text is never altered by highlighting.
  expect(stripAnsi(highlighted)).toBe(`${E_ACUTE}x`);
  // The inverse video used to end between the `e` and its accent, leaving the
  // accent drawn on an unhighlighted cell.
  expect(highlighted).toBe(`\u001b[7m${E_ACUTE}\u001b[27mx`);
});

test("Esc stops a running turn only from the active conversation", () => {
  const idle = setTopics(createInitialState("local"), [TOPIC]);
  const running = applyRuntimeEvent(idle, {
    type: "ai-status",
    topicId: TOPIC.id,
    payload: { kind: "ai_active", queryId: "running-query" },
  });

  expect(escapeStopsActiveTurn(idle)).toBe(false);
  expect(escapeStopsActiveTurn(running)).toBe(true);
  const topicPicker = { ...running, overlay: "topics" as const };
  expect(escapeStopsActiveTurn(topicPicker)).toBe(false);
  expect(ctrlCExitsTopicPicker(topicPicker)).toBe(true);
  expect(ctrlCExitsTopicPicker(running)).toBe(false);
  expect(escapeStopsActiveTurn(startTopicCreation(running))).toBe(false);
});

test("Vault secret entry keeps global shortcuts inside the masking overlay", () => {
  const state = { ...createInitialState("local"), overlay: "vault" as const };

  expect(vaultFormBlocksOverlaySwitch({ ...state, vaultMode: "key" })).toBe(false);
  expect(vaultFormBlocksOverlaySwitch({ ...state, vaultMode: "value" })).toBe(true);
  expect(vaultFormBlocksOverlaySwitch({ ...state, vaultMode: "description" })).toBe(true);
  expect(vaultFormBlocksOverlaySwitch({ ...state, vaultMode: "list" })).toBe(false);
});

test("recognizes word and line deletion shortcuts across terminal protocols", () => {
  expect(terminalDeletionShortcut("\u001b\u007f")).toBe("word-left");
  expect(terminalDeletionShortcut("\u001b\b")).toBe("word-left");
  expect(terminalDeletionShortcut("\u001b[127;3u")).toBe("word-left");
  expect(terminalDeletionShortcut("\u001b[8;3u")).toBe("word-left");
  expect(terminalDeletionShortcut("\u001b[27;3;127~")).toBe("word-left");
  expect(terminalDeletionShortcut("\u0017")).toBe("word-left");

  expect(terminalDeletionShortcut("\u001b[127;9u")).toBe("line-left");
  expect(terminalDeletionShortcut("\u001b[8;9u")).toBe("line-left");
  expect(terminalDeletionShortcut("\u001b[27;9;127~")).toBe("line-left");
  expect(terminalDeletionShortcut("\u0015")).toBe("line-left");
  expect(terminalDeletionShortcut("\u007f")).toBeNull();
});

test("Maestro model selection opens the matching provider key form", () => {
  expect(maestroVaultKeyForModel("kimi-k3")).toBe("MOONSHOT_API_KEY");
  expect(maestroVaultKeyForModel("kimi-k2.7-code")).toBe("MOONSHOT_API_KEY");
  expect(maestroVaultKeyForModel("deepseek-pro")).toBe("DEEPSEEK_API_KEY");
  expect(maestroVaultKeyForModel("gpt-5.6-sol")).toBeNull();
});

test("bare Vault opens the manager while list, set, and del stay compact", async () => {
  const commands: string[] = [];
  const client = {
    runVaultCommand(commandLine: string) {
      commands.push(commandLine);
      if (commandLine === "/vault list") return "Vault keys (1):\n- API_KEY: test credential";
      return commandLine.includes(" set ") ? "Stored API_KEY." : "Deleted API_KEY.";
    },
  };

  expect(await runTerminalVaultCommand(client, "/vault")).toEqual({ kind: "open-manager" });
  expect(await runTerminalVaultCommand(client, "/vault list")).toEqual({
    kind: "notice",
    notice: "Vault keys (1): - API_KEY: test credential",
  });
  expect(await runTerminalVaultCommand(client, "/vault set API_KEY top-secret")).toEqual({
    kind: "notice",
    notice: "Stored API_KEY.",
  });
  expect(await runTerminalVaultCommand(client, "/vault del API_KEY")).toEqual({
    kind: "notice",
    notice: "Deleted API_KEY.",
  });
  expect(commands).toEqual(["/vault list", "/vault set API_KEY top-secret", "/vault del API_KEY"]);
});

test("compact Vault command failures never reflect plaintext command details", async () => {
  const secret = "do-not-render-this-secret";
  const outcome = await runTerminalVaultCommand(
    {
      runVaultCommand() {
        throw new Error(`request failed: /vault set API_KEY ${secret}`);
      },
    },
    `/vault set API_KEY ${secret}`,
  );

  expect(outcome).toEqual({
    kind: "notice",
    notice: "Vault command failed. Check the node connection.",
  });
  expect(JSON.stringify(outcome)).not.toContain(secret);
});

test("compact Vault command rejects unknown subcommands without contacting the client", async () => {
  let calls = 0;
  const outcome = await runTerminalVaultCommand(
    {
      runVaultCommand() {
        calls += 1;
        return null;
      },
    },
    "/vault get API_KEY",
  );

  expect(outcome.kind).toBe("notice");
  expect(calls).toBe(0);
});

test("stops a started client when terminal initialization fails", async () => {
  let stopped = 0;
  const client: NegotiumClient = {
    async start() {},
    async stop() {
      stopped += 1;
    },
    listTopics() {
      throw new Error("topic store unavailable");
    },
    listMessages() {
      return [];
    },
    createTopic() {
      throw new Error("not reached");
    },
    async deriveTopic() {
      throw new Error("not reached");
    },
    async resetTopic() {
      throw new Error("not reached");
    },
    async compactTopic() {
      throw new Error("not reached");
    },
    setModel() {
      throw new Error("not reached");
    },
    setEffort() {
      throw new Error("not reached");
    },
    setAccessMode() {
      throw new Error("not reached");
    },
    async deleteTopic() {
      throw new Error("not reached");
    },
    sendMessage() {
      throw new Error("not reached");
    },
    answerQuestion() {
      return { ok: false };
    },
    abort() {
      return false;
    },
    runVaultCommand() {
      return null;
    },
  };
  const restoreStdin = setTty(process.stdin, true);
  const restoreStdout = setTty(process.stdout, true);

  try {
    const app = new TerminalApp(client, { userId: "terminal-test" });
    await expect(app.run()).rejects.toThrow("topic store unavailable");
    expect(stopped).toBe(1);
  } finally {
    restoreStdin();
    restoreStdout();
  }
});

test("bare letters type into the topic picker filter instead of firing actions", () => {
  // The whole point of the Ctrl-N/Ctrl-D migration: n and d are now text.
  expect(topicFilterInsertion("n")).toBe("n");
  expect(topicFilterInsertion("d")).toBe("d");
  expect(topicFilterInsertion("y")).toBe("y");
  // Hangul jamo and completed syllables are literal text as well.
  expect(topicFilterInsertion("ㅜ")).toBe("ㅜ");
  expect(topicFilterInsertion("ㅇ")).toBe("ㅇ");
  expect(topicFilterInsertion("회")).toBe("회");
  expect(topicFilterInsertion(" ")).toBe(" ");
});

test("control chords and escape sequences never reach the topic picker filter", () => {
  for (const chunk of [
    "\u000e", // Ctrl-N, new topic
    "\u0004", // Ctrl-D, delete topic
    "\u0010", // Ctrl-P, toggles the picked topic between public and private
    "\u0003", // Ctrl-C
    "\r",
    "\t",
    "\u007f", // Backspace
    "\u001b", // Escape
    "\u001b[A", // Up
    "\u001b[B", // Down
    "\u001b[3~", // Delete
    "\u001b[200~", // bracketed paste start
    "",
  ]) {
    expect(topicFilterInsertion(chunk)).toBeNull();
  }
});

const CTRL_O = "\u000f"; // Ctrl-O toggles the topic picker
const OPEN_PASTE = "\u001b[200~";
const CLOSE_PASTE = "\u001b[201~";

test("a paste made while the topic picker is open lands in the filter, not the hidden composer", async () => {
  // The composer is hidden behind the picker, so inserting there put the text
  // somewhere invisible; it only surfaced once the overlay was closed again.
  const client: NegotiumClient = {
    async start() {},
    async stop() {},
    listTopics: () => [TOPIC],
    listMessages: () => [],
    createTopic() {
      throw new Error("not reached");
    },
    async deriveTopic() {
      throw new Error("not reached");
    },
    async resetTopic() {
      throw new Error("not reached");
    },
    async compactTopic() {
      throw new Error("not reached");
    },
    setModel() {
      throw new Error("not reached");
    },
    setEffort() {
      throw new Error("not reached");
    },
    setAccessMode() {
      throw new Error("not reached");
    },
    async deleteTopic() {
      throw new Error("not reached");
    },
    sendMessage() {
      throw new Error("not reached");
    },
    answerQuestion: () => ({ ok: false }),
    abort: () => false,
    runVaultCommand: () => null,
  };
  const restoreStdin = setTty(process.stdin, true);
  const restoreStdout = setTty(process.stdout, true);
  const stdin = process.stdin as unknown as Record<string, unknown>;
  const hadRawMode = typeof stdin.setRawMode === "function";
  if (!hadRawMode) stdin.setRawMode = () => process.stdin;
  const realWrite = process.stdout.write.bind(process.stdout);
  const frames: string[] = [];
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    frames.push(String(chunk));
    return true;
  };
  const app = new TerminalApp(client, { userId: "local", preferredTopic: TOPIC.title });
  const finished = app.run();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  const feed = (data: string) => process.stdin.emit("data", data);
  const screen = () => stripAnsi(frames.join(""));

  try {
    await settle();
    feed(CTRL_O);
    await settle();
    frames.length = 0;
    feed(`${OPEN_PASTE}zz\nqq${CLOSE_PASTE}`);
    await settle();
    // Newlines become spaces: the filter is a single line, and keeping only the
    // first line would silently discard what the user pasted.
    expect(screen()).toContain("Filter: zz qq");

    // A bare ESC is held briefly because it could have begun a longer escape
    // sequence. With no following byte it must flush to the picker, where this
    // first Escape clears the filter rather than leaving the key unresponsive.
    frames.length = 0;
    feed("\u001b");
    await settle();
    expect(screen()).not.toContain("Filter: zz qq");

    // Ctrl-O closes the picker without touching the composer (Escape clears the
    // draft, which would hide the very thing under test).
    frames.length = 0;
    feed(CTRL_O);
    await settle();
    const closed = screen();
    expect(closed).not.toContain("zz");
    expect(closed).not.toContain("qq");
  } finally {
    app.stop();
    await finished;
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    if (!hadRawMode) delete stdin.setRawMode;
    restoreStdin();
    restoreStdout();
  }
});

test("rejects a second terminal adapter without disturbing the running one", async () => {
  const client: NegotiumClient = {
    async start() {},
    async stop() {},
    listTopics: () => [TOPIC],
    listMessages: () => [],
    createTopic() {
      throw new Error("not reached");
    },
    async deriveTopic() {
      throw new Error("not reached");
    },
    async resetTopic() {
      throw new Error("not reached");
    },
    async compactTopic() {
      throw new Error("not reached");
    },
    setModel() {
      throw new Error("not reached");
    },
    setEffort() {
      throw new Error("not reached");
    },
    setAccessMode() {
      throw new Error("not reached");
    },
    async deleteTopic() {
      throw new Error("not reached");
    },
    sendMessage() {
      throw new Error("not reached");
    },
    answerQuestion: () => ({ ok: false }),
    abort: () => false,
    runVaultCommand: () => null,
  };
  const restoreStdin = setTty(process.stdin, true);
  const restoreStdout = setTty(process.stdout, true);
  const stdin = process.stdin as unknown as Record<string, unknown>;
  const hadRawMode = typeof stdin.setRawMode === "function";
  let rawMode = false;
  const realRawMode = stdin.setRawMode;
  stdin.setRawMode = (value: boolean) => {
    rawMode = value;
    return process.stdin;
  };
  const realWrite = process.stdout.write.bind(process.stdout);
  const frames: string[] = [];
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    frames.push(String(chunk));
    return true;
  };
  const first = new TerminalApp(client, { userId: "local", preferredTopic: TOPIC.title });
  const firstFinished = first.run();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  try {
    await settle();
    expect(rawMode).toBe(true);
    const framesBefore = frames.length;
    const listenersBefore = process.listenerCount("SIGHUP");

    // Two TUIs cannot share one terminal: the second would push the kitty flag
    // again and, on exit, drop the process-global stdin out of raw mode under
    // the first one. It is rejected before it writes a single byte.
    const second = new TerminalApp(client, { userId: "local", preferredTopic: TOPIC.title });
    await expect(second.run()).rejects.toThrow(TerminalAlreadyOwnedError);

    expect(frames.length).toBe(framesBefore);
    expect(rawMode).toBe(true);
    expect(process.listenerCount("SIGHUP")).toBe(listenersBefore);
    expect(terminalRestoreInstalled()).toBe(true);
  } finally {
    first.stop();
    await firstFinished;
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    if (hadRawMode) stdin.setRawMode = realRawMode;
    else delete stdin.setRawMode;
    restoreStdin();
    restoreStdout();
  }

  // Ownership was handed back, so a fresh adapter can start.
  expect(terminalRestoreInstalled()).toBe(false);
});

const PASTE_OPEN = "\u001b[200~";
const PASTE_CLOSE = "\u001b[201~";
const SGR_CLICK = "\u001b[<0;10;5M"; // a real one starts a drag selection
const CTRL_O_CHORD = "\u000f"; // a real one opens the topic overlay

test("a spoofed paste-end cannot turn the rest of the burst into actions", async () => {
  const sent: string[] = [];
  const client: NegotiumClient = {
    async start() {},
    async stop() {},
    listTopics: () => [TOPIC],
    listMessages: () => [],
    createTopic() {
      throw new Error("not reached");
    },
    async deriveTopic() {
      throw new Error("not reached");
    },
    async resetTopic() {
      throw new Error("not reached");
    },
    async compactTopic() {
      throw new Error("not reached");
    },
    setModel() {
      throw new Error("not reached");
    },
    setEffort() {
      throw new Error("not reached");
    },
    setAccessMode() {
      throw new Error("not reached");
    },
    async deleteTopic() {
      throw new Error("not reached");
    },
    sendMessage(topic, text) {
      sent.push(text);
      return {
        id: `message-${sent.length}`,
        topicId: topic.id,
        authorId: "local",
        text,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
    answerQuestion: () => ({ ok: false }),
    abort: () => false,
    runVaultCommand: () => null,
  };
  const restoreStdin = setTty(process.stdin, true);
  const restoreStdout = setTty(process.stdout, true);
  const stdin = process.stdin as unknown as Record<string, unknown>;
  const hadRawMode = typeof stdin.setRawMode === "function";
  if (!hadRawMode) stdin.setRawMode = () => process.stdin;
  const realWrite = process.stdout.write.bind(process.stdout);
  const frames: string[] = [];
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    frames.push(String(chunk));
    return true;
  };
  const app = new TerminalApp(client, { userId: "local", preferredTopic: TOPIC.title });
  const finished = app.run();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  const screen = () => stripAnsi(frames.join(""));

  try {
    await settle();
    frames.length = 0;
    // Payload carrying its own end marker, a mouse report and a re-open, then
    // the real end marker: the splitter is obliged to believe the first end
    // marker, so the middle arrives as a separate keys segment.
    process.stdin.emit(
      "data",
      `${PASTE_OPEN}head${PASTE_CLOSE}${SGR_CLICK}tail${PASTE_OPEN}rest${PASTE_CLOSE}`,
    );
    await settle();
    const output = screen();

    // Every printable part survives, in order, as composer text, and the escape
    // bytes are sanitised rather than typed.
    expect(output).toContain("head");
    expect(output).toContain("tail");
    expect(output).toContain("rest");
    expect(output).not.toContain("[<0;10;5M");

    // A chord alone in the tail is the case that actually *acts*: on its own it
    // would open the topic overlay. After a paste it must not.
    frames.length = 0;
    process.stdin.emit("data", `${PASTE_OPEN}x${PASTE_CLOSE}${CTRL_O_CHORD}`);
    await settle();
    expect(screen()).not.toContain("Topics");
    expect(sent).toEqual([]);

    // Sanity check that the chord does work when it is not riding a paste.
    frames.length = 0;
    process.stdin.emit("data", CTRL_O_CHORD);
    await settle();
    expect(screen()).toContain("Topics");

    // A normal paste followed by real, later input is not affected. The left
    // arrow proves a separate escape-sequence chunk still dispatches, and the
    // subsequent Enter sends the resulting composer text.
    process.stdin.emit("data", CTRL_O_CHORD);
    await settle();
    process.stdin.emit("data", "\u001b");
    await settle();
    process.stdin.emit("data", `${PASTE_OPEN}normal${PASTE_CLOSE}`);
    await settle();
    process.stdin.emit("data", "\u001b[D");
    await settle();
    process.stdin.emit("data", "!");
    await settle();
    process.stdin.emit("data", "\r");
    await settle();
    expect(sent).toEqual(["norma!l"]);
  } finally {
    app.stop();
    await finished;
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    if (!hadRawMode) delete stdin.setRawMode;
    restoreStdin();
    restoreStdout();
  }
});
