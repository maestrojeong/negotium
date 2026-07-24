import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { errorResult, type SharedMcpTool, textResult } from "#agents/mcp-tools/common";
import { WsHub } from "#bus";
import { appendApiMessage, getApiMessage } from "#storage/api-messages";
import { getApiTopicConfig } from "#storage/api-topic-config";
import { getTopic } from "#storage/api-topics";
import {
  type AskUserGateCardUpdate,
  cancelAskUserGate,
  claimAskUserGateAndSelect,
  prepareAskUserGate,
  quarantineAskUserGate,
  quarantineForeignAskUserGates,
} from "#storage/ask-user-gates";
import {
  acquireRuntimeProcessLease,
  isRuntimeProcessLeaseAlive,
  listRuntimeProcessLeases,
  type RuntimeProcessLeaseHandle,
  removeDeadRuntimeProcessLeases,
} from "#storage/runtime-process-leases";
import type { AgentKind } from "#types";
import type { MessageDto } from "#types/api";

const MAX_QUESTION_CHARS = 2000;
const MAX_CHOICE_LABEL_CHARS = 128;
const MAX_CHOICE_DESCRIPTION_CHARS = 500;
const MAX_CHOICES = 12;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;
const ASK_GATE_OWNER_ID = `ask-user-${process.pid}-${randomUUID()}`;
const ASK_GATE_LEASE_ROLE_PREFIX = "ask-user-gate:";
const ASK_GATE_LEASE_ROLE = `${ASK_GATE_LEASE_ROLE_PREFIX}${ASK_GATE_OWNER_ID}`;

export type AskUserChoice = { label: string; description?: string };

export interface AskUserToolContext {
  userId: string;
  topicId: string;
  queryId?: string;
  agent: AgentKind;
  model?: string;
}

export type AnswerAskUserQuestionResult =
  | { ok: true; queryId?: string; answerMessage: MessageDto }
  | { ok: false; error: string };

type PendingAsk = {
  topicId: string;
  queryId?: string;
  messageId: string;
  question: string;
  choices: AskUserChoice[];
  promise: Promise<AskUserChoice & { userId: string }>;
  resolve: (answer: AskUserChoice & { userId: string }) => void;
};

const pendingAsks = new Map<string, PendingAsk>();
let askGateOwnerLease: RuntimeProcessLeaseHandle | null = null;

export function startAskUserQuestionGateOwner(): void {
  if (askGateOwnerLease) return;
  askGateOwnerLease = acquireRuntimeProcessLease(ASK_GATE_LEASE_ROLE, {
    ownerId: ASK_GATE_OWNER_ID,
  });
  if (!askGateOwnerLease) throw new Error("failed to acquire the ask-user gate owner lease");
}

export function stopAskUserQuestionGateOwner(): void {
  askGateOwnerLease?.stop();
  askGateOwnerLease = null;
}

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

function askBodyHash(question: string, choices: AskUserChoice[]): string {
  return createHash("sha256").update(JSON.stringify({ question, choices })).digest("hex");
}

function broadcastGateUpdates(updates: AskUserGateCardUpdate[]): void {
  for (const update of updates) {
    WsHub.get().broadcastMessageUpdated(update.topicId, update.messageId, {
      askUserQuestion: update.askUserQuestion,
      editedAt: update.editedAt,
    });
  }
}

export function reconcilePendingAskUserQuestionGates(): number {
  startAskUserQuestionGateOwner();
  removeDeadRuntimeProcessLeases(ASK_GATE_LEASE_ROLE_PREFIX);
  const liveOwners = new Set(
    listRuntimeProcessLeases(ASK_GATE_LEASE_ROLE_PREFIX)
      .filter(isRuntimeProcessLeaseAlive)
      .map((lease) => lease.ownerId),
  );
  const updates = quarantineForeignAskUserGates(liveOwners);
  broadcastGateUpdates(updates);
  return updates.length;
}

function reconcileForeignGates(): void {
  reconcilePendingAskUserQuestionGates();
}

