import { expect, test } from "bun:test";
import { TerminalApp } from "@/app";
import type { NegotiumClient } from "@/client";
import { displayWidth, shellPaneRows, stripAnsi } from "@/render";
import { ptySupport, ShellPane, shellPastePayload } from "@/shell-pane";

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

const withPty = ptySupport() ? test : test.skip;

function setTty(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", { configurable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };
}

test("bracketed paste wraps the payload and cannot be closed early from inside", () => {
  expect(shellPastePayload("ls", false)).toBe("ls");
  expect(shellPastePayload("a\u001b[201~b", true)).toBe("\u001b[200~ab\u001b[201~");
});

test("shell pane rows are always exactly the pane width", () => {
  const rows = shellPaneRows(null, 20, 3);
  expect(rows).toHaveLength(3);
  for (const row of rows) expect(displayWidth(stripAnsi(row))).toBe(20);
});

withPty("a shell pane runs real commands and exits cleanly", async () => {
  let exited = -1;
  const pane = new ShellPane({
    cols: 40,
    rows: 6,
    cwd: "/tmp",
    shell: "/bin/sh",
    onChange: () => {},
    onExit: (code) => {
      exited = code;
    },
  });
  await Bun.sleep(250);
  pane.write("echo pane-$((40+2))\r");
  await Bun.sleep(300);
  const text = pane
    .snapshot()
    .lines.map((runs) => runs.map((run) => run.text).join(""))
    .join("\n");
  expect(text).toContain("pane-42");
  for (const runs of pane.snapshot().lines) {
    expect(runs.reduce((sum, run) => sum + run.width, 0)).toBe(40);
  }
  pane.write("exit\r");
  await Bun.sleep(300);
  expect(pane.disposed).toBe(true);
  expect(exited).toBe(0);
});

withPty("Ctrl-T opens a shell pane on the right, keys reach it, and Ctrl-T closes it", async () => {
  const nope = () => {
    throw new Error("not reached");
  };
  const client = {
    async start() {},
    async stop() {},
    listTopics: () => [TOPIC],
    listMessages: () => [],
    createTopic: nope,
    deriveTopic: nope,
    resetTopic: nope,
    compactTopic: nope,
    setModel: nope,
    setEffort: nope,
    deleteTopic: nope,
    sendMessage: nope,
    answerQuestion: () => ({ ok: false }),
    abort: () => false,
    runVaultCommand: () => null,
  } as unknown as NegotiumClient;
  const restoreStdin = setTty(process.stdin, true);
  const restoreStdout = setTty(process.stdout, true);
  const stdin = process.stdin as unknown as Record<string, unknown>;
  const hadRawMode = typeof stdin.setRawMode === "function";
  if (!hadRawMode) stdin.setRawMode = () => process.stdin;
  const stdout = process.stdout as unknown as { columns?: number; rows?: number };
  const previousColumns = stdout.columns;
  const previousRows = stdout.rows;
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  stdout.columns = 140;
  stdout.rows = 24;
  const realWrite = process.stdout.write.bind(process.stdout);
  const frames: string[] = [];
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    frames.push(String(chunk));
    return true;
  };
  const app = new TerminalApp(client, { userId: "local", preferredTopic: TOPIC.title });
  const finished = app.run();
  const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
  const feed = (data: string) => process.stdin.emit("data", data);
  const screen = () => stripAnsi(frames.join(""));
  try {
    await settle();
    frames.length = 0;
    feed("\u0014"); // Ctrl-T
    await settle(400);
    // The pane's divider sits at the right; the composer keeps its own column.
    expect(screen()).toContain("│");
    frames.length = 0;
    feed("echo from-$((1+1))-pane\r");
    await settle(400);
    expect(screen()).toContain("from-2-pane");
    frames.length = 0;
    feed("\u0014"); // Ctrl-T again hides it
    await settle(200);
    expect(screen()).not.toContain("from-2-pane");
  } finally {
    app.stop();
    await finished;
    (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
    stdout.columns = previousColumns;
    stdout.rows = previousRows;
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    if (!hadRawMode) delete stdin.setRawMode;
    restoreStdin();
    restoreStdout();
  }
});
