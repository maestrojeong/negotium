import { afterEach, describe, expect, test } from "bun:test";
import {
  answerPendingAskUserQuestion,
  cancelPendingAskUserQuestions,
  createAskUserToolDefinition,
} from "#agents/mcp-tools/ask-user";
import { runtimeBus, setRuntimeBus } from "#bus";
import { appendApiMessage, getApiMessage, listApiMessages } from "#storage/api-messages";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { prepareAskUserGate, quarantineForeignAskUserGates } from "#storage/ask-user-gates";
import type { MessageDto } from "#types/api";

const USER = "ask-user-test-user";
const createdTopicIds: string[] = [];

function seedTopic(): string {
  const id = `ask-user-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `Ask User ${id}`,
    agent: "maestro",
    defaultModel: "deepseek-pro",
    defaultEffort: "medium",
    participants: [{ userId: USER, role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  createdTopicIds.push(id);
  return id;
}

afterEach(() => {
  for (const topicId of createdTopicIds.splice(0)) deleteTopic(topicId);
});

describe("runtime ask_user_question", () => {
  test("a host answer resumes the same blocked MCP call and persists the selection", async () => {
    const topicId = seedTopic();
    let askMessage: MessageDto | undefined;
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type !== "message" || event.topicId !== topicId) return;
      const message = event.payload as MessageDto;
      if (message.kind === "ask_user_question") askMessage = message;
    });

    try {
      const tool = createAskUserToolDefinition({
        userId: USER,
        topicId,
        queryId: "query-1",
        agent: "maestro",
      });
      const pendingResult = tool.handler({
        question: "Which path?",
        choices: [
          { label: "Safe", description: "Use the shared runtime path." },
          { label: "Native", description: "Use a provider-owned tool." },
        ],
      });

      await Bun.sleep(0);
      expect(askMessage).toBeDefined();
      const answered = answerPendingAskUserQuestion(topicId, askMessage!.id, "Safe", USER);
      expect(answered.ok).toBe(true);

      const toolResult = await pendingResult;
      expect(toolResult.content[0]?.text).toContain("User selected: Safe");
      expect(getApiMessage(topicId, askMessage!.id)?.askUserQuestion?.selectedLabel).toBe("Safe");
    } finally {
      unsubscribe();
    }
  });

  test("same idempotency key and body shares one pending gate and replays its answer", async () => {
    const topicId = seedTopic();
    const messages: MessageDto[] = [];
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type !== "message" || event.topicId !== topicId) return;
      const message = event.payload as MessageDto;
      if (message.kind === "ask_user_question") messages.push(message);
    });
    const tool = createAskUserToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-idempotent",
      agent: "maestro",
    });
    const input = {
      question: "Deploy now?",
      choices: [{ label: "Deploy" }, { label: "Wait" }],
      idempotency_key: "deploy-decision",
    };

    try {
      const first = tool.handler(input);
      await Bun.sleep(0);
      const duplicate = tool.handler(input);
      await Bun.sleep(0);
      expect(messages).toHaveLength(1);

      expect(answerPendingAskUserQuestion(topicId, messages[0].id, "Deploy", USER).ok).toBe(true);
      const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
      expect(firstResult.content[0]?.text).toContain("User selected: Deploy");
      expect(duplicateResult.content[0]?.text).toContain("User selected: Deploy");

      const replay = await tool.handler(input);
      expect(replay.content[0]?.text).toContain("User selected: Deploy");
      expect(messages).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  test("same idempotency key with a different body fails closed", async () => {
    const topicId = seedTopic();
    const tool = createAskUserToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-conflict",
      agent: "maestro",
    });
    const pending = tool.handler({
      question: "Choose the environment.",
      choices: [{ label: "Staging" }, { label: "Production" }],
      idempotency_key: "environment-choice",
    });
    await Bun.sleep(0);

    const conflict = await tool.handler({
      question: "Choose a region.",
      choices: [{ label: "US" }, { label: "EU" }],
      idempotency_key: "environment-choice",
    });

    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]?.text).toContain("idempotency_conflict");
    cancelPendingAskUserQuestions(topicId, "query-conflict");
    await pending;
  });

  test("broadcast failure quarantines the gate and permits a clean retry", async () => {
    const topicId = seedTopic();
    const originalBus = runtimeBus();
    const messages: MessageDto[] = [];
    const unsubscribe = originalBus.subscribe((event) => {
      if (event.type !== "message" || event.topicId !== topicId) return;
      const message = event.payload as MessageDto;
      if (message.kind === "ask_user_question") messages.push(message);
    });
    const failingBus = new Proxy(originalBus, {
      get(target, property) {
        if (property === "broadcastMessage") {
          return () => {
            throw new Error("injected runtime event failure");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const queryId = "query-broadcast-retry";
    const tool = createAskUserToolDefinition({
      userId: USER,
      topicId,
      queryId,
      agent: "maestro",
    });
    const input = {
      question: "Retry after delivery failure?",
      choices: [{ label: "Retry" }, { label: "Stop" }],
      idempotency_key: "broadcast-retry",
    };

    try {
      setRuntimeBus(failingBus);
      const failed = await tool.handler(input);
      expect(failed.isError).toBe(true);
      expect(failed.content[0]?.text).toContain("failed to publish ask_user_question");
      const failedCard = listApiMessages(topicId).page.find(
        (message) => message.kind === "ask_user_question",
      );
      expect(failedCard?.askUserQuestion?.expired).toBe(true);

      setRuntimeBus(originalBus);
      const retry = tool.handler(input);
      await Bun.sleep(0);
      expect(messages).toHaveLength(1);
      expect(answerPendingAskUserQuestion(topicId, messages[0].id, "Retry", USER).ok).toBe(true);
      expect((await retry).content[0]?.text).toContain("User selected: Retry");
    } finally {
      setRuntimeBus(originalBus);
      cancelPendingAskUserQuestions(topicId, queryId);
      unsubscribe();
    }
  });

  test("concurrent answers allow exactly one claimant", async () => {
    const topicId = seedTopic();
    let askMessage: MessageDto | undefined;
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type !== "message" || event.topicId !== topicId) return;
      const message = event.payload as MessageDto;
      if (message.kind === "ask_user_question") askMessage = message;
    });
    const tool = createAskUserToolDefinition({
      userId: USER,
      topicId,
      queryId: "query-race",
      agent: "maestro",
    });

    try {
      const pending = tool.handler({
        question: "Select one.",
        choices: [{ label: "A" }, { label: "B" }],
        idempotency_key: "race-choice",
      });
      await Bun.sleep(0);

      const outcomes = [
        answerPendingAskUserQuestion(topicId, askMessage!.id, "A", USER),
        answerPendingAskUserQuestion(topicId, askMessage!.id, "B", USER),
      ];

      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
      const selected = getApiMessage(topicId, askMessage!.id)?.askUserQuestion?.selectedLabel;
      if (!selected) throw new Error("expected a selected ask choice");
      expect(["A", "B"]).toContain(selected);
      expect((await pending).content[0]?.text).toContain(`User selected: ${selected}`);
    } finally {
      unsubscribe();
    }
  });

  test("restart reconciliation quarantines an orphaned card and remints the retry", async () => {
    const topicId = seedTopic();
    const messages: MessageDto[] = [];
    const unsubscribe = runtimeBus().subscribe((event) => {
      if (event.type !== "message" || event.topicId !== topicId) return;
      const message = event.payload as MessageDto;
      if (message.kind === "ask_user_question") messages.push(message);
    });
    const queryId = "query-restart";
    const tool = createAskUserToolDefinition({
      userId: USER,
      topicId,
      queryId,
      agent: "maestro",
    });
    const input = {
      question: "Resume the workflow?",
      choices: [{ label: "Resume" }, { label: "Cancel" }],
      idempotency_key: "restart-choice",
    };

    try {
      const orphaned = tool.handler(input);
      await Bun.sleep(0);
      expect(messages).toHaveLength(1);

      const quarantined = quarantineForeignAskUserGates(new Set());
      expect(quarantined.map((update) => update.messageId)).toContain(messages[0].id);
      expect(getApiMessage(topicId, messages[0].id)?.askUserQuestion?.expired).toBe(true);

      const reminted = tool.handler(input);
      await Bun.sleep(0);
      expect(messages).toHaveLength(2);
      expect(messages[1].id).not.toBe(messages[0].id);
      expect(getApiMessage(topicId, messages[1].id)?.askUserQuestion?.expired).not.toBe(true);

      cancelPendingAskUserQuestions(topicId, queryId);
      await Promise.all([orphaned, reminted]);
    } finally {
      unsubscribe();
    }
  });

  test("restart reconciliation expires a legacy pending card without a durable gate", () => {
    const topicId = seedTopic();
    const messageId = `legacy-ask-${crypto.randomUUID()}`;
    appendApiMessage({
      id: messageId,
      topicId,
      authorId: "ai",
      text: "Legacy question",
      kind: "ask_user_question",
      askUserQuestion: {
        question: "Legacy question",
        choices: [{ label: "Continue" }],
      },
      createdAt: new Date().toISOString(),
    });

    const updates = quarantineForeignAskUserGates(new Set());

    expect(updates.map((update) => update.messageId)).toContain(messageId);
    expect(getApiMessage(topicId, messageId)?.askUserQuestion?.expired).toBe(true);
  });

  test("reconciliation preserves gates owned by another healthy process", () => {
    const topicId = seedTopic();
    const messageId = `healthy-ask-${crypto.randomUUID()}`;
    appendApiMessage({
      id: messageId,
      topicId,
      authorId: "ai",
      text: "Healthy owner question",
      kind: "ask_user_question",
      askUserQuestion: {
        question: "Healthy owner question",
        choices: [{ label: "Continue" }],
      },
      createdAt: new Date().toISOString(),
    });
    prepareAskUserGate({
      gateId: `healthy-gate-${crypto.randomUUID()}`,
      topicId,
      idempotencyKey: "healthy-owner-key",
      bodyHash: "healthy-owner-body",
      messageId,
      ownerId: "healthy-owner",
      now: new Date().toISOString(),
    });

    const updates = quarantineForeignAskUserGates(new Set(["healthy-owner"]));

    expect(updates.map((update) => update.messageId)).not.toContain(messageId);
    expect(getApiMessage(topicId, messageId)?.askUserQuestion?.expired).not.toBe(true);
  });
});