function answerToolResult(answer: AskUserChoice & { userId: string }) {
  if (!answer.userId) return errorResult("The AI turn ended before the user answered.");
  const description = answer.description ? `\nDescription: ${answer.description}` : "";
  return textResult(
    `User selected: ${answer.label}${description}\nContinue from this selection and finish the current turn.`,
  );
}

/**
 * Host-neutral answer path for runtime ask cards. Web, terminal, Telegram, and
 * future adapters should call this rather than reimplementing pending-map and
 * persistence ordering. A successful call resumes the blocked MCP tool in the
 * same provider turn.
 */
export function answerPendingAskUserQuestion(
  topicId: string,
  messageId: string,
  label: string,
  userId: string,
): AnswerAskUserQuestionResult {
  reconcileForeignGates();
  const topic = getTopic(topicId);
  if (!topic?.participants.some((participant) => participant.userId === userId)) {
    return { ok: false, error: "User is not a member of this topic." };
  }
  const existing = getApiMessage(topicId, messageId);
  const ask = existing?.kind === "ask_user_question" ? existing.askUserQuestion : undefined;
  if (!existing || existing.deleted || !ask) {
    return { ok: false, error: "Ask card not found." };
  }
  if (ask.expired || ask.selectedLabel) {
    return { ok: false, error: "This question is no longer awaiting an answer." };
  }
  if (!ask.choices.some((choice) => choice.label === label)) {
    return { ok: false, error: "Invalid choice." };
  }

  const pending = pendingAsks.get(messageId);
  if (!pending || pending.topicId !== topicId) {
    return { ok: false, error: "This question is no longer awaiting an answer." };
  }
  const choice = pending.choices.find((item) => item.label === label);
  if (!choice) return { ok: false, error: "Invalid choice." };

  let claim: ReturnType<typeof claimAskUserGateAndSelect>;
  try {
    claim = claimAskUserGateAndSelect({
      topicId,
      messageId,
      label,
      userId,
      ownerId: ASK_GATE_OWNER_ID,
      source: "host-control",
      now: new Date().toISOString(),
    });
  } catch {
    return { ok: false, error: "This question could not be claimed safely. Retry once." };
  }
  if (claim.outcome !== "claimed") {
    return { ok: false, error: "This question is no longer awaiting an answer." };
  }
  pendingAsks.delete(messageId);

  const answerMessage: MessageDto = {
    id: randomUUID(),
    topicId,
    authorId: userId,
    text: label,
    parentId: messageId,
    createdAt: new Date().toISOString(),
  };
  try {
    WsHub.get().broadcastMessageUpdated(topicId, messageId, {
      askUserQuestion: claim.askUserQuestion,
      editedAt: claim.editedAt,
    });
    appendApiMessage(answerMessage);
    WsHub.get().broadcastMessage(topicId, answerMessage);
  } catch {
    // The durable selection is authoritative. Adapter broadcasts and the
    // convenience child message are best-effort after the atomic answer.
  }
  pending.resolve({ ...choice, userId });
  return { ok: true, queryId: pending.queryId, answerMessage };
}

