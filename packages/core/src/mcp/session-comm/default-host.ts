import { basename, join } from "node:path";
import type { SessionCommMcpHost, SessionCommMcpResult } from "#mcp/factories/session-comm";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { forwardToPeer, peerSessionsForUser } from "#mcp/session-comm/peer-forward";
import {
  canSubagentTellTarget,
  resolveSubagentTellIdentity,
} from "#mcp/session-comm/tell-permissions";
import { createSessionTargetCatalog } from "#mcp/session-comm/topic-catalog";
import { ACTIVE_QUERY_STALE_MS, MAX_TELL_DEPTH, USERS_LOG_DIR } from "#platform/config";
import { readJsonFile } from "#platform/jsonl";
import { logger } from "#platform/logger";
import { OPTIONAL_FORUM_MCP_SERVERS, REQUIRED_FORUM_MCP_SERVERS } from "#platform/mcp-config";
import { closeBrowserOwnerTabs } from "#platform/playwright/manager";
import { deleteManagedBrowserProfile } from "#platform/playwright/profile-management";
import { getRegisteredCronSession } from "#runtime/cron-sessions";
import { sanitizeId } from "#security/sanitize";
import { getApiTopicConfig, setApiTopicConfig } from "#storage/api-topic-config";
import {
  defaultSurfaceScope,
  defaultTopicSurface,
  getTopic,
  listTopics,
  upsertTopic,
} from "#storage/api-topics";
import {
  assignTopicBrowserProfile,
  getBrowserProfileOwner,
  getTopicBrowserProfile,
  isTopicBrowserProfileOwner,
  listBrowserProfiles,
} from "#storage/browser-profiles";
import {
  clearPendingAsk,
  createPendingAsk,
  describePendingAskState,
  listPendingAsksForCaller,
} from "#storage/session-asks";
import { enqueueSessionInbox } from "#storage/session-inbox";
import { isAgentKind, type QueryState } from "#types";

const MAX_MESSAGE_LENGTH = 10_000;

function ok(text: string): SessionCommMcpResult {
  return { content: [{ type: "text", text }] };
}

function error(text: string): SessionCommMcpResult {
  return { content: [{ type: "text", text }], isError: true };
}

function currentTopic(context: SessionCommContext) {
  const topic = context.currentTopicId ? getTopic(context.currentTopicId) : null;
  if (!topic?.participants.some((participant) => participant.userId === context.userId)) {
    return null;
  }
  return topic;
}

function targetCatalog(context: SessionCommContext) {
  const current = context.currentTopicId ? getTopic(context.currentTopicId) : null;
  const surface = current?.surface ?? defaultTopicSurface();
  // A room may only address rooms in its own workspace (M-8): with several
  // Otium workspaces attached, "same surface" is no longer a boundary — two
  // workspaces share the `otium` surface and must still be invisible to each
  // other. A room with no scope addresses the other unscoped rooms.
  const surfaceScope = current
    ? (current.surfaceScope ?? null)
    : surface === "otium"
      ? defaultSurfaceScope()
      : null;
  return createSessionTargetCatalog({
    currentTopicId: context.currentTopicId,
    currentTopicName: context.currentTopic,
    currentSurface: surface,
    isAgent: isAgentKind,
    // Scoped in the store query, not after the fact.
    listRows: () =>
      listTopics({ surface, surfaceScope })
        .filter((topic) => topic.participants.some((p) => p.userId === context.userId))
        .map((topic) => ({
          id: topic.id,
          title: topic.title,
          kind: topic.kind ?? null,
          agent: topic.agent ?? null,
          sessionId: null,
          description: topic.description ?? null,
          surface: topic.surface ?? null,
        })),
  });
}

function currentRef(context: SessionCommContext) {
  const topic = currentTopic(context);
  return topic
    ? { key: `${topic.kind}:${topic.title}`, title: topic.title, topicId: topic.id }
    : { key: context.currentTopic, title: context.currentTopic, topicId: context.currentTopicId };
}

function remoteTarget(context: SessionCommContext, to: string) {
  if (targetCatalog(context).getTopics()[to]?.topicId) return null;
  const slash = to.indexOf("/");
  if (slash <= 0 || slash === to.length - 1) return null;
  return { node: to.slice(0, slash), topic: to.slice(slash + 1) };
}

