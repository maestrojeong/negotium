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