export function cancelPendingAskUserQuestions(topicId: string, queryId: string): void {
  for (const [messageId, pending] of pendingAsks) {
    if (pending.topicId === topicId && pending.queryId === queryId) {
      pendingAsks.delete(messageId);
      const update = cancelAskUserGate(topicId, messageId, ASK_GATE_OWNER_ID);
      if (update) broadcastGateUpdates([update]);
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
  messageId: string,
): MessageDto {
  const cfg = getApiTopicConfig(ctx.topicId);
  const msg: MessageDto = {
    id: messageId,
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
  input: { question?: unknown; choices?: unknown; idempotency_key?: unknown },
) {
  reconcileForeignGates();
  const topic = getTopic(ctx.topicId);
  if (!topic) return errorResult(`Error: topic '${ctx.topicId}' not found.`);
  if (!topic.participants.some((p: { userId: string }) => p.userId === ctx.userId)) {
    return errorResult("Error: user is not a member of this topic.");
  }

  const normalized = normalizeAskUserQuestionInput(input);
  if ("error" in normalized) return errorResult(`Error: ${normalized.error}.`);
  if (
    input.idempotency_key !== undefined &&
    (typeof input.idempotency_key !== "string" || !input.idempotency_key.trim())
  ) {
    return errorResult("Error: idempotency_key must be a non-empty string.");
  }

  const { question, choices } = normalized;
  const rawIdempotencyKey =
    typeof input.idempotency_key === "string" ? input.idempotency_key.trim() : randomUUID();
  if (rawIdempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return errorResult(
      `Error: idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters.`,
    );
  }
  const bodyHash = askBodyHash(question, choices);

  const createGate = () => {
    const suffix = randomUUID();
    return prepareAskUserGate({
      gateId: `ask-gate-${suffix}`,
      topicId: ctx.topicId,
      queryId: ctx.queryId,
      idempotencyKey: rawIdempotencyKey,
      bodyHash,
      messageId: `ask-${ctx.queryId ?? "runtime"}-${suffix}`,
      ownerId: ASK_GATE_OWNER_ID,
      now: new Date().toISOString(),
    });
  };

  let prepared = createGate();
  if (prepared.outcome === "conflict") {
    return errorResult(
      "Error: idempotency_conflict. The same idempotency_key was already used with a different question or choices.",
    );
  }
  if (prepared.outcome === "replay") {
    const choice = choices.find((candidate) => candidate.label === prepared.gate.selectedLabel);
    if (!choice || !prepared.gate.answeredBy) {
      return errorResult("Error: the stored ask_user_question replay is incomplete.");
    }
    return answerToolResult({ ...choice, userId: prepared.gate.answeredBy });
  }
  if (prepared.outcome === "pending") {
    if (prepared.gate.ownerId !== ASK_GATE_OWNER_ID) {
      return errorResult(
        "Error: this ask_user_question is pending in another healthy runtime process.",
      );
    }
    const existingPending = pendingAsks.get(prepared.gate.messageId);
    if (existingPending) return answerToolResult(await existingPending.promise);
    if (prepared.gate.state === "claimed") {
      return errorResult("Error: this ask_user_question is already being finalized.");
    }
    const update = quarantineAskUserGate(prepared.gate.gateId, ASK_GATE_OWNER_ID);
    if (update) broadcastGateUpdates([update]);
    prepared = createGate();
  }
  if (prepared.outcome !== "created") {
    return errorResult("Error: failed to create a durable ask_user_question gate.");
  }

  let msg: MessageDto;
  try {
    msg = appendAskMessage(ctx, question, choices, prepared.gate.messageId);
  } catch (error) {
    quarantineAskUserGate(prepared.gate.gateId, ASK_GATE_OWNER_ID);
    return errorResult(
      `Error: failed to persist ask_user_question: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let resolveAnswer!: (answer: AskUserChoice & { userId: string }) => void;
  const promise = new Promise<AskUserChoice & { userId: string }>((resolve) => {
    resolveAnswer = resolve;
  });
  pendingAsks.set(msg.id, {
    topicId: ctx.topicId,
    queryId: ctx.queryId,
    messageId: msg.id,
    question,
    choices,
    promise,
    resolve: resolveAnswer,
  });
  try {
    WsHub.get().broadcastMessage(ctx.topicId, msg);
  } catch (error) {
    pendingAsks.delete(msg.id);
    try {
      quarantineAskUserGate(prepared.gate.gateId, ASK_GATE_OWNER_ID);
    } catch {
      // A retry can recover the owner-local gate after the storage fault clears.
    }
    return errorResult(
      `Error: failed to publish ask_user_question: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return answerToolResult(await promise);
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
      idempotency_key: z
        .string()
        .max(MAX_IDEMPOTENCY_KEY_CHARS)
        .optional()
        .describe(
          "Optional retry key. Reusing it with the same question replays the existing result; reusing it with different content fails.",
        ),
    },
    async handler(input) {
      return askUserQuestion(ctx, input);
    },
  };
}
