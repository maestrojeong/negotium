/**
 * Node tools — the negotium MCP's headline tool surface for driving the
 * local runtime: create/list topics and abort/restart/delete lifecycle control.
 * Cross-topic messaging belongs exclusively to the session-comm MCP
 * (`tell_session` / `ask_session`) so there is one unambiguous contract.
 *
 * Every tool is keyed by `ctx.userId` from the verified per-turn token; a
 * caller can never see or touch another user's topics.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  abortRoom,
  appendJsonlEntry,
  defaultTopicSurface,
  deleteTopicCascade,
  EFFORT_VALUES,
  type EffortLevel,
  errMsg,
  errorResult,
  getRoomQuery,
  getTopic,
  getTopicByNameForUser,
  getTopics,
  isParticipant,
  logger,
  type RuntimeMcpContext,
  registerTopic,
  restartTopicSession,
  sessionInboxPath,
  TopicArchiveRequiredError,
  TopicCleanupRequiredError,
  type TopicDto,
  type TopicSurface,
  TopicValidationError,
  textResult,
} from "@negotium/core/mcp-runtime-host";
import { z } from "zod";

/**
 * Resolve a topic reference (canonical id or title) to a topic the calling
 * user participates in. Non-member topics resolve as "not found" so the
 * error never leaks another user's topic existence.
 */
/**
 * The surface the calling turn is running on. Every discovery and creation
 * tool below is scoped to it, so an agent in a Telegram room cannot enumerate
 * or create terminal rooms, and equal titles on other surfaces do not make a
 * title lookup ambiguous.
 */
function callerSurface(ctx: RuntimeMcpContext): TopicSurface {
  return getTopic(ctx.topicId)?.surface ?? defaultTopicSurface();
}

/** The workspace instance the calling turn belongs to. Always null off `otium`. */
function callerSurfaceScope(ctx: RuntimeMcpContext): string | null {
  return getTopic(ctx.topicId)?.surfaceScope ?? null;
}

/**
 * The rooms the calling turn is allowed to see and name.
 *
 * On `terminal` and `telegram` this node owns membership, so participation is
 * the only boundary there is and nothing weaker would be safe.
 *
 * On `otium` it is not a boundary at all. A hub backs each of its rooms with a
 * node topic created under the hub's own execution principal, and per-person
 * membership stays in the hub's store (D-3) — the hub has already decided who
 * may speak in a room before the turn reaches this node. Scoping that surface
 * by `ctx.userId` therefore matched none of the rooms the caller actually
 * works in: a manager turn asked "what topics do I have?" answered "one",
 * naming only the private General this node had just created for that person,
 * while the workspace it was speaking for held every other room. The
 * workspace — surface plus scope — is the real boundary there. Other people's
 * private Generals are still excluded, because a manager room is the one
 * per-user room on that surface and the one thing membership does decide.
 */
function topicsForCaller(ctx: RuntimeMcpContext): TopicDto[] {
  const surface = callerSurface(ctx);
  if (surface !== "otium") {
    return getTopics({ surface }).filter((topic) => isParticipant(topic, ctx.userId));
  }
  return getTopics({ surface, surfaceScope: callerSurfaceScope(ctx) }).filter(
    (topic) =>
      topic.kind !== "manager" || topic.id === ctx.topicId || isParticipant(topic, ctx.userId),
  );
}

