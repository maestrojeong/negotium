import { expect, test } from "bun:test";
import { consumeMouseInput, TerminalApp } from "@/app";
import {
  INITIAL_MESSAGE_HISTORY_LIMIT,
  INITIAL_MESSAGE_HISTORY_PAGE_COUNT,
  MESSAGE_HISTORY_PAGE_SIZE,
  type NegotiumClient,
} from "@/client";
import { stripAnsi } from "@/render";
import { highlightScreenSelection, screenSelectionText } from "@/selection";

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
    events: [],
  });
});

test("preloads three message pages before requiring explicit older-history loading", () => {
  expect(MESSAGE_HISTORY_PAGE_SIZE).toBe(50);
  expect(INITIAL_MESSAGE_HISTORY_PAGE_COUNT).toBe(3);
  expect(INITIAL_MESSAGE_HISTORY_LIMIT).toBe(150);
});

test("parses left-button drag selection events", () => {
  expect(consumeMouseInput("\u001b[<0;3;4M\u001b[<32;8;4M\u001b[<0;8;4m")).toEqual({
    input: "",
    scrollDelta: 0,
    events: [
      { button: 0, x: 3, y: 4, kind: "press" },
      { button: 32, x: 8, y: 4, kind: "drag" },
      { button: 0, x: 8, y: 4, kind: "release" },
    ],
  });
});

test("extracts and highlights screen-column selections with wide glyphs", () => {
  const selection = { anchor: { x: 2, y: 1 }, focus: { x: 4, y: 1 } };
  expect(screenSelectionText(["a한bc"], selection)).toBe("한b");

  const highlighted = highlightScreenSelection("\u001b[31ma한bc\u001b[0m", selection);
  expect(stripAnsi(highlighted)).toBe("a한bc");
  expect(highlighted).toContain("\u001b[7m");
  expect(highlighted).toContain("\u001b[27m");
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
    async resetTopic() {
      throw new Error("not reached");
    },
    async compactTopic() {
      throw new Error("not reached");
    },
    setModel() {
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
