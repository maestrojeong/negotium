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
import {
  getTopic,
  getTopicMemoryOrigin,
  grantSubagentTellTarget,
  listSubagentTellTargetIds,
  listTopics,
  revokeSubagentTellTarget,
  upsertTopic,
} from "#storage/api-topics";
import { getRuntimeTurnLease, RUNTIME_INSTANCE_ID } from "#storage/runtime-leases";
import { getRuntimeUserTurnRequest } from "#storage/runtime-turn-requests";
import { wikiBriefStorageKey, wikiSummarySlug } from "#storage/wiki-summary-names";
import { type AgentKind, isAgentKind } from "#types";
import type { MessageDto, SubagentCardDto, SubagentReportMode } from "#types/api";

const MAX_TASK_CHARS = 8000;
const MAX_NAME_CHARS = 80;
const MAX_LIVE_CHILDREN_PER_PARENT = 5;
const MAX_PREPARED_CHILDREN_PER_PARENT = 10;
export const MAX_SUBAGENT_DEPTH = 2;
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
  reportMode: SubagentReportMode;
  queryId?: string;
  running: boolean;
}

const watchesByChild = new Map<string, SubagentWatch>();
const childByQueryId = new Map<string, string>();

function resolveMemoryTopicSelection(
  rawSelection: unknown,
  userId: string,
): { topicId?: string; error?: string } {
  if (rawSelection === undefined || rawSelection === null) return {};
  if (typeof rawSelection !== "string" || !rawSelection.trim()) {
    return { error: "Error: memory_topic must be a topic id, title, or topic/*.md path." };
  }

  const selection = rawSelection.trim();
  if (
    selection.includes("\\") ||
    selection.startsWith("/") ||
    selection.split("/").some((part) => part === "..") ||
    (selection.includes("/") && !selection.startsWith("topic/"))
  ) {
    return { error: "Error: memory_topic must name a file under topic/." };
  }
  const key = selection.startsWith("topic/") ? selection.slice("topic/".length) : selection;
  if (!key || key.includes("/")) {
    return { error: "Error: memory_topic must name one topic/*.md file." };
  }

  const accessible = listTopics().filter((topic) =>
    topic.participants.some((participant) => participant.userId === userId),
  );
  const matches = accessible.filter((topic) => {
    const canonicalFilename = `${wikiBriefStorageKey(topic.title, topic.id)}.md`;
    const legacyFilename = `${wikiSummarySlug(topic.title)}.md`;
    return (
      key === topic.id ||
      key.toLowerCase() === topic.title.toLowerCase() ||
      key === canonicalFilename ||
      key === legacyFilename
    );
  });
  if (matches.length === 0) {
    return { error: `Error: memory topic '${selection}' was not found or is not accessible.` };
  }
  if (matches.length > 1) {
    return {
      error: `Error: memory topic '${selection}' is ambiguous; use its topic id or canonical topic/*.md filename.`,
    };
  }
  const origin = getTopicMemoryOrigin(matches[0]!.id) ?? matches[0]!;
  // The matched topic is accessible, but its memory chain may resolve to a
  // root origin the user does not participate in; fail closed like
  // listMemoryTopicNames instead of granting memory access transitively.
  if (!origin.participants.some((participant) => participant.userId === userId)) {
    return { error: `Error: memory topic '${selection}' was not found or is not accessible.` };
  }
  return { topicId: origin.id };
}

function countLiveChildren(parentTopicId: string): number {
  let n = 0;
  for (const watch of watchesByChild.values()) {
    if (watch.parentTopicId === parentTopicId) n += 1;
  }
  return n;
}

/**
 * Walk the parent chain and count how many subagent ancestors this topic has.
 * Runs on every turn/MCP build, so it walks per-parent lookups (depth-capped)
 * instead of scanning the whole topic table.
 */
export function computeSubagentDepth(topicId: string): number {
  let depth = 0;
  let current = getTopic(topicId);
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) return MAX_SUBAGENT_DEPTH;
    visited.add(current.id);
    if (current.isSubagent) depth += 1;
    if (!current.parentTopicId || current.parentTopicId === current.id) break;
    current = getTopic(current.parentTopicId);
  }
  return depth;
}

