import { expect, test } from "bun:test";
import { TerminalApp } from "@/app";
import type { NegotiumClient } from "@/client";
import { stripAnsi } from "@/render";

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

const CTRL_O = "\u000f"; // opens the topic picker
const CTRL_P = "\u0010"; // toggles the picked topic's access mode
const DOWN = "\u001b[B";

function setTty(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { configurable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };
}

function accessModeClient(
  overrides: Pick<NegotiumClient, "listTopics" | "setAccessMode">,
): NegotiumClient {
  return {
    async start() {},
    async stop() {},
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
    async deleteTopic() {
      throw new Error("not reached");
    },
    sendMessage() {
      throw new Error("not reached");
    },
    answerQuestion: () => ({ ok: false }),
    abort: () => false,
    runVaultCommand: () => null,
    ...overrides,
  } as NegotiumClient;
}

interface DrivenIo {
  feed: (data: string) => void;
  settle: () => Promise<unknown>;
  screen: () => string;
  clear: () => void;
}

/**
 * Drive a real `TerminalApp` over stdin and hand the test a screen reader.
 *
 * The picker only exists inside a running app loop, so these cases cannot be
 * expressed against the pure state helpers: the point under test is that a
 * keystroke reaches the overlay and that the overlay is what ends up on screen.
 */
async function withDrivenApp(
  client: NegotiumClient,
  run: (io: DrivenIo) => Promise<void>,
): Promise<void> {
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
  try {
    await run({
      feed: (data: string) => {
        process.stdin.emit("data", data);
      },
      settle: () => new Promise((resolve) => setTimeout(resolve, 40)),
      screen: () => stripAnsi(frames.join("")),
      clear: () => {
        frames.length = 0;
      },
    });
  } finally {
    app.stop();
    await finished;
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    if (!hadRawMode) delete stdin.setRawMode;
    restoreStdin();
    restoreStdout();
  }
}

test("Ctrl-P asks before publishing a private topic, then applies the switch on y", async () => {
  const calls: Array<{ topicId: string; accessMode: string }> = [];
  let accessMode: "private" | "shared" = "private";
  const client = accessModeClient({
    listTopics: () => [{ ...TOPIC, accessMode }],
    setAccessMode(topic, next) {
      calls.push({ topicId: topic.id, accessMode: next });
      accessMode = next;
      return next === "shared" ? "Terminal is public." : "Terminal is private.";
    },
  });

  await withDrivenApp(client, async ({ feed, settle, screen, clear }) => {
    await settle();
    feed(CTRL_O);
    await settle();

    // Publishing is the direction that cannot be taken back, so the keystroke
    // alone must not be enough to do it.
    clear();
    feed(CTRL_P);
    await settle();
    expect(screen()).toContain("public?");
    expect(calls).toEqual([]);

    clear();
    feed("y");
    await settle();
    expect(calls).toEqual([{ topicId: TOPIC.id, accessMode: "shared" }]);
    // Back in the picker rather than the conversation: the user was browsing
    // the list when they pressed the key. The topic has also moved under the
    // Public heading, which is the whole point of refreshing in place.
    expect(screen()).toContain("Enter open");
    expect(screen()).toContain("Public");

    // The reverse only narrows reach, so it applies with no prompt at all.
    clear();
    feed(CTRL_P);
    await settle();
    expect(calls).toEqual([
      { topicId: TOPIC.id, accessMode: "shared" },
      { topicId: TOPIC.id, accessMode: "private" },
    ]);
  });
});

test("declining the publish prompt leaves the topic private and reopens the picker", async () => {
  const calls: string[] = [];
  const client = accessModeClient({
    listTopics: () => [{ ...TOPIC, accessMode: "private" as const }],
    setAccessMode(_topic, next) {
      calls.push(next);
      return "unexpected";
    },
  });

  await withDrivenApp(client, async ({ feed, settle, screen, clear }) => {
    await settle();
    feed(CTRL_O);
    await settle();
    feed(CTRL_P);
    await settle();

    clear();
    feed("n");
    await settle();
    expect(calls).toEqual([]);
    expect(screen()).toContain("Enter open");
    expect(screen()).toContain("Private");
    expect(screen()).not.toContain("public?");
  });
});

const SUBAGENT = {
  ...TOPIC,
  id: "topic-sub",
  title: "Terminal worker",
  parentTopicId: TOPIC.id,
  isSubagent: true,
  accessMode: "private" as const,
};

test("the manager row refuses the toggle instead of reporting a publish that cannot happen", async () => {
  // `publishTopic` only ever ships `kind: "agent"` rooms, and the picker keeps
  // manager rows in their own group with no access-mode badge — so without
  // this guard the flow prompts, writes the flag, claims success, and nothing
  // observable changes. The manager room is also the default highlight.
  const calls: string[] = [];
  const client = accessModeClient({
    listTopics: () => [{ ...TOPIC, kind: "manager" as const, accessMode: "private" as const }],
    setAccessMode(_topic, next) {
      calls.push(next);
      return "unexpected";
    },
  });

  await withDrivenApp(client, async ({ feed, settle, screen, clear }) => {
    await settle();
    feed(CTRL_O);
    await settle();
    clear();
    feed(CTRL_P);
    await settle();
    expect(screen()).not.toContain("public?");
    expect(calls).toEqual([]);
    expect(screen()).toContain("cannot be published");
  });
});

test("a subagent row refuses the toggle outright instead of prompting", async () => {
  const calls: string[] = [];
  const client = accessModeClient({
    listTopics: () => [{ ...TOPIC, accessMode: "private" as const }, SUBAGENT],
    setAccessMode(_topic, next) {
      calls.push(next);
      return "unexpected";
    },
  });

  await withDrivenApp(client, async ({ feed, settle, screen, clear }) => {
    await settle();
    feed(CTRL_O);
    await settle();
    clear();
    feed(DOWN);
    feed(CTRL_P);
    await settle();
    // No publish prompt and no write: a subagent's privacy belongs to whoever
    // spawned it, so the key has nothing to toggle here.
    expect(screen()).not.toContain("public?");
    expect(calls).toEqual([]);
    expect(screen()).toContain("inherit privacy");
  });
});

test("the publish prompt counts subagent rooms transitively, not just direct children", async () => {
  // A grandchild is as exposed as a direct child, so a count that stops at
  // depth 1 understates the blast radius of the action being confirmed. With
  // only a direct child in the fixture, swapping the transitive walk for a
  // one-level filter would still pass.
  const client = accessModeClient({
    listTopics: () => [
      { ...TOPIC, accessMode: "private" as const },
      SUBAGENT,
      {
        ...SUBAGENT,
        id: "topic-sub-sub",
        title: "Terminal worker worker",
        parentTopicId: SUBAGENT.id,
      },
    ],
    setAccessMode: () => "unexpected",
  });

  await withDrivenApp(client, async ({ feed, settle, screen, clear }) => {
    await settle();
    feed(CTRL_O);
    await settle();
    clear();
    feed(CTRL_P);
    await settle();
    expect(screen()).toContain("2 subagent rooms become");
  });
});
