#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ACTIVE_QUERY_STALE_MS, USERS_LOG_DIR } from "#platform/config";
import { errMsg } from "#platform/error";
import { appendJsonlEntry, readJsonFile } from "#platform/jsonl";
import {
  formatMcpStatus,
  OPTIONAL_FORUM_MCP_SERVERS,
  REQUIRED_FORUM_MCP_SERVERS,
} from "#platform/mcp-config";
import { closeBrowserOwnerTabs } from "#platform/playwright/manager";
import { sanitizeId } from "#security/sanitize";
import { getTopic } from "#storage/api-topics";
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
import { connectStdio, mcpError, mcpOk } from "../mcp-helpers";
import { forwardToPeer, peerSessionsForUser } from "./peer-forward";
import {
  currentDepth,
  currentTopic,
  currentTopicId,
  isManagerTopic,
  isReplyOnly,
  MAX_MESSAGE_LENGTH,
  MAX_TELL_DEPTH,
  peerHostQueryId,
  userId,
} from "./runtime";
import {
  currentApiTopicId,
  getMcpConfig,
  setCurrentTopicDescription,
  setMcpConfig,
} from "./topic-config";
import {
  buildInboxPath,
  getTopicsForUser,
  listSessionTargetsForUser,
  type QueryState,
  validateTarget,
} from "./topics";

/** Addressing: "<nodeName>/<topicTitle>". Node names never contain "/", so
 *  the first slash splits reliably (kept for future cross-node adapters). */
interface PeerTarget {
  node: string;
  topic: string;
}

/** A target is remote when it is not a local topic name AND parses as
 *  "node/topic". Local titles containing "/" keep working — the local map is
 *  checked first. */
function remotePeerTarget(to: string): PeerTarget | null {
  // Local titles always win; placement routing is adapter-owned (an otium
  // worker keeps its own placement store), so core never remote-routes a
  // local topic.
  const local = getTopicsForUser()[to];
  if (local?.topicId) return null;
  const slash = to.indexOf("/");
  if (slash <= 0 || slash === to.length - 1) return null;
  return { node: to.slice(0, slash), topic: to.slice(slash + 1) };
}

// --- MCP Server ---

const server = new McpServer({
  name: "session-comm",
  version: "1.0.0",
});

function queryStateFileName(topicId: string): string {
  return `${sanitizeId(topicId)}.json`;
}

function readQueryState(
  activeQueriesDir: string,
  topicId: string | undefined,
  legacyTopicName: string,
): QueryState | null {
  if (topicId) {
    const current = readJsonFile<QueryState>(join(activeQueriesDir, queryStateFileName(topicId)));
    if (current) return current;
  }
  if (
    !legacyTopicName ||
    legacyTopicName === "." ||
    legacyTopicName === ".." ||
    basename(legacyTopicName) !== legacyTopicName
  ) {
    return null;
  }
  return readJsonFile<QueryState>(join(activeQueriesDir, `${legacyTopicName}.json`));
}

function currentTopicRef(): { key: string; title: string; topicId?: string } {
  if (currentTopicId) {
    try {
      const topic = getTopic(currentTopicId);
      if (topic) {
        return {
          key: `${topic.kind ?? "channel"}:${topic.title}`,
          title: topic.title,
          topicId: topic.id,
        };
      }
    } catch {
      // Fall back to the CLI title below.
    }
  }
  return {
    key: currentTopic,
    title: currentTopic,
    ...(currentTopicId ? { topicId: currentTopicId } : {}),
  };
}

// --- always available ---