function resolveTopicForUser(
  ctx: RuntimeMcpContext,
  ref: string,
): { topic: TopicDto } | { error: string } {
  const trimmed = ref.trim();
  if (!trimmed) return { error: "Error: topic is required." };
  const notFound = `Error: topic '${trimmed}' not found (or not uniquely named). Use list_topics to see available topics.`;
  const surface = callerSurface(ctx);
  if (surface === "otium") {
    // Same visibility as `list_topics`, or the manager room could list a room
    // it is then told does not exist.
    const visible = topicsForCaller(ctx);
    const byId = visible.find((topic) => topic.id === trimmed);
    if (byId) return { topic: byId };
    const wanted = trimmed.toLowerCase();
    const byTitle = visible.filter((topic) => topic.title.toLowerCase() === wanted);
    return byTitle.length === 1 ? { topic: byTitle[0]! } : { error: notFound };
  }
  const byId = getTopic(trimmed);
  if (byId) {
    // Membership is not enough. The by-title branch below is surface-scoped,
    // so leaving the id branch on participation alone made the id the way
    // around it: one account is normally a participant of its own rooms on
    // every surface, so an agent on `telegram` that knows a `terminal` room's
    // id could abort, restart or delete it through these tools. Same check on
    // both branches, or the cheaper one is simply the exploit.
    if (!isParticipant(byId, ctx.userId) || byId.surface !== surface) return { error: notFound };
    return { topic: byId };
  }
  const byTitle = getTopicByNameForUser(trimmed, ctx.userId, { surface });
  if (byTitle) return { topic: byTitle };
  return { error: notFound };
}

function describeTopic(topic: TopicDto): string {
  const running = getRoomQuery(topic.id) ? "turn running" : "idle";
  const agent = topic.agent ? `agent: ${topic.agent}` : "no agent";
  return `- "${topic.title}" (id: ${topic.id}, kind: ${topic.kind ?? "agent"}, ${agent}, ${running})`;
}

