// spawn_subagent runtime MCP tool — agent-initiated delegation to a child
// agent room (clawgram parity). The tool returns immediately (fire-and-forget):
// the child topic runs its own fresh session, a live card message in the parent
// room tracks its lifecycle, and the child's final response is injected back
// into the parent as an AI turn on completion.
//
// Watches are in-memory (same accepted tradeoff as the ask-callback registry in
// routes/sessions.ts); `sweepStaleSubagentCards` marks orphans failed on boot.

import { z } from "zod";
import { errorResult, type SharedMcpTool, textResult } from "#agents/mcp-tools/common";
import { WsHub } from "#bus";
import { logger } from "#platform/logger";
import {
  appendApiMessage,
  getApiMessage,
  listApiMessagesByKind,
  updateApiMessageSubagentCard,
} from "#storage/api-messages";
import { getTopic, listTopics } from "#storage/api-topics";
import { getRuntimeTurnLease, RUNTIME_INSTANCE_ID } from "#storage/runtime-leases";
import { getRuntimeUserTurnRequest } from "#storage/runtime-turn-requests";
import { type AgentKind, isAgentKind } from "#types";
import type { MessageDto, SubagentCardDto } from "#types/api";

const MAX_TASK_CHARS = 8000;
const MAX_NAME_CHARS = 80;
const MAX_LIVE_CHILDREN_PER_PARENT = 5;
const RESULT_SUMMARY_CHARS = 300;

export interface SpawnSubagentToolContext {
  userId: string;
  topicId: string;
  queryId?: string;
  agent: AgentKind;
  model?: string;
}

export type SubagentToolContext = Pick<SpawnSubagentToolContext, "userId" | "topicId">;

export interface SubagentWatch {
  parentTopicId: string;
  childTopicId: string;
  cardMessageId: string;
  name: string;
  userId: string;
  startedAt: string;
  queryId?: string;
  running: boolean;
}

const watchesByChild = new Map<string, SubagentWatch>();
const childByQueryId = new Map<string, string>();

function countLiveChildren(parentTopicId: string): number {
  let n = 0;
  for (const watch of watchesByChild.values()) {
    if (watch.parentTopicId === parentTopicId) n += 1;
  }
  return n;
}

/** Read-merge-write the parent card and broadcast the patch. */
function patchSubagentCard(
  parentTopicId: string,
  cardMessageId: string,
  patch: Partial<SubagentCardDto>,
): void {
  const current = getApiMessage(parentTopicId, cardMessageId)?.subagentCard;
  if (!current) return;
  const next: SubagentCardDto = { ...current, ...patch };
  const editedAt = new Date().toISOString();
  if (!updateApiMessageSubagentCard(parentTopicId, cardMessageId, next, editedAt)) return;
  WsHub.get().broadcastMessageUpdated(parentTopicId, cardMessageId, {
    subagentCard: next,
    editedAt,
  });
}

function registerWatchDispatch(watch: SubagentWatch, queryId: string): void {
  // Re-dispatch (defer drain, session-expired retry, supersede-requeue) hands
  // the same child a new queryId — drop the stale mapping first.
  if (watch.queryId) childByQueryId.delete(watch.queryId);
  watch.queryId = queryId;
  watchesByChild.set(watch.childTopicId, watch);
  childByQueryId.set(queryId, watch.childTopicId);
  if (!watch.running) {
    watch.running = true;
    patchSubagentCard(watch.parentTopicId, watch.cardMessageId, { status: "running" });
  }
}

/** Claim the watch for a finished child turn (delete-on-take). */
export function takeSubagentWatch(queryId: string): SubagentWatch | null {
  const childTopicId = childByQueryId.get(queryId);
  if (!childTopicId) return recoverPersistedSubagentWatch(queryId);
  childByQueryId.delete(queryId);
  const watch = watchesByChild.get(childTopicId);
  if (!watch || watch.queryId !== queryId) return null;
  watchesByChild.delete(childTopicId);
  return watch;
}

function childExecutionQueryId(childTopicId: string): string | null {
  const lease = getRuntimeTurnLease(childTopicId);
  if (lease) return lease.queryId;
  return getRuntimeUserTurnRequest(childTopicId)?.runningQueryId ?? null;
}

