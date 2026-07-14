import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorResult, type SharedMcpTool, textResult } from "#agents/mcp-tools/common";
import { WsHub } from "#bus";
import { appendApiMessage, updateApiMessageAskUserQuestion } from "#storage/api-messages";
import { getApiTopicConfig } from "#storage/api-topic-config";
import { getTopic } from "#storage/api-topics";
import type { AgentKind } from "#types";
import type { MessageDto } from "#types/api";

const MAX_QUESTION_CHARS = 2000;
const MAX_CHOICE_LABEL_CHARS = 128;
const MAX_CHOICE_DESCRIPTION_CHARS = 500;
const MAX_CHOICES = 12;

export type AskUserChoice = { label: string; description?: string };

export interface AskUserToolContext {
  userId: string;
  topicId: string;
  queryId?: string;
  agent: AgentKind;
  model?: string;
}

export type ClaimedAskUserAnswer = {
  choice: AskUserChoice;
  queryId?: string;
  resolve: (userId: string) => void;
};

type PendingAsk = {
  topicId: string;
  queryId?: string;
  messageId: string;
  question: string;
  choices: AskUserChoice[];
  resolve: (answer: AskUserChoice & { userId: string }) => void;
};

const pendingAsks = new Map<string, PendingAsk>();

function normalizeAskText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars).trimEnd()}...`
    : normalized;
}

export function normalizeAskUserChoices(value: unknown): AskUserChoice[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((choice) => {
      if (!choice || typeof choice !== "object") return null;
      const record = choice as Record<string, unknown>;
      const label = normalizeAskText(record.label, MAX_CHOICE_LABEL_CHARS);
      if (!label) return null;
      const description = normalizeAskText(record.description, MAX_CHOICE_DESCRIPTION_CHARS);
      return {
        label,
        ...(description ? { description } : {}),
      };
    })
    .filter((choice): choice is AskUserChoice => choice !== null)
    .slice(0, MAX_CHOICES);
}

export function normalizeAskUserQuestionInput(input: {
  question?: unknown;
  choices?: unknown;
}): { question: string; choices: AskUserChoice[] } | { error: string } {
  const question = normalizeAskText(input.question, MAX_QUESTION_CHARS);
  if (!question) return { error: "question is required" };
  const choices = normalizeAskUserChoices(input.choices);
  if (choices.length === 0) return { error: "at least one choice is required" };
  return { question, choices };
}

export function hasPendingAskUserQuestion(topicId: string, messageId: string): boolean {
  const pending = pendingAsks.get(messageId);
  return Boolean(pending && pending.topicId === topicId);
}

export function claimPendingAskUserQuestion(
  topicId: string,
  messageId: string,
  label: string,
): ClaimedAskUserAnswer | null {
  const pending = pendingAsks.get(messageId);
  if (!pending || pending.topicId !== topicId) return null;
  const choice = pending.choices.find((item) => item.label === label);
  if (!choice) return null;
  pendingAsks.delete(messageId);
  return {
    choice,
    queryId: pending.queryId,
    resolve: (userId: string) => pending.resolve({ ...choice, userId }),
  };
}

export function cancelPendingAskUserQuestions(topicId: string, queryId: string): void {
  for (const [messageId, pending] of pendingAsks) {
    if (pending.topicId === topicId && pending.queryId === queryId) {
      pendingAsks.delete(messageId);
      const editedAt = new Date().toISOString();
      const expiredAsk = {
        question: pending.question,
        choices: pending.choices,
        expired: true,
      } satisfies NonNullable<MessageDto["askUserQuestion"]>;
      const updated = updateApiMessageAskUserQuestion(topicId, messageId, expiredAsk, editedAt);
      if (updated) {
        WsHub.get().broadcastMessageUpdated(topicId, messageId, {
          askUserQuestion: expiredAsk,
          editedAt,
        });
      }
      pending.resolve({
        label: "No answer",
        description: "The AI turn ended before the user answered.",
        userId: "",
      });
    }
  }
}

function appendAskMessage(
  ctx: AskUserToolContext,
  question: string,
  choices: AskUserChoice[],
): MessageDto {
  const cfg = getApiTopicConfig(ctx.topicId);
  const msg: MessageDto = {
    id: `ask-${ctx.queryId ?? "runtime"}-${randomUUID()}`,
    topicId: ctx.topicId,
    authorId: "ai",
    text: question,
    queryId: ctx.queryId,
    agentType: ctx.agent,
    model: ctx.model ?? cfg?.model ?? "unknown",
    kind: "ask_user_question",
    askUserQuestion: { question, choices },
    createdAt: new Date().toISOString(),
  };
  appendApiMessage(msg);
  return msg;
}

async function askUserQuestion(
  ctx: AskUserToolContext,
  input: { question?: unknown; choices?: unknown },
) {
  const topic = getTopic(ctx.topicId);
  if (!topic) return errorResult(`Error: topic '${ctx.topicId}' not found.`);
  if (!topic.participants.some((p: { userId: string }) => p.userId === ctx.userId)) {
    return errorResult("Error: user is not a member of this topic.");
  }

  const normalized = normalizeAskUserQuestionInput(input);
  if ("error" in normalized) return errorResult(`Error: ${normalized.error}.`);

  const { question, choices } = normalized;
  const msg = appendAskMessage(ctx, question, choices);

  const answer = await new Promise<AskUserChoice & { userId: string }>((resolve) => {
    pendingAsks.set(msg.id, {
      topicId: ctx.topicId,
      queryId: ctx.queryId,
      messageId: msg.id,
      question,
      choices,
      resolve,
    });
    WsHub.get().broadcastMessage(ctx.topicId, msg);
  });

  if (!answer.userId) {
    return errorResult("The AI turn ended before the user answered.");
  }
  const description = answer.description ? `\nDescription: ${answer.description}` : "";
  return textResult(
    `User selected: ${answer.label}${description}\nContinue from this selection and finish the current turn.`,
  );
}

export function createAskUserToolDefinition(ctx: AskUserToolContext): SharedMcpTool {
  return {
    name: "ask_user_question",
    description:
      "Ask the user a blocking multiple-choice question in the chat and wait for their selection. Use this instead of provider built-in AskUserQuestion. Use only when you cannot proceed safely without the user's choice.",
    schema: {
      question: z.string().describe("The concise question to show to the user."),
      choices: z
        .array(
          z.object({
            label: z.string().describe("Choice label shown on the button."),
            description: z.string().optional().describe("Optional one-sentence consequence."),
          }),
        )
        .min(1)
        .max(MAX_CHOICES)
        .describe("Choices the user can select."),
    },
    async handler(input) {
      return askUserQuestion(ctx, input);
    },
  };
}
