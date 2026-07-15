import { expect, test } from "bun:test";
import { consumeMouseInput, TerminalApp } from "@/app";
import type { NegotiumClient } from "@/client";

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
  });
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