export function registerNodeTools(server: McpServer, ctx: RuntimeMcpContext): void {
  server.tool(
    "register_topic",
    "Create a new topic (agent room) on this negotium node, owned by the calling user. " +
      "Returns the new topic's id, title, agent, and model. Use the session-comm tell_session " +
      "tool to hand the new topic work.",
    {
      title: z.string().describe("Unique title for the new topic."),
      agent: z
        .enum(["claude", "codex", "maestro"])
        .optional()
        .describe("AI backend for the room. Defaults to maestro."),
      model: z.string().optional().describe("Model override, must be valid for the agent."),
      effort: z.enum(EFFORT_VALUES).optional().describe("Reasoning effort override for the room."),
      description: z.string().optional().describe("Short description of the topic's purpose."),
    },
    async ({ title, agent, model, effort, description }) => {
      try {
        const topic = registerTopic({
          title,
          userId: ctx.userId,
          surface: callerSurface(ctx),
          agent,
          model,
          effort: effort as EffortLevel | undefined,
          description,
        });
        return textResult(
          [
            `Topic registered.`,
            `id: ${topic.id}`,
            `title: ${topic.title}`,
            `agent: ${topic.agent ?? "none"}`,
            `model: ${topic.defaultModel}`,
          ].join("\n"),
        );
      } catch (err) {
        if (err instanceof TopicValidationError) return errorResult(`Error: ${err.message}`);
        logger.error({ err, title }, "negotium MCP: register_topic failed");
        return errorResult(`Error: failed to register topic: ${errMsg(err)}`);
      }
    },
  );

  server.tool(
    "list_topics",
    "List the topics this turn can reach on this negotium node: title, id, kind, agent, and whether a turn is currently running.",
    {},
    async () => {
      const topics = topicsForCaller(ctx);
      if (topics.length === 0) {
        return textResult("No topics found. Use register_topic to create one.");
      }
      return textResult(topics.map(describeTopic).join("\n"));
    },
  );

  server.tool(
    "abort_topic",
    "Abort the running turn in another topic on this node. Fire-and-forget: also queues an abort " +
      "signal in the topic's inbox so a turn that has not started yet is cancelled too. Returns whether an active turn was aborted.",
    {
      topic: z.string().describe("Target topic title or id."),
    },
    async ({ topic }) => {
      const resolved = resolveTopicForUser(ctx, topic);
      if ("error" in resolved) return errorResult(resolved.error);
      const target = resolved.topic;
      if (target.id === ctx.topicId) {
        return errorResult("Error: cannot abort the current topic from within its own turn.");
      }

      const aborted = abortRoom(target.id);
      let queued = true;
      try {
        // Cover the not-yet-started case: the inbox consumer drops queued work
        // when it sees the abort entry.
        appendJsonlEntry(sessionInboxPath(ctx.userId, target.id), {
          type: "abort",
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        queued = false;
        logger.warn({ err, topicId: target.id }, "negotium MCP: abort inbox write failed");
      }
      if (aborted) return textResult(`Aborted the active turn in "${target.title}".`);
      // Reporting a queued abort that was never written told the caller the
      // topic would stop when nothing had been delivered.
      return textResult(
        queued
          ? `No active turn in "${target.title}"; abort signal queued in its inbox.`
          : `No active turn in "${target.title}", and the abort signal could NOT be queued ` +
              `(its inbox is locked). The topic will run its queued work; retry shortly.`,
      );
    },
  );

  server.tool(
    "restart_topic",
    "Reset another topic's AI context while preserving the topic and its visible message history. " +
      "The next message starts a fresh provider session. Only the topic owner can restart it.",
    {
      topic: z.string().describe("Target topic title or id."),
    },
    async ({ topic }) => {
      const resolved = resolveTopicForUser(ctx, topic);
      if ("error" in resolved) return errorResult(resolved.error);
      const target = resolved.topic;
      if (target.id === ctx.topicId) {
        return errorResult("Error: cannot restart the current topic from within its own turn.");
      }
      if (target.kind === "manager") {
        return errorResult("Error: manager rooms are system-managed and cannot be restarted.");
      }

      const result = await restartTopicSession(target.id, ctx.userId, "runtime-mcp-session-reset");
      return result.isError ? errorResult(`Error: ${result.text}`) : textResult(result.text);
    },
  );

  server.tool(
    "delete_topic",
    "Delete a topic owned by the calling user after archiving its conversation history. Deletion is blocked " +
      "when the archive cannot be written; pass force: true only as an explicit escape hatch that accepts losing history.",
    {
      topic: z.string().describe("Target topic title or id."),
      force: z
        .boolean()
        .optional()
        .describe("Delete even if archiving the conversation history fails. Default false."),
    },
    async ({ topic, force }) => {
      const resolved = resolveTopicForUser(ctx, topic);
      if ("error" in resolved) return errorResult(resolved.error);
      const target = resolved.topic;
      if (target.id === ctx.topicId) {
        return errorResult("Error: cannot delete the current topic from within its own turn.");
      }
      if (target.kind === "manager") {
        return errorResult("Error: manager rooms are system-managed and cannot be deleted.");
      }
      const isOwner = target.participants.some(
        (participant) => participant.userId === ctx.userId && participant.role === "owner",
      );
      if (!isOwner) {
        return errorResult("Error: only the topic owner can delete it.");
      }

      try {
        await deleteTopicCascade(target, ctx.userId, { force: force === true });
      } catch (err) {
        if (err instanceof TopicArchiveRequiredError) {
          return errorResult(
            [
              `Error: deleting "${target.title}" was blocked because its conversation history could not be archived.`,
              "Topics are archived before deletion so no history is lost. Fix the archive failure and retry, or pass force: true to delete anyway and accept losing the history.",
            ].join("\n"),
          );
        }
        if (err instanceof TopicCleanupRequiredError) {
          return errorResult(
            `Error: deleting "${target.title}" was blocked because its provider context could not be fully removed. Fix the cleanup failure and retry.`,
          );
        }
        logger.error({ err, topicId: target.id }, "negotium MCP: delete_topic failed");
        return errorResult(`Error: failed to delete "${target.title}": ${errMsg(err)}`);
      }
      return textResult(`Topic "${target.title}" (id: ${target.id}) deleted.`);
    },
  );
}