server.tool(
  "list_sessions",
  "List all available Claude sessions (forum topics) for inter-session communication. Topics without an active session are still valid targets — ask_session / tell_session will wake them with a fresh session on first delivery.",
  {},
  async () => {
    const entries = listSessionTargetsForUser()
      .filter(({ topic }) => Boolean(topic.agent))
      .map(({ key, topic: t }) => {
        const status = !t.agent
          ? "no AI invited"
          : t.sessionId
            ? `active (${t.sessionId.slice(0, 8)})`
            : "fresh-start ready";
        const desc = t.description
          ? `\n    description: ${t.description.slice(0, 80)}${t.description.length > 80 ? "..." : ""}`
          : "";
        return `- ${key}: ${status}${desc}`;
      });

    // Multi-node: append each peer node's rooms, addressed as "node/topic".
    // Disabled or unattached nodes answer with an error — skip silently so
    // single-node behavior is untouched.
    const remoteSections: string[] = [];
    const peers = await peerSessionsForUser(userId, peerHostQueryId || undefined);
    if (peers.ok && peers.nodes) {
      for (const node of peers.nodes) {
        if (!node.node) continue;
        if (node.error) {
          remoteSections.push(`\nNode ${node.node}: (unreachable: ${node.error})`);
          continue;
        }
        const lines = (node.sessions ?? [])
          .filter((session) => Boolean(session.agent))
          .map((s) => {
            const status = s.hasSession ? "active" : "fresh-start ready";
            const desc = s.description ? ` — ${s.description.slice(0, 60)}` : "";
            return `- ${node.node}/${s.name}: ${status}${desc}`;
          });
        remoteSections.push(
          `\nNode ${node.node}:\n${lines.join("\n") || "  (no rooms for this user)"}`,
        );
      }
    }

    if (entries.length === 0 && remoteSections.length === 0) {
      return mcpOk("No other sessions available.");
    }

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Current session: ${currentTopic}\nTell depth: ${currentDepth}/${MAX_TELL_DEPTH}\n\n` +
            `Available sessions:\n${entries.join("\n")}${remoteSections.join("\n")}`,
        },
      ],
    };
  },
);

server.tool(
  "configure_mcp",
  `Configure MCP servers for the current topic. Changes take effect on the next user message automatically (no restart needed).\n` +
    `- enabled: optional servers to whitelist on top of required ones (null or [] = required-only). Required servers are always active regardless: ${REQUIRED_FORUM_MCP_SERVERS.join(", ")}\n` +
    `- Optional servers you can toggle: ${OPTIONAL_FORUM_MCP_SERVERS.join(", ")}.`,
  {
    enabled: z
      .array(z.string())
      .nullable()
      .optional()
      .describe(
        `Optional servers to enable on top of required ones. null or [] = required-only, or a subset of: ${OPTIONAL_FORUM_MCP_SERVERS.join(", ")}`,
      ),
  },
  async ({ enabled }) => {
    if (!currentTopic || !userId) {
      return mcpError("Error: No current topic.");
    }
    if (isManagerTopic) {
      return mcpError(
        "Error: General is a manager room and does not use per-topic MCP whitelists. Use topic-admin set_topic_mcp for a target topic.",
      );
    }
    try {
      setMcpConfig(enabled);
      const current = getMcpConfig();
      const lines = [
        `MCP 설정 저장됨 (다음 사용자 메시지부터 자동 적용, 재시작 불필요)`,
        ``,
        ...formatMcpStatus(current),
      ];
      return mcpOk(lines.join("\n"));
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

server.tool(
  "get_mcp_config",
  "Get the current MCP server configuration for this topic. Required servers are always active regardless of whitelist settings.",
  {},
  async () => {
    if (isManagerTopic) {
      return mcpOk(
        "General is a manager room. It uses the manager MCP bundle directly; per-topic MCP whitelist settings do not apply. Use topic-admin get_topic_mcp for a target topic.",
      );
    }
    const config = getMcpConfig();
    const lines = [`현재 토픽: ${currentTopic}`, ``, ...formatMcpStatus(config)];
    return mcpOk(lines.join("\n"));
  },
);

server.tool(
  "get_browser_profile",
  "Get this topic's browser profile and the other owned topics assigned to each profile.",
  {},
  async () => {
    const topicId = currentApiTopicId();
    if (!topicId || !userId) return mcpError("Error: No current API topic.");
    if (!isTopicBrowserProfileOwner(topicId, userId)) {
      return mcpError("Error: Only the topic owner can inspect its browser profiles.");
    }
    const ownerId = getBrowserProfileOwner(topicId, userId);
    return mcpOk(
      JSON.stringify(
        {
          current: getTopicBrowserProfile(topicId),
          profiles: listBrowserProfiles(ownerId),
        },
        null,
        2,
      ),
    );
  },
);

server.tool(
  "set_browser_profile",
  "Assign this topic to a named shared browser profile. Topics with the same owner and profile share login state but keep owner-isolated tabs. Takes effect next turn.",
  {
    profile: z
      .string()
      .describe("1-48 lowercase letters, numbers, '-' or '_'; use default for the default profile"),
  },
  async ({ profile }) => {
    const topicId = currentApiTopicId();
    if (!topicId || !userId) return mcpError("Error: No current API topic.");
    try {
      if (!isTopicBrowserProfileOwner(topicId, userId)) {
        return mcpError("Error: Only the topic owner can change its browser profile.");
      }
      const result = assignTopicBrowserProfile({ topicId, actorUserId: userId, profile });
      let cleanupWarning = "";
      if (result.previous !== result.profile) {
        try {
          await closeBrowserOwnerTabs(userId, result.previous, `topic:${topicId}`);
        } catch (err) {
          cleanupWarning = ` Previous-profile tab cleanup failed: ${errMsg(err)}`;
        }
      }
      return mcpOk(
        `Browser profile changed: ${result.previous} -> ${result.profile}. It takes effect next turn.${cleanupWarning}`,
      );
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

// --- always-available session inspection / self-config ---

server.tool(
  "peek_session",
  "Check which sessions are currently running a query (busy) vs idle. Useful before abort_session.",
  {},
  async () => {
    const targets = listSessionTargetsForUser();
    const activeQueriesDir = join(USERS_LOG_DIR, userId, "active-queries");

    // Read own query state for consistent display
    let selfLabel = `${currentTopic} (자신 — 실행 중)`;
    const selfState = readQueryState(activeQueriesDir, currentTopicId || undefined, currentTopic);
    if (selfState) {
      const selfElapsed = Date.now() - new Date(selfState.since).getTime();
      const selfMins = Math.floor(selfElapsed / 60000);
      const selfSecs = Math.floor((selfElapsed % 60000) / 1000);
      const selfTimeStr = selfMins > 0 ? `${selfMins}분 ${selfSecs}초` : `${selfSecs}초`;
      const selfTaskStr = selfState.task ? ` | ${selfState.task}` : "";
      selfLabel = `${currentTopic} (자신 — ${selfTimeStr}${selfTaskStr})`;
    }
    const running: string[] = [selfLabel];
    const idle: string[] = [];

    for (const { key: name, topic } of targets) {
      let isRunning = false;
      const state = readQueryState(activeQueriesDir, topic.topicId, topic.name);
      if (state) {
        const elapsed = Date.now() - new Date(state.since).getTime();
        if (elapsed <= ACTIVE_QUERY_STALE_MS) {
          const mins = Math.floor(elapsed / 60000);
          const secs = Math.floor((elapsed % 60000) / 1000);
          const timeStr = mins > 0 ? `${mins}분 ${secs}초` : `${secs}초`;
          const taskStr = state.task ? ` | ${state.task}` : "";
          running.push(`${name} (${timeStr}${taskStr})`);
          isRunning = true;
        }
      }
      if (!isRunning) idle.push(name);
    }

    const runningHeader = `실행 중 (${running.length}):\n${running.map((r) => `  ${r}`).join("\n")}`;
    const pendingAsks = listPendingAsksForCaller({
      userId,
      from: currentTopicRef().key,
    });
    const lines = [
      `현재 세션 상태`,
      ``,
      runningHeader,
      `유휴 (${idle.length}): ${idle.join(", ") || "없음"}`,
    ];
    if (pendingAsks.length) {
      lines.push(
        ``,
        `내 ask_session 대기:`,
        ...pendingAsks.map(
          (ask) =>
            `  ${ask.to}: ${describePendingAskState(ask.state)} (request_id: ${ask.requestId})`,
        ),
      );
    }
    return mcpOk(lines.join("\n"));
  },
);

server.tool(
  "set_description",
  "Set a description for the current session. Acts as a system prompt addition and routing hint for other sessions using list_sessions. Call this once at session start based on the topic's CLAUDE.md.",
  {
    description: z
      .string()
      .describe(
        "What this session specializes in (e.g. 'UE5 graphics development, shader optimization')",
      ),
  },
  async ({ description }) => {
    try {
      setCurrentTopicDescription(description);
      return mcpOk(`Description set for "${currentTopic}".`);
    } catch (err) {
      return mcpError(`Error: ${errMsg(err)}`);
    }
  },
);

// --- outbound session-to-session tools ---
// Suppressed when running as a silent fork that exists only to generate an
// ask_session reply — such a fork has no reason to initiate further calls.

if (!isReplyOnly) {
  server.tool(
    "ask_session",
    "ASK — Delegate to another session and pull the result back INTO YOUR CONTEXT. Target forks (no history pollution), processes with full tools, and the answer is auto-injected into your conversation. Use ONLY when YOU need the output to drive your next action (code reviews whose verdict determines your next edit, fact checks you'll cite, lookups that decide your next step). If the user can just read the result in the target topic, use tell_session — ask burns your context window with content you don't actually need. Decision rule: 'Do I need this output in MY context to proceed?' Yes → ask. No (result lives in target topic, user reads it there) → tell_session.",
    {
      to: z.string().describe("Target session/topic name (e.g. '회의록', '신건')"),
      message: z.string().describe("Message to send to the target session"),
    },
    async ({ to, message }) => {
      if (message.length > MAX_MESSAGE_LENGTH) {
        return mcpError(
          `Error: message too long (${message.length} chars, max ${MAX_MESSAGE_LENGTH})`,
        );
      }

      // Remote target ("node/topic") — hand to the runtime's peer forwarder.
      const remote = remotePeerTarget(to);
      if (remote) {
        const fromRef = currentTopicRef();
        if (!fromRef.topicId) {
          return mcpError(
            "Error: 이 세션은 원격 ask_session을 사용할 수 없습니다 (topic id 없음).",
          );
        }
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const pending = createPendingAsk({ userId, from: fromRef.key, to, requestId });
        if (!pending.ok) {
          const detail = pending.existing
            ? `${describePendingAskState(pending.existing.state)} (request_id: ${pending.existing.requestId})`
            : "상태 파일 확인 중";
          return mcpError(
            `"${to}"에 이미 진행 중인 ask_session 요청이 있습니다: ${detail}. 응답이 이 세션에 자동으로 돌아올 때까지 기다리세요.`,
          );
        }
        const result = await forwardToPeer({
          action: "ask",
          toNode: remote.node,
          toTopic: remote.topic,
          userId,
          fromKey: fromRef.key,
          fromTitle: fromRef.title,
          fromTopicId: fromRef.topicId,
          message,
          requestId,
          fromDepth: currentDepth,
          ...(peerHostQueryId ? { sourceQueryId: peerHostQueryId } : {}),
        });
        if (!result.ok) {
          clearPendingAsk({ userId, from: fromRef.key, to, requestId });
          return mcpError(`Error: "${to}" 원격 세션에 전송 실패: ${result.error}`);
        }
        return mcpOk(
          `"${to}" 세션(노드 ${remote.node})에 참조 요청을 보냈습니다.\n\nrequest_id: ${requestId}\n\n응답은 '[Reply from ${remote.node}/${remote.topic}]' 형식으로 이 세션에 자동으로 돌아옵니다. 응답이 도착할 때까지 같은 요청으로 ask_session을 재호출하지 마세요.`,
        );
      }

      const validation = validateTarget(to);
      if (!validation.ok) return validation.error;
      if (!validation.target.agent) {
        return mcpError(
          `Error: "${to}" 토픽에는 AI가 초대되어 있지 않아 ask_session을 실행할 수 없습니다.`,
        );
      }

      const fromRef = currentTopicRef();
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pending = createPendingAsk({
        userId,
        from: fromRef.key,
        to,
        requestId,
      });
      if (!pending.ok) {
        const detail = pending.existing
          ? `${describePendingAskState(pending.existing.state)} (request_id: ${pending.existing.requestId})`
          : "상태 파일 확인 중";
        return mcpError(
          `"${to}"에 이미 진행 중인 ask_session 요청이 있습니다: ${detail}. 응답이 이 세션에 자동으로 돌아올 때까지 기다리세요.`,
        );
      }

      try {
        const targetTopicId = validation.target.topicId;
        if (!targetTopicId) {
          clearPendingAsk({ userId, from: fromRef.key, to, requestId });
          return mcpError(`Error: "${to}" 세션의 토픽 ID를 찾을 수 없습니다.`);
        }
        const inboxFile = buildInboxPath(targetTopicId);
        const entry = {
          type: "ask" as const,
          requestId,
          from: fromRef.key,
          fromTitle: fromRef.title,
          ...(fromRef.topicId ? { fromTopicId: fromRef.topicId } : {}),
          message,
          // Caller's depth — used to resume this session at the correct depth
          // when the fork's reply is injected back.
          fromDepth: currentDepth,
          timestamp: new Date().toISOString(),
        };
        appendJsonlEntry(inboxFile, entry);
        process.stderr.write(
          `[session-comm] ask_session: ${fromRef.key} → ${to} requestId=${requestId}\n`,
        );
      } catch (err) {
        clearPendingAsk({
          userId,
          from: fromRef.key,
          to,
          requestId,
        });
        const e = err as { message?: string };
        process.stderr.write(
          `[session-comm] ask_session: failed ${currentTopic} → ${to} requestId=${requestId}: ${e?.message || "Unknown"}\n`,
        );
        return mcpError(`Error: "${to}" 세션에 메시지 전송 실패: ${e?.message || "Unknown"}`);
      }

      return mcpOk(
        `"${to}" 세션에 참조 요청을 보냈습니다.\n\nrequest_id: ${requestId}\n\n"${to}"의 응답은 '[ask_session 응답 ← ${to} | request_id: ${requestId}]' 형식으로 이 세션에 자동으로 돌아옵니다. 응답이 도착할 때까지 같은 요청으로 ask_session을 재호출하지 마세요.`,
      );
    },
  );

  server.tool(
    "abort_session",
    "Abort the currently running query in another session. Use peek_session first to confirm it is busy.",
    {
      to: z.string().describe("Target session/topic name to abort"),
    },
    async ({ to }) => {
      const remote = remotePeerTarget(to);
      if (remote) {
        const result = await forwardToPeer({
          action: "abort",
          toNode: remote.node,
          toTopic: remote.topic,
          userId,
          ...(peerHostQueryId ? { sourceQueryId: peerHostQueryId } : {}),
        });
        if (!result.ok) {
          return mcpError(`Error: "${to}" 원격 abort 실패: ${result.error}`);
        }
        return mcpOk(`"${to}" 세션(노드 ${remote.node})에 abort 신호를 보냈습니다.`);
      }

      const validation = validateTarget(to);
      if (!validation.ok) return validation.error;

      if (to === currentTopic) {
        return mcpError(`Error: 자기 자신은 abort할 수 없습니다.`);
      }

      try {
        const targetTopicId = validation.target.topicId;
        if (!targetTopicId) {
          return mcpError(`Error: "${to}" 세션의 토픽 ID를 찾을 수 없습니다.`);
        }
        const inboxFile = buildInboxPath(targetTopicId);
        mkdirSync(dirname(inboxFile), { recursive: true });
        // Send query abort signal via inbox
        appendJsonlEntry(inboxFile, {
          type: "abort",
          timestamp: new Date().toISOString(),
        });
        process.stderr.write(`[session-comm] abort_session: ${currentTopic} → ${to}\n`);
      } catch (err) {
        const e = err as { message?: string };
        process.stderr.write(
          `[session-comm] abort_session: failed ${currentTopic} → ${to}: ${e?.message || "Unknown"}\n`,
        );
        return mcpError(`Error: abort 신호 전송 실패: ${e?.message || "Unknown"}`);
      }

      return mcpOk(`"${to}" 세션에 abort 신호를 보냈습니다. 실행 중인 쿼리가 있으면 중단됩니다.`);
    },
  );

  server.tool(
    "tell_session",
    "TELL — Delegate work or push context TO another session (one-way, nothing returns to your context). Message joins target's history; target processes async with full tools and the result lives in the target topic. Use for: delegating long-running or self-contained work (experiments, benchmarks, monitoring runs, file generation), status updates, persistent context injection — anything whose output the user can simply read in the target topic without you needing it. Prefer tell over ask_session whenever YOUR context doesn't need the result, since ask injects the full reply back and burns context. Decision rule: 'Do I need this output in MY context to proceed?' No → tell. Yes → ask_session.",
    {
      to: z.string().describe("Target session/topic name (e.g. '회의록', '신건')"),
      message: z.string().describe("Message to send to the target session"),
    },
    async ({ to, message }) => {
      if (message.length > MAX_MESSAGE_LENGTH) {
        return mcpError(
          `Error: message too long (${message.length} chars, max ${MAX_MESSAGE_LENGTH})`,
        );
      }

      if (currentDepth + 1 > MAX_TELL_DEPTH) {
        return mcpError(
          `Error: depth limit reached (current ${currentDepth}, max ${MAX_TELL_DEPTH}). Cannot build any more tell_session chains.`,
        );
      }

      // Remote target ("node/topic") — hand to the runtime's peer forwarder.
      const remote = remotePeerTarget(to);
      if (remote) {
        const fromRef = currentTopicRef();
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await forwardToPeer({
          action: "tell",
          toNode: remote.node,
          toTopic: remote.topic,
          userId,
          fromKey: fromRef.key,
          fromTitle: fromRef.title,
          ...(fromRef.topicId ? { fromTopicId: fromRef.topicId } : {}),
          message,
          requestId,
          depth: currentDepth + 1,
          ...(peerHostQueryId ? { sourceQueryId: peerHostQueryId } : {}),
        });
        if (!result.ok) {
          return mcpError(`Error: "${to}" 원격 세션에 전송 실패: ${result.error}`);
        }
        return mcpOk(
          `"${to}" 토픽(노드 ${remote.node})에 메시지를 전달했습니다.\n\nrequest_id: ${requestId}\n\n결과는 해당 노드의 "${remote.topic}" 대화 기록에 남습니다.`,
        );
      }

      const validation = validateTarget(to);
      if (!validation.ok) return validation.error;
      if (!validation.target.agent) {
        return mcpError(
          `Error: "${to}" 토픽에는 AI가 초대되어 있지 않아 tell_session으로 작업을 trigger할 수 없습니다.`,
        );
      }

      const targetTopicId = validation.target.topicId;
      if (!targetTopicId) {
        return mcpError(`Error: "${to}" 세션의 토픽 ID를 찾을 수 없습니다.`);
      }

      // Write to inbox — the Otium consumer will persist the DB message
      // and trigger the AI turn. This matches the ask_session / abort_session
      // pattern where the MCP is a pure writer and the consumer is the consumer.
      //
      // NOTE: no direct DB write here; the consumer in the Otium server process
      // handles `deliverMessageToTopic` + the AI trigger.
      const fromRef = currentTopicRef();
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        appendJsonlEntry(buildInboxPath(targetTopicId), {
          type: "tell",
          requestId,
          from: fromRef.key,
          fromTitle: fromRef.title,
          ...(fromRef.topicId ? { fromTopicId: fromRef.topicId } : {}),
          message,
          depth: currentDepth + 1,
          timestamp: new Date().toISOString(),
        });
      } catch (err: unknown) {
        const e = err instanceof Error ? err : new Error(String(err));
        process.stderr.write(
          `[session-comm] tell_session: failed to write inbox ${currentTopic} → ${to}: ${e.message}\n`,
        );
        return mcpError(`Error: "${to}" 세션에 메시지 전송 실패: ${e.message}`);
      }
      process.stderr.write(
        `[session-comm] tell_session: ${fromRef.key} → ${to} requestId=${requestId} (topic ${validation.target.topicId ?? validation.target.name})\n`,
      );

      return mcpOk(
        `"${to}" 토픽에 메시지를 전달했습니다.\n\nrequest_id: ${requestId}\n\n"${to}"의 대화 기록에 남습니다(다시 열거나 새로고침하면 보입니다).`,
      );
    },
  );
}

await connectStdio(server);