export function canSpawnSubagentsFromTopic(topicId: string): boolean {
  const topic = getTopic(topicId);
  return topic?.kind === "agent" && computeSubagentDepth(topicId) < MAX_SUBAGENT_DEPTH;
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
    startedAt: card.startedAt ?? card.createdAt ?? message.createdAt,
    reportMode: card.reportMode ?? "auto",
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
  if (watch.reportMode === "auto") {
    await notifyParent(
      watch,
      `[Subagent completed ← ${watch.name}]\n이 메시지는 spawn_subagent로 위임한 작업의 자동 완료 회신입니다. 결과를 확인하고 필요하면 이어서 진행하세요.\n\n${finalText || "(no text response)"}`,
      "done",
    );
  }
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
  if (watch.reportMode === "auto") {
    await notifyParent(
      watch,
      `[Subagent failed ← ${watch.name}]\nspawn_subagent로 위임한 작업이 실패했습니다: ${reason}`,
      "fail",
    );
  }
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

function reportModeFromInput(input: { report_mode?: unknown }): SubagentReportMode {
  return input.report_mode === "tell" || input.report_mode === "status-only"
    ? input.report_mode
    : "auto";
}

function findSubagentCardMessage(childTopicId: string): MessageDto | undefined {
  return listApiMessagesByKind("subagent")
    .filter((message) => message.subagentCard?.subagentTopicId === childTopicId)
    .at(-1);
}

export function subagentReportMode(childTopicId: string): SubagentReportMode {
  return (
    getTopic(childTopicId)?.subagentReportMode ??
    findSubagentCardMessage(childTopicId)?.subagentCard?.reportMode ??
    "auto"
  );
}

async function startSubagentCard(
  ctx: SubagentToolContext,
  cardMessage: MessageDto,
): Promise<ReturnType<typeof textResult>> {
  const card = cardMessage.subagentCard;
  if (!card) return errorResult("Error: subagent card is missing.");
  if (card.status !== "ready") {
    return errorResult(`Error: subagent cannot start from status '${card.status}'.`);
  }
  const child = getTopic(card.subagentTopicId);
  const parent = getTopic(cardMessage.topicId);
  if (!child || !parent)
    return errorResult("Error: subagent room or its direct parent is missing.");
  if (countLiveChildren(cardMessage.topicId) >= MAX_LIVE_CHILDREN_PER_PARENT) {
    return errorResult(
      `Error: this room already has ${MAX_LIVE_CHILDREN_PER_PARENT} subagents running.`,
    );
  }

  const startedAt = new Date().toISOString();
  const watch: SubagentWatch = {
    parentTopicId: cardMessage.topicId,
    childTopicId: child.id,
    cardMessageId: cardMessage.id,
    name: child.title,
    userId: ctx.userId,
    startedAt,
    reportMode: card.reportMode ?? "auto",
    running: false,
  };
  watchesByChild.set(child.id, watch);
  patchSubagentCard(cardMessage.topicId, cardMessage.id, {
    runtimeOwnerId: RUNTIME_INSTANCE_ID,
    status: "spawned",
    startedAt,
    finishedAt: undefined,
    errorMessage: undefined,
    resultSummary: undefined,
  });

  const reportInstruction =
    watch.reportMode === "tell"
      ? `\n\nReport your result to "${parent.title}" with tell_session; your final response will not be forwarded automatically.`
      : watch.reportMode === "status-only"
        ? "\n\nDo not send a completion report to the parent; only the lifecycle card will be updated."
        : "";
  const childPrompt = `[Delegated task from ${parent.title}]\n\n${card.task}${reportInstruction}`;
  const { triggerTopicAiTurn } = await import("#runtime/turn-runner");
  const { getRoomQuery } = await import("#query/active-rooms");
  const childQueryId = triggerTopicAiTurn(child.id, ctx.userId, childPrompt, undefined, {
    origin: `subagent-task:${parent.title}`,
    requestId: `subagent-task-${child.id}-${startedAt}`,
    injectAuthorId: "ai",
    onDispatched: (qid: string) => registerWatchDispatch(watch, qid),
  });
  const locallyQueued = Boolean(getRoomQuery(child.id));
  if (!childQueryId && !watch.queryId && !locallyQueued) {
    dropWatch(watch);
    patchSubagentCard(cardMessage.topicId, cardMessage.id, {
      status: "failed",
      errorMessage: "the subagent turn could not be dispatched",
      finishedAt: new Date().toISOString(),
    });
    return errorResult("Error: subagent room exists but its AI turn could not start.");
  }
  return textResult(`Subagent started: ${child.title} (${child.id})`);
}

async function createSubagent(
  ctx: SpawnSubagentToolContext,
  input: {
    task?: unknown;
    name?: unknown;
    agent?: unknown;
    model?: unknown;
    report_mode?: unknown;
    memory_topic?: unknown;
  },
  startImmediately: boolean,
) {
  const parent = getTopic(ctx.topicId);
  if (!parent) return errorResult(`Error: topic '${ctx.topicId}' not found.`);
  if (!parent.participants.some((p) => p.userId === ctx.userId)) {
    return errorResult("Error: user is not a member of this topic.");
  }
  if (parent.kind !== "agent") {
    return errorResult("Error: spawn_subagent is only available in agent rooms.");
  }
  const depth = computeSubagentDepth(ctx.topicId);
  if (depth >= MAX_SUBAGENT_DEPTH) {
    return errorResult(
      `Error: subagent depth limit reached (current ${depth}, max ${MAX_SUBAGENT_DEPTH}).`,
    );
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
  const reportMode = reportModeFromInput(input);
  const memorySelection = resolveMemoryTopicSelection(input.memory_topic, ctx.userId);
  if (memorySelection.error) return errorResult(memorySelection.error);

  if (startImmediately && countLiveChildren(ctx.topicId) >= MAX_LIVE_CHILDREN_PER_PARENT) {
    return errorResult(
      `Error: this room already has ${MAX_LIVE_CHILDREN_PER_PARENT} subagents running. Wait for one to finish before spawning another.`,
    );
  }
  if (!startImmediately) {
    // Prepared-but-unstarted rooms consume real topics/workspaces; cap them so
    // a create_subagent loop cannot allocate unbounded resources.
    const preparedChildren = listTopics().filter(
      (topic) =>
        topic.parentTopicId === ctx.topicId &&
        topic.isSubagent &&
        subagentStatus(ctx.topicId, topic.id) === "ready",
    ).length;
    if (preparedChildren >= MAX_PREPARED_CHILDREN_PER_PARENT) {
      return errorResult(
        `Error: this room already has ${MAX_PREPARED_CHILDREN_PER_PARENT} prepared subagents. Start or delete one before creating another.`,
      );
    }
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
    const auth = checkAgentModelAuth(targetAgent, targetModel, undefined, ctx.userId);
    if (!auth.ok) {
      return errorResult(`Error: agent '${targetAgent}' is not available: ${auth.error}`);
    }
  }

  const { createDerivedTopic, TopicDeriveBusyError, TopicTitleConflictError } = await import(
    "#topics/derive"
  );
  let child: Awaited<ReturnType<typeof createDerivedTopic>>;
  try {
    child = await createDerivedTopic(ctx.topicId, ctx.userId, false, {
      name,
      subagent: {
        agent: agentOverride,
        model: resolvedModelOverride,
        memoryTopicId: memorySelection.topicId,
      },
    });
  } catch (e) {
    if (e instanceof TopicTitleConflictError) {
      return errorResult(`Error: ${e.message}. Try a different name.`);
    }
    if (e instanceof TopicDeriveBusyError) {
      return errorResult(
        "Error: the source topic is busy (active turn or maintenance). Retry shortly.",
      );
    }
    throw e;
  }
  if (!child) {
    return errorResult(
      "Error: failed to create the subagent room (restricted or missing source topic).",
    );
  }
  child.subagentReportMode = reportMode;
  upsertTopic(child);

  const now = new Date().toISOString();
  const card: SubagentCardDto = {
    subagentTopicId: child.id,
    name: child.title,
    task,
    status: "ready",
    reportMode,
    createdAt: now,
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

  if (!startImmediately) {
    return textResult(
      `Subagent prepared: ${child.title} (${child.id}). Use start_subagent to run it.`,
    );
  }
  const started = await startSubagentCard(ctx, cardMsg);
  if (started.isError) return started;

  logger.info(
    { parentTopicId: ctx.topicId, childTopicId: child.id, name: child.title },
    "subagent: spawned",
  );
  return textResult(
    [
      `Subagent "${child.title}" spawned (room id: ${child.id}) and is now working in the background.`,
      reportMode === "auto"
        ? "Its final result will be delivered back into this room automatically when it finishes."
        : reportMode === "tell"
          ? "It must report with tell_session; its final response is not forwarded automatically."
          : "Only lifecycle status will be reported.",
      "Do NOT wait or poll — finish your current turn normally.",
    ].join("\n"),
  );
}

function ownedSubagentTree(ctx: SubagentToolContext) {
  const parent = getTopic(ctx.topicId);
  if (!parent) return { ok: false, error: `Error: topic '${ctx.topicId}' not found.` } as const;
  if (!parent.participants.some((participant) => participant.userId === ctx.userId)) {
    return { ok: false, error: "Error: user is not a member of this topic." } as const;
  }
  if (parent.kind !== "agent") {
    return {
      ok: false,
      error: "Error: subagent management is only available in agent rooms.",
    } as const;
  }
  return {
    ok: true,
    parent,
    children: (() => {
      const topics = listTopics();
      const byParent = new Map<string, typeof topics>();
      for (const topic of topics) {
        if (!topic.parentTopicId || !topic.isSubagent) continue;
        const siblings = byParent.get(topic.parentTopicId) ?? [];
        siblings.push(topic);
        byParent.set(topic.parentTopicId, siblings);
      }
      const descendants: typeof topics = [];
      const visited = new Set<string>([ctx.topicId]);
      const visit = (parentId: string) => {
        for (const child of byParent.get(parentId) ?? []) {
          if (visited.has(child.id)) continue;
          visited.add(child.id);
          if (
            !child.participants.some(
              (participant) => participant.userId === ctx.userId && participant.role === "owner",
            )
          ) {
            continue;
          }
          descendants.push(child);
          visit(child.id);
        }
      };
      visit(ctx.topicId);
      return descendants;
    })(),
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

function listMemoryTopicNames(ctx: SubagentToolContext): { names?: string[]; error?: string } {
  const current = getTopic(ctx.topicId);
  if (!current) return { error: `Error: topic '${ctx.topicId}' not found.` };
  if (!current.participants.some((participant) => participant.userId === ctx.userId)) {
    return { error: "Error: user is not a member of this topic." };
  }

  const sources = new Map<string, string>();
  for (const topic of listTopics()) {
    if (!topic.participants.some((participant) => participant.userId === ctx.userId)) continue;
    const origin = getTopicMemoryOrigin(topic.id) ?? topic;
    if (!origin.participants.some((participant) => participant.userId === ctx.userId)) continue;
    sources.set(origin.id, origin.title);
  }
  return {
    names: [...sources.values()].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    ),
  };
}

export function createSubagentManagementToolDefinitions(ctx: SubagentToolContext): SharedMcpTool[] {
  return [
    {
      name: "list_memory_topics",
      description:
        "List the names of accessible topic-memory sources. Pass one returned name as memory_topic when creating or spawning a subagent.",
      schema: {},
      async handler() {
        const result = listMemoryTopicNames(ctx);
        if (result.error) return errorResult(result.error);
        return textResult(result.names?.length ? result.names.join("\n") : "(no memory topics)");
      },
    },
    {
      name: "list_subagents",
      description:
        "List the full descendant subagent tree, statuses, and tell_session connections managed by this room.",
      schema: {},
      async handler() {
        const result = ownedSubagentTree(ctx);
        if (!result.ok) return errorResult(result.error);
        const children = result.children.map((child) => ({
          topic_id: child.id,
          name: child.title,
          parent_topic_id: child.parentTopicId,
          status: subagentStatus(child.parentTopicId ?? ctx.topicId, child.id),
          agent: child.agent ?? null,
          model: child.defaultModel ?? null,
          tell_target_topic_ids: listSubagentTellTargetIds(child.id),
          created_at: child.createdAt,
        }));
        return textResult(JSON.stringify({ subagents: children }, null, 2));
      },
    },
    {
      name: "start_subagent",
      description: "Start a prepared descendant subagent task.",
      schema: {
        topic_id: z.string().describe("Prepared subagent room id."),
      },
      async handler(input) {
        const result = ownedSubagentTree(ctx);
        if (!result.ok) return errorResult(result.error);
        const topicId = String(input.topic_id ?? "").trim();
        if (!result.children.some((child) => child.id === topicId)) {
          return errorResult("Error: topic is not a descendant subagent managed by this room.");
        }
        const cardMessage = findSubagentCardMessage(topicId);
        if (!cardMessage) return errorResult("Error: no lifecycle card exists for this subagent.");
        return startSubagentCard(ctx, cardMessage);
      },
    },
    {
      name: "delete_subagent",
      description:
        "Permanently delete one descendant subagent room managed by the current room. " +
        "This removes its conversation, workspace, runtime state, and topic. Keep it when follow-up work is likely.",
      schema: {
        topic_id: z
          .string()
          .describe("Exact subagent room id returned by list_subagents; names are not accepted."),
      },
      async handler(input) {
        const result = ownedSubagentTree(ctx);
        if (!result.ok) return errorResult(result.error);
        const topicId = typeof input.topic_id === "string" ? input.topic_id.trim() : "";
        const child = result.children.find((candidate) => candidate.id === topicId);
        if (!child) {
          return errorResult(
            "Error: no owned descendant subagent with that topic_id exists under this room.",
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
    {
      name: "grant_subagent_tell",
      description:
        "Allow one descendant subagent to tell_session another topic in this managed subagent tree. " +
        "Direct-parent reporting is always allowed and does not need a grant.",
      schema: {
        subagent_topic_id: z.string().describe("Source descendant subagent topic id."),
        target_topic_id: z
          .string()
          .describe("Target topic id: this manager room or another descendant in its tree."),
      },
      async handler(input) {
        const result = ownedSubagentTree(ctx);
        if (!result.ok) return errorResult(result.error);
        const sourceId = String(input.subagent_topic_id ?? "").trim();
        const targetId = String(input.target_topic_id ?? "").trim();
        const descendantIds = new Set(result.children.map((child) => child.id));
        if (!descendantIds.has(sourceId)) {
          return errorResult("Error: source is not a descendant subagent managed by this room.");
        }
        if (targetId !== ctx.topicId && !descendantIds.has(targetId)) {
          return errorResult("Error: target is outside this room's managed subagent tree.");
        }
        if (getTopic(sourceId)?.parentTopicId === targetId) {
          return textResult("No grant needed: a subagent can always report to its direct parent.");
        }
        grantSubagentTellTarget(sourceId, targetId, ctx.topicId);
        return textResult(`tell_session grant added: ${sourceId} -> ${targetId}`);
      },
    },
    {
      name: "revoke_subagent_tell",
      description:
        "Remove an extra tell_session connection previously granted to a descendant subagent.",
      schema: {
        subagent_topic_id: z.string().describe("Source descendant subagent topic id."),
        target_topic_id: z.string().describe("Granted target topic id."),
      },
      async handler(input) {
        const result = ownedSubagentTree(ctx);
        if (!result.ok) return errorResult(result.error);
        const sourceId = String(input.subagent_topic_id ?? "").trim();
        const targetId = String(input.target_topic_id ?? "").trim();
        const descendantIds = new Set(result.children.map((child) => child.id));
        if (!descendantIds.has(sourceId)) {
          return errorResult("Error: source is not a descendant subagent managed by this room.");
        }
        if (targetId !== ctx.topicId && !descendantIds.has(targetId)) {
          return errorResult("Error: target is outside this room's managed subagent tree.");
        }
        const removed = revokeSubagentTellTarget(sourceId, targetId);
        return textResult(removed ? "tell_session grant removed." : "No matching grant existed.");
      },
    },
  ];
}

export function createSpawnSubagentToolDefinition(ctx: SpawnSubagentToolContext): SharedMcpTool {
  return {
    name: "spawn_subagent",
    description:
      "Delegate a self-contained task to a subagent that works in its own new agent room. " +
      "Returns immediately; the subagent runs in the background and reports according to report_mode. " +
      "The fresh room has no parent conversation history; it receives the task plus the selected or inherited topic memory. " +
      "Use for parallelizable or long-running side work. Do not use provider built-in Task/Agent subagents.",
    schema: {
      task: z
        .string()
        .describe(
          "Self-contained task brief. The worker has topic memory but no parent conversation history, so include all task-specific context.",
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
      memory_topic: z
        .string()
        .optional()
        .describe(
          "Optional knowledge source: an accessible topic id/title or topic/*.md brief. Defaults to the parent room's effective topic brief.",
        ),
      report_mode: z
        .enum(["auto", "tell", "status-only"])
        .optional()
        .describe(
          "Completion reporting: auto injects the final result, tell requires tell_session, status-only updates only the lifecycle card.",
        ),
    },
    async handler(input) {
      return createSubagent(ctx, input, true);
    },
  };
}

export function createPrepareSubagentToolDefinition(ctx: SpawnSubagentToolContext): SharedMcpTool {
  return {
    name: "create_subagent",
    description:
      "Create a prepared subagent room and task definition without starting its AI turn. " +
      "Use start_subagent when the team is ready to run it.",
    schema: {
      task: z.string().describe("Self-contained task brief for the subagent."),
      name: z.string().optional().describe("Short room name. Auto-generated when omitted."),
      agent: z.enum(["claude", "codex", "maestro"]).optional(),
      model: z.string().optional(),
      memory_topic: z
        .string()
        .optional()
        .describe(
          "Optional accessible topic id/title or topic/*.md brief to use as this worker's knowledge source. Defaults to the parent.",
        ),
      report_mode: z.enum(["auto", "tell", "status-only"]).optional(),
    },
    async handler(input) {
      return createSubagent(ctx, input, false);
    },
  };
}