function childExecutionIsRecoverable(childTopicId: string): boolean {
  if (getRuntimeUserTurnRequest(childTopicId)) return true;
  const lease = getRuntimeTurnLease(childTopicId);
  if (!lease) return false;
  const ownerPid = Number.parseInt(lease.ownerId.split("-", 1)[0] ?? "", 10);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return true;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function runtimeOwnerIsAlive(ownerId: string): boolean {
  const ownerPid = Number.parseInt(ownerId.split("-", 1)[0] ?? "", 10);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return true;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function watchFromPersistedCard(
  message: MessageDto,
  card: SubagentCardDto,
  queryId?: string,
): SubagentWatch | null {
  const child = getTopic(card.subagentTopicId);
  const userId =
    child?.participants.find((participant) => participant.role === "owner")?.userId ??
    child?.participants[0]?.userId;
  if (!userId) return null;
  return {
    parentTopicId: message.topicId,
    childTopicId: card.subagentTopicId,
    cardMessageId: message.id,
    name: card.name,
    userId,
    startedAt: card.startedAt,
    queryId,
    running: card.status === "running",
  };
}

function recoverPersistedSubagentWatch(queryId: string): SubagentWatch | null {
  for (const message of listApiMessagesByKind("subagent")) {
    const card = message.subagentCard;
    if (!card || (card.status !== "spawned" && card.status !== "running")) continue;
    if (childExecutionQueryId(card.subagentTopicId) !== queryId) continue;
    return watchFromPersistedCard(message, card, queryId);
  }
  return null;
}

function dropWatch(watch: SubagentWatch): void {
  watchesByChild.delete(watch.childTopicId);
  if (watch.queryId) childByQueryId.delete(watch.queryId);
}

/** Drop deferred/in-flight bookkeeping when a subagent room is hard-deleted. */
export function cancelSubagentWatchForDeletedTopic(childTopicId: string): void {
  const watch = watchesByChild.get(childTopicId);
  if (!watch) return;
  dropWatch(watch);
  patchSubagentCard(watch.parentTopicId, watch.cardMessageId, {
    status: "failed",
    errorMessage: "subagent room was deleted",
    finishedAt: new Date().toISOString(),
  });
}

/** Last-resort delivery: a plain system message in the parent room. */
function appendParentSystemNote(watch: SubagentWatch, prompt: string): void {
  const now = new Date().toISOString();
  const msg: MessageDto = {
    id: `subagent-note-${watch.childTopicId}-${now}`,
    topicId: watch.parentTopicId,
    authorId: "system",
    text: prompt,
    kind: "system",
    createdAt: now,
  };
  appendApiMessage(msg);
  WsHub.get().broadcastMessage(watch.parentTopicId, msg);
}

/**
 * Deliver a completion/failure notice to the parent room as a hidden AI turn,
 * falling back to a system message. NEVER throws — the caller has already
 * taken the watch, so a lost exception here would silently swallow the result
 * with nothing left to retry.
 */
async function notifyParent(
  watch: SubagentWatch,
  prompt: string,
  noteKind: "done" | "fail",
): Promise<void> {
  try {
    const parent = getTopic(watch.parentTopicId);
    if (!parent) return;
    const requestId = `subagent-${noteKind}-${watch.childTopicId}`;
    // A stable requestId is required for the defer queue: injects without one are
    // DROPPED when the parent room is busy (InterSessionQueue.enqueue). One
    // settle per child, so the id also dedups accidental double-delivery.
    const { triggerTopicAiTurn } = await import("#runtime/turn-runner");
    const queryId = parent.agent
      ? triggerTopicAiTurn(watch.parentTopicId, watch.userId, prompt, undefined, {
          origin: `subagent:${watch.name}`,
          requestId,
          hideInjectMessage: true,
        })
      : null;
    if (queryId) return;

    // null return = deferred behind a running parent turn (it will drain) — but
    // only when the queue actually accepted it. Anything else falls back to a
    // plain system message so the result is never lost.
    const { interSessionQueue } = await import("#query/active-rooms");
    if (parent.agent && interSessionQueue.hasRequest(watch.parentTopicId, requestId)) {
      return;
    }

    appendParentSystemNote(watch, prompt);
  } catch (err) {
    logger.warn(
      { err, parentTopicId: watch.parentTopicId, childTopicId: watch.childTopicId, noteKind },
      "subagent: parent AI notify failed — falling back to system message",
    );
    try {
      appendParentSystemNote(watch, prompt);
    } catch (fallbackErr) {
      logger.error(
        { err: fallbackErr, parentTopicId: watch.parentTopicId, childTopicId: watch.childTopicId },
        "subagent: parent delivery lost — system-message fallback also failed",
      );
    }
  }
}

/** Settle a finished child run. NEVER rejects — call sites fire-and-forget. */
export async function settleSubagentSuccess(
  watch: SubagentWatch,
  finalText: string,
): Promise<void> {
  const summary = finalText.replace(/\s+/g, " ").trim().slice(0, RESULT_SUMMARY_CHARS);
  try {
    patchSubagentCard(watch.parentTopicId, watch.cardMessageId, {
      status: "completed",
      resultSummary: summary || "(no text response)",
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      { err, parentTopicId: watch.parentTopicId, cardMessageId: watch.cardMessageId },
      "subagent: completed-card update failed",
    );
  }
  await notifyParent(
    watch,
    `[Subagent completed ← ${watch.name}]\n이 메시지는 spawn_subagent로 위임한 작업의 자동 완료 회신입니다. 결과를 확인하고 필요하면 이어서 진행하세요.\n\n${finalText || "(no text response)"}`,
    "done",
  );
}

/** Settle a failed child run. NEVER rejects — call sites fire-and-forget. */
export async function settleSubagentFailure(queryId: string, reason: string): Promise<void> {
  const watch = takeSubagentWatch(queryId);
  if (!watch) return;
  try {
    patchSubagentCard(watch.parentTopicId, watch.cardMessageId, {
      status: "failed",
      errorMessage: reason,
      finishedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(
      { err, parentTopicId: watch.parentTopicId, cardMessageId: watch.cardMessageId },
      "subagent: failed-card update failed",
    );
  }
  await notifyParent(
    watch,
    `[Subagent failed ← ${watch.name}]\nspawn_subagent로 위임한 작업이 실패했습니다: ${reason}`,
    "fail",
  );
}

/**
 * Boot-time sweep: watches don't survive a restart, so any card still marked
 * spawned/running belongs to a run whose completion can no longer be tracked.
 */
export function sweepStaleSubagentCards(): void {
  for (const msg of listApiMessagesByKind("subagent")) {
    const card = msg.subagentCard;
    if (!card || (card.status !== "spawned" && card.status !== "running")) continue;
    if (card.runtimeOwnerId && runtimeOwnerIsAlive(card.runtimeOwnerId)) continue;
    const queryId = childExecutionQueryId(card.subagentTopicId);
    if (childExecutionIsRecoverable(card.subagentTopicId)) {
      const watch = watchFromPersistedCard(msg, card, queryId ?? undefined);
      if (watch && queryId) registerWatchDispatch(watch, queryId);
      continue;
    }
    if (!card.runtimeOwnerId) continue;
    patchSubagentCard(msg.topicId, msg.id, {
      status: "failed",
      errorMessage: "server restarted while the subagent was running",
      finishedAt: new Date().toISOString(),
    });
    logger.info(
      { topicId: msg.topicId, messageId: msg.id, child: card.subagentTopicId },
      "subagent: swept stale card on boot",
    );
  }
}

async function spawnSubagent(
  ctx: SpawnSubagentToolContext,
  input: { task?: unknown; name?: unknown; agent?: unknown; model?: unknown },
) {
  const parent = getTopic(ctx.topicId);
  if (!parent) return errorResult(`Error: topic '${ctx.topicId}' not found.`);
  if (!parent.participants.some((p) => p.userId === ctx.userId)) {
    return errorResult("Error: user is not a member of this topic.");
  }
  if (parent.kind !== "agent" || parent.isSubagent) {
    return errorResult("Error: spawn_subagent is only available in top-level agent rooms.");
  }

  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!task) return errorResult("Error: task is required.");
  if (task.length > MAX_TASK_CHARS) {
    return errorResult(`Error: task is too long (max ${MAX_TASK_CHARS} chars).`);
  }
  const name =
    typeof input.name === "string"
      ? input.name
          .replace(/[\n\t]/g, " ")
          .trim()
          .slice(0, MAX_NAME_CHARS)
      : undefined;
  const agentOverride = isAgentKind(input.agent) ? input.agent : undefined;
  const modelOverride =
    typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;

  if (countLiveChildren(ctx.topicId) >= MAX_LIVE_CHILDREN_PER_PARENT) {
    return errorResult(
      `Error: this room already has ${MAX_LIVE_CHILDREN_PER_PARENT} subagents running. Wait for one to finish before spawning another.`,
    );
  }

  // Preflight the overrides before creating anything — a bad agent/model would
  // otherwise leave a dead child room with a card that fails on first turn.
  const targetAgent = agentOverride ?? ctx.agent;
  let resolvedModelOverride = modelOverride;
  if (modelOverride) {
    const { resolveModelForAgent } = await import("#agents/model-catalog");
    const { getRegistry } = await import("#agents/registry");
    const registry = getRegistry(targetAgent);
    if (!registry.validateModel(modelOverride)) {
      return errorResult(
        `Error: model '${modelOverride}' is not valid for agent '${targetAgent}'.`,
      );
    }
    resolvedModelOverride = resolveModelForAgent(targetAgent, modelOverride, registry);
  }
  if (agentOverride || modelOverride) {
    const { checkAgentModelAuth } = await import("#agents/auth-check");
    const { getRegistry } = await import("#agents/registry");
    const targetModel = resolvedModelOverride ?? getRegistry(targetAgent).defaultModel;
    const auth = checkAgentModelAuth(targetAgent, targetModel);
    if (!auth.ok) {
      return errorResult(`Error: agent '${targetAgent}' is not available: ${auth.error}`);
    }
  }

  const { createDerivedTopic, TopicTitleConflictError } = await import("#topics/derive");
  let child: Awaited<ReturnType<typeof createDerivedTopic>>;
  try {
    child = await createDerivedTopic(ctx.topicId, ctx.userId, false, {
      name,
      subagent: { agent: agentOverride, model: resolvedModelOverride },
    });
  } catch (e) {
    if (e instanceof TopicTitleConflictError) {
      return errorResult(`Error: ${e.message}. Try a different name.`);
    }
    throw e;
  }
  if (!child) {
    return errorResult(
      "Error: failed to create the subagent room (restricted or missing source topic).",
    );
  }

  const now = new Date().toISOString();
  const card: SubagentCardDto = {
    subagentTopicId: child.id,
    name: child.title,
    task,
    runtimeOwnerId: RUNTIME_INSTANCE_ID,
    status: "spawned",
    startedAt: now,
  };
  const cardMsg: MessageDto = {
    id: `subagent-${child.id}`,
    topicId: ctx.topicId,
    authorId: "ai",
    text: `🤖 Subagent "${child.title}" spawned`,
    queryId: ctx.queryId,
    agentType: ctx.agent,
    model: ctx.model,
    kind: "subagent",
    subagentCard: card,
    createdAt: now,
  };
  appendApiMessage(cardMsg, { notify: false });
  WsHub.get().broadcastMessage(ctx.topicId, cardMsg);

  const watch: SubagentWatch = {
    parentTopicId: ctx.topicId,
    childTopicId: child.id,
    cardMessageId: cardMsg.id,
    name: child.title,
    userId: ctx.userId,
    startedAt: now,
    running: false,
  };
  watchesByChild.set(child.id, watch);

  let childQueryId: string | null = null;
  let locallyQueued = false;
  const childPrompt = `[Delegated task from ${parent.title}]\n\n${task}`;
  {
    const { triggerTopicAiTurn } = await import("#runtime/turn-runner");
    const { getRoomQuery } = await import("#query/active-rooms");
    childQueryId = triggerTopicAiTurn(child.id, ctx.userId, childPrompt, agentOverride, {
      origin: `subagent-task:${parent.title}`,
      // Required by the defer queue: if a user message preempts the task turn,
      // the re-queue path drops injects that have no requestId.
      requestId: `subagent-task-${child.id}`,
      injectAuthorId: "ai",
      onDispatched: (qid: string) => registerWatchDispatch(watch, qid),
    });
    locallyQueued = Boolean(getRoomQuery(child.id));
  }
  if (!childQueryId && !watch.queryId && !locallyQueued) {
    dropWatch(watch);
    patchSubagentCard(ctx.topicId, cardMsg.id, {
      status: "failed",
      errorMessage: "the subagent turn could not be dispatched",
      finishedAt: new Date().toISOString(),
    });
    return errorResult("Error: subagent room was created but its AI turn could not start.");
  }

  logger.info(
    { parentTopicId: ctx.topicId, childTopicId: child.id, name: child.title },
    "subagent: spawned",
  );
  return textResult(
    [
      `Subagent "${child.title}" spawned (room id: ${child.id}) and is now working in the background.`,
      "Its final result will be delivered back into this room automatically when it finishes.",
      "Do NOT wait or poll — finish your current turn normally.",
    ].join("\n"),
  );
}

function ownedDirectSubagents(ctx: SubagentToolContext) {
  const parent = getTopic(ctx.topicId);
  if (!parent) return { ok: false, error: `Error: topic '${ctx.topicId}' not found.` } as const;
  if (!parent.participants.some((participant) => participant.userId === ctx.userId)) {
    return { ok: false, error: "Error: user is not a member of this topic." } as const;
  }
  if (parent.kind !== "agent" || parent.isSubagent) {
    return {
      ok: false,
      error: "Error: subagent management is only available in top-level agent rooms.",
    } as const;
  }
  return {
    ok: true,
    parent,
    children: listTopics().filter(
      (topic) =>
        topic.parentTopicId === ctx.topicId &&
        topic.isSubagent &&
        topic.participants.some(
          (participant) => participant.userId === ctx.userId && participant.role === "owner",
        ),
    ),
  } as const;
}

function subagentStatus(
  parentTopicId: string,
  childTopicId: string,
): SubagentCardDto["status"] | "unknown" {
  const watch = watchesByChild.get(childTopicId);
  if (watch?.running) return "running";
  const card = listApiMessagesByKind("subagent")
    .filter(
      (message) =>
        message.topicId === parentTopicId && message.subagentCard?.subagentTopicId === childTopicId,
    )
    .at(-1)?.subagentCard;
  return card?.status ?? "unknown";
}

export function createSubagentManagementToolDefinitions(ctx: SubagentToolContext): SharedMcpTool[] {
  return [
    {
      name: "list_subagents",
      description:
        "List the direct subagent rooms created by this user from the current parent room. " +
        "Use this to decide whether a completed subagent should be retained for follow-up work or deleted.",
      schema: {},
      async handler() {
        const result = ownedDirectSubagents(ctx);
        if (!result.ok) return errorResult(result.error);
        const children = result.children.map((child) => ({
          topic_id: child.id,
          name: child.title,
          status: subagentStatus(ctx.topicId, child.id),
          agent: child.agent ?? null,
          model: child.defaultModel ?? null,
          created_at: child.createdAt,
        }));
        return textResult(JSON.stringify({ subagents: children }, null, 2));
      },
    },
    {
      name: "delete_subagent",
      description:
        "Permanently delete one direct subagent room created by this user from the current parent room. " +
        "This removes its conversation, workspace, runtime state, and topic. Keep it when follow-up work is likely.",
      schema: {
        topic_id: z
          .string()
          .describe("Exact subagent room id returned by list_subagents; names are not accepted."),
      },
      async handler(input) {
        const result = ownedDirectSubagents(ctx);
        if (!result.ok) return errorResult(result.error);
        const topicId = typeof input.topic_id === "string" ? input.topic_id.trim() : "";
        const child = result.children.find((candidate) => candidate.id === topicId);
        if (!child) {
          return errorResult(
            "Error: no owned direct subagent with that topic_id exists under this room.",
          );
        }
        try {
          const { deleteTopicCascade } = await import("#topics/lifecycle");
          await deleteTopicCascade(child, ctx.userId);
          return textResult(`Subagent deleted: ${child.title} (${child.id})`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`Error: failed to delete subagent '${child.title}': ${message}`);
        }
      },
    },
  ];
}

export function createSpawnSubagentToolDefinition(ctx: SpawnSubagentToolContext): SharedMcpTool {
  return {
    name: "spawn_subagent",
    description:
      "Delegate a self-contained task to a subagent that works in its own new agent room. " +
      "Returns immediately; the subagent runs in the background and its final result is injected back into this room when it finishes. " +
      "The subagent starts with ONLY the task text — include all necessary context, file paths, and acceptance criteria in it. " +
      "Use for parallelizable or long-running side work. Do not use provider built-in Task/Agent subagents.",
    schema: {
      task: z
        .string()
        .describe(
          "Self-contained task brief for the subagent. It sees nothing else — include all context.",
        ),
      name: z
        .string()
        .optional()
        .describe("Short name for the subagent room. Auto-generated when omitted."),
      agent: z
        .enum(["claude", "codex", "maestro"])
        .optional()
        .describe("Agent backend override. Defaults to this room's agent."),
      model: z
        .string()
        .optional()
        .describe(
          `Best-fit model override from the system prompt catalog. Omit agent+model to inherit ${ctx.agent}/${ctx.model ?? "default"}; overriding agent without model uses that agent's default.`,
        ),
    },
    async handler(input) {
      return spawnSubagent(ctx, input);
    },
  };
}
