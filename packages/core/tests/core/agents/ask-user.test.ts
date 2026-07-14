import { afterEach, describe, expect, test } from "bun:test";
import {
  answerPendingAskUserQuestion,
  createAskUserToolDefinition,
} from "#agents/mcp-tools/ask-user";
import { runtimeBus } from "#bus";
import { getApiMessage } from "#storage/api-messages";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
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
});