function activeQuery(context: SessionCommContext, topicId: string, title: string) {
  const dir = join(USERS_LOG_DIR, context.userId, "active-queries");
  const candidates = [join(dir, `${sanitizeId(topicId)}.json`)];
  if (title && basename(title) === title && title !== "." && title !== "..") {
    candidates.push(join(dir, `${title}.json`));
  }
  for (const path of candidates) {
    const state = readJsonFile<QueryState>(path);
    if (state && Date.now() - new Date(state.since).getTime() <= ACTIVE_QUERY_STALE_MS)
      return state;
  }
  return null;
}

function normalizeMcp(enabled: readonly string[] | null | undefined): string[] | undefined {
  if (enabled === undefined || enabled === null) return undefined;
  const requested = [...new Set(enabled.map((name) => name.trim()).filter(Boolean))];
  const invalid = requested.filter(
    (name) =>
      !OPTIONAL_FORUM_MCP_SERVERS.includes(name) && !REQUIRED_FORUM_MCP_SERVERS.includes(name),
  );
  if (invalid.length) throw new Error(`Unknown MCP server(s): ${invalid.join(", ")}`);
  return requested.filter((name) => OPTIONAL_FORUM_MCP_SERVERS.includes(name));
}

export function createDefaultSessionCommMcpHost(): SessionCommMcpHost {
  return {
    async listSessions(context) {
      const identity = resolveSubagentTellIdentity(
        context.currentTopicId,
        context.subagentParentTopicId,
      );
      const entries = targetCatalog(context)
        .listTargets()
        .filter(
          ({ topic }) =>
            !identity.restricted ||
            Boolean(topic.topicId && canSubagentTellTarget(identity, topic.topicId)),
        )
        .filter(({ topic }) => Boolean(topic.agent))
        .map(
          ({ key, topic }) =>
            `- ${key}: ${topic.sessionId ? "active" : "fresh-start ready"}${topic.description ? `\n    description: ${topic.description.slice(0, 80)}` : ""}`,
        );
      if (!identity.restricted) {
        const peers = await peerSessionsForUser(
          context.userId,
          context.peerHostQueryId,
          context.currentTopicId,
        );
        for (const node of peers.nodes ?? []) {
          for (const session of node.sessions ?? []) {
            if (session.agent)
              entries.push(
                `- ${node.node}/${session.name}: ${session.hasSession ? "active" : "fresh-start ready"}`,
              );
          }
        }
      }
      return ok(
        `Current session: ${context.currentTopic}\nTell depth: ${context.depth}/${MAX_TELL_DEPTH}\n\nAvailable sessions:\n${entries.join("\n") || "none"}`,
      );
    },

    configureMcp(context, enabled) {
      const topic = currentTopic(context);
      if (!topic) return error("Error: No current topic.");
      if (topic.kind === "manager")
        return error("Error: General does not use per-topic MCP settings.");
      try {
        const existing = getApiTopicConfig(topic.id) ?? {};
        setApiTopicConfig(topic.id, { ...existing, mcp: normalizeMcp(enabled) });
        return ok("MCP settings saved. Changes apply on the next user message.");
      } catch (err) {
        return error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    getMcpConfig(context) {
      const topic = currentTopic(context);
      if (!topic) return error("Error: No current topic.");
      if (topic.kind === "manager") return ok("General uses the manager MCP bundle.");
      return ok(JSON.stringify({ enabled: getApiTopicConfig(topic.id)?.mcp ?? [] }));
    },

    getBrowserProfile(context) {
      const topic = currentTopic(context);
      if (!topic) return error("Error: No current API topic.");
      if (!isTopicBrowserProfileOwner(topic.id, context.userId)) {
        return error("Error: Only the topic owner can inspect its browser profiles.");
      }
      const ownerId = getBrowserProfileOwner(topic.id, context.userId);
      return ok(
        JSON.stringify(
          { current: getTopicBrowserProfile(topic.id), profiles: listBrowserProfiles(ownerId) },
          null,
          2,
        ),
      );
    },

    async setBrowserProfile(context, profile) {
      const topic = currentTopic(context);
      if (!topic) return error("Error: No current API topic.");
      if (!isTopicBrowserProfileOwner(topic.id, context.userId)) {
        return error("Error: Only the topic owner can change its browser profile.");
      }
      try {
        const result = assignTopicBrowserProfile({
          topicId: topic.id,
          actorUserId: context.userId,
          profile,
        });
        if (result.previous !== result.profile) {
          await closeBrowserOwnerTabs(context.userId, result.previous, `topic:${topic.id}`);
        }
        return ok(`Browser profile changed: ${result.previous} -> ${result.profile}.`);
      } catch (err) {
        return error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async deleteBrowserProfile(context, profile) {
      const topic = currentTopic(context);
      if (!topic) return error("Error: No current API topic.");
      if (!isTopicBrowserProfileOwner(topic.id, context.userId)) {
        return error("Error: Only the topic owner can delete its browser profiles.");
      }
      try {
        const ownerId = getBrowserProfileOwner(topic.id, context.userId);
        const result = await deleteManagedBrowserProfile(ownerId, profile);
        return ok(JSON.stringify(result, null, 2));
      } catch (err) {
        return error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    peekSession(context) {
      const targets = targetCatalog(context).listTargets();
      const running: string[] = [];
      const idle: string[] = [];
      for (const { key, topic } of targets) {
        if (!topic.topicId) continue;
        const state = activeQuery(context, topic.topicId, topic.name);
        if (state)
          running.push(
            `${key} (${Math.round((Date.now() - new Date(state.since).getTime()) / 1000)}s)`,
          );
        else idle.push(key);
      }
      const pending = listPendingAsksForCaller({
        userId: context.userId,
        from: currentRef(context).key,
      });
      return ok(
        [
          `Running: ${running.join(", ") || "none"}`,
          `Idle: ${idle.join(", ") || "none"}`,
          ...pending.map(
            (ask) => `Pending ${ask.to}: ${describePendingAskState(ask.state)} (${ask.requestId})`,
          ),
        ].join("\n"),
      );
    },

    setDescription(context, description) {
      const topic = currentTopic(context);
      if (!topic) return error("Error: No current topic.");
      upsertTopic({ ...topic, description });
      return ok(`Description set for "${topic.title}".`);
    },

    async askSession(context, { to, message }) {
      if (message.length > MAX_MESSAGE_LENGTH) return error("Error: message too long.");
      const from = currentRef(context);
      const remote = remoteTarget(context, to);
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pending = createPendingAsk({ userId: context.userId, from: from.key, to, requestId });
      if (!pending.ok) return error(`Error: an ask_session request to "${to}" is already pending.`);
      const clearAsk = () =>
        clearPendingAsk({ userId: context.userId, from: from.key, to, requestId });
      if (remote) {
        if (!from.topicId) {
          clearAsk();
          return error("Error: current topic id is unavailable.");
        }
        const result = await forwardToPeer({
          action: "ask",
          toNode: remote.node,
          toTopic: remote.topic,
          userId: context.userId,
          fromKey: from.key,
          fromTitle: from.title,
          fromTopicId: from.topicId,
          message,
          requestId,
          fromDepth: context.depth,
          ...(context.peerHostQueryId ? { sourceQueryId: context.peerHostQueryId } : {}),
        });
        if (!result.ok) {
          clearAsk();
          return error(`Error: ${result.error}`);
        }
      } else {
        const validation = targetCatalog(context).validateTarget(to);
        if (!validation.ok) {
          clearAsk();
          return validation.error;
        }
        if (!validation.target.agent) {
          clearAsk();
          return error(`Error: "${to}" has no AI agent.`);
        }
        const targetTopicId = validation.target.topicId;
        if (!targetTopicId) {
          clearAsk();
          return error(`Error: "${to}" has no topic id.`);
        }
        enqueueSessionInbox({
          userId: context.userId,
          topicId: targetTopicId,
          entry: {
            type: "ask",
            requestId,
            from: from.key,
            fromTitle: from.title,
            ...(from.topicId ? { fromTopicId: from.topicId } : {}),
            message,
            fromDepth: context.depth,
            timestamp: new Date().toISOString(),
          },
        });
      }
      return ok(`Ask sent to "${to}". request_id: ${requestId}`);
    },

    askCron(context, message) {
      if (message.length > MAX_MESSAGE_LENGTH) return error("Error: message too long.");
      const topic = currentTopic(context);
      if (!topic) return error("Error: 현재 토픽을 찾을 수 없습니다.");
      if (!getRegisteredCronSession(topic.id, context.agent)) {
        return error(
          `Error: "${topic.title}" 토픽에 cron 세션이 없습니다. 크론 작업이 최소 한 번 실행되어야 합니다.`,
        );
      }
      const from = currentRef(context);
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pending = createPendingAsk({
        userId: context.userId,
        from: from.key,
        to: topic.title,
        requestId,
      });
      if (!pending.ok) {
        return error(`Error: "${topic.title}"에 이미 진행 중인 요청이 있습니다.`);
      }
      try {
        enqueueSessionInbox({
          userId: context.userId,
          topicId: topic.id,
          entry: {
            type: "ask",
            target: "cron",
            requestId,
            from: from.key,
            fromTitle: from.title,
            fromTopicId: topic.id,
            message,
            fromDepth: context.depth,
            timestamp: new Date().toISOString(),
          },
        });
      } catch (err) {
        clearPendingAsk({ userId: context.userId, from: from.key, to: topic.title, requestId });
        logger.warn(
          { err, topicId: topic.id, requestId },
          "session-comm: failed to enqueue cron ask",
        );
        return error("Error: cron 세션에 메시지를 전송하지 못했습니다.");
      }
      return ok(
        `"${topic.title}:cron" 세션에 참조 요청을 보냈습니다.\n\nrequest_id: ${requestId}\n\n응답은 '[Reply from ${topic.title}:cron]' 형식으로 이 세션에 자동으로 돌아옵니다. 응답이 도착할 때까지 같은 요청으로 ask_cron을 재호출하지 마세요.`,
      );
    },

    async abortSession(context, to) {
      const remote = remoteTarget(context, to);
      if (remote) {
        const result = await forwardToPeer({
          action: "abort",
          toNode: remote.node,
          toTopic: remote.topic,
          userId: context.userId,
          ...(context.peerHostQueryId ? { sourceQueryId: context.peerHostQueryId } : {}),
        });
        return result.ok ? ok(`Abort sent to "${to}".`) : error(`Error: ${result.error}`);
      }
      const validation = targetCatalog(context).validateTarget(to);
      if (!validation.ok) return validation.error;
      const targetTopicId = validation.target.topicId;
      if (!targetTopicId) return error(`Error: "${to}" has no topic id.`);
      if (targetTopicId === context.currentTopicId) return error("Error: cannot abort self.");
      enqueueSessionInbox({
        userId: context.userId,
        topicId: targetTopicId,
        entry: {
          type: "abort",
          timestamp: new Date().toISOString(),
        },
      });
      return ok(`Abort sent to "${to}".`);
    },

    async tellSession(context, { to, message }) {
      if (message.length > MAX_MESSAGE_LENGTH) return error("Error: message too long.");
      if (context.depth + 1 > MAX_TELL_DEPTH) return error("Error: depth limit reached.");
      const from = currentRef(context);
      const remote = remoteTarget(context, to);
      if (remote) {
        const result = await forwardToPeer({
          action: "tell",
          toNode: remote.node,
          toTopic: remote.topic,
          userId: context.userId,
          fromKey: from.key,
          fromTitle: from.title,
          fromTopicId: from.topicId,
          message,
          requestId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          depth: context.depth + 1,
          ...(context.peerHostQueryId ? { sourceQueryId: context.peerHostQueryId } : {}),
        });
        return result.ok ? ok(`Message sent to "${to}".`) : error(`Error: ${result.error}`);
      }
      const validation = targetCatalog(context).validateTarget(to);
      if (!validation.ok) return validation.error;
      if (!validation.target.agent) return error(`Error: "${to}" has no AI agent.`);
      const targetTopicId = validation.target.topicId;
      if (!targetTopicId) return error(`Error: "${to}" has no topic id.`);
      const identity = resolveSubagentTellIdentity(
        context.currentTopicId,
        context.subagentParentTopicId,
      );
      if (!canSubagentTellTarget(identity, targetTopicId)) {
        return error("Error: subagent tell_session target is not permitted.");
      }
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      enqueueSessionInbox({
        userId: context.userId,
        topicId: targetTopicId,
        entry: {
          type: "tell",
          requestId,
          from: from.key,
          fromTitle: from.title,
          ...(from.topicId ? { fromTopicId: from.topicId } : {}),
          message,
          depth: context.depth + 1,
          timestamp: new Date().toISOString(),
        },
      });
      return ok(`Message sent to "${to}". request_id: ${requestId}`);
    },
  };
}
