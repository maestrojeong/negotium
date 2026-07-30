import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "#agents/index";
import { WsHub } from "#bus";
import { WORKSPACE_DIR } from "#platform/config";
import { logger } from "#platform/logger";
import { type AgentDef, loadAgentPrompt } from "#prompts/builders";
import { COMPLETED_BACKGROUND_SESSION_RETENTION_MS } from "#runtime/background-session-policy";
import { sanitizeTopicName } from "#security/sanitize";
import { appendApiMessage } from "#storage/api-messages";
import { getTopicBrief, setTopicBrief } from "#storage/api-topic-brief";
import { getSharedWikiDir } from "#storage/wiki";
import { wikiSummaryFilename } from "#storage/wiki-summary-names";
import { ensurePersonalGeneral } from "#topics/personal-general";
import type { AgentKind, AgentQueryOptions, UnifiedEvent } from "#types";
import type { BackgroundSessionDto, MessageDto } from "#types/api";

/**
 * Rolling cap on the #General digest. The General-brief injection embeds
 * `briefMd` whole (no slice), so an unbounded digest would inflate every
 * General turn's system prompt — keep it to the most recent N topics (~<2KB).
 */
const MAX_BRIEF_ENTRIES = 8;

interface ActiveArchiverSession extends BackgroundSessionDto {
  userId: string;
  expiresAt?: number;
  expiryTimer?: unknown;
}

function sessionText(value: string, maxLength?: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return maxLength === undefined ? normalized : normalized.slice(0, maxLength);
}

function formatArchiverBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatArchiverTool(name: string, input: Record<string, unknown>): string {
  const params = Object.entries(input)
    .map(([key, value]) => {
      const rendered = typeof value === "string" ? value : JSON.stringify(value);
      return `${key}: ${sessionText(rendered ?? "")}`;
    })
    .join(", ");
  return `${name}${params ? `(${params})` : ""}`;
}

export interface RunArchiverTurnParams {
  /** Stringified user id (route layer hands us strings). */
  userId: string;
  /** Wiki-memory topic id. Derived topics pass their root memory origin here. */
  topicId?: string;
  /** Human-readable topic title — becomes the wiki `topic` name. */
  topicTitle: string;
  /** Absolute path to the JSONL archive produced by `archiveTopicMessages`. */
  archivePath: string;
  /** Full provider-neutral event streams preserved before topic deletion. */
  rawArchivePaths?: string[];
  /** Number of messages in the archive — gates the MIN threshold. */
  messageCount: number;
  /** Deleted topics update the #General memory hub; active idle snapshots do not. */
  mode?: "deleted-topic" | "active-topic";
  /** Override the archiver agent backend (default: maestro). */
  agent?: AgentKind;
  /** Override the archiver model (default: the prompt's frontmatter model). */
  model?: string;
  /** Called once when an accepted background turn settles. */
  onSettled?: (success: boolean) => void;
}

interface GeneralArchiverReply {
  text: string;
  agent: AgentKind;
  model?: string;
  usage?: { input: number; output: number };
}

export interface ArchiverStorageHost {
  getWikiDir(): string;
  fileExists(path: string): boolean;
  listDirectory(path: string): string[];
  readTextFile(path: string): string;
  fileSize(path: string): number;
  fileModifiedAt(path: string): number;
  getGeneralTopicId(userId: string): string;
  getTopicBrief(topicId: string): { briefMd: string } | null;
  setTopicBrief(
    topicId: string,
    fields: { briefMd: string; latestSummaryMd?: string; summaryDate?: string },
  ): void;
}

export interface ArchiverMessagingHost {
  appendMessage(message: MessageDto): void;
  broadcastMessage(topicId: string, message: MessageDto): void;
}

export interface ArchiverConfigHost {
  readonly workspaceDir: string;
  readonly completedSessionRetentionMs: number;
  loadAgentDefinition(): AgentDef;
  sanitizeTopicName(topicTitle: string): string;
  createId(): string;
  now(): Date;
  schedule(callback: () => void, delayMs: number): unknown;
  cancelScheduled(handle: unknown): void;
  unrefScheduled?(handle: unknown): void;
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ArchiverAgentRuntimeHost {
  run(options: AgentQueryOptions): AsyncIterable<UnifiedEvent>;
}

export interface ArchiverHost {
  storage: ArchiverStorageHost;
  messaging: ArchiverMessagingHost;
  config: ArchiverConfigHost;
  agentRuntime: ArchiverAgentRuntimeHost;
}

export interface ArchiverRuntime {
  runArchiverTurn(params: RunArchiverTurnParams): boolean;
  listActiveMemoryArchiverSessions(userId: string): BackgroundSessionDto[];
}

export function createArchiverRuntime(host: ArchiverHost): ArchiverRuntime {
  const activeSessions = new Map<string, ActiveArchiverSession>();
  let archiverDef: AgentDef | null = null;

  const updateSession = (id: string, status: string, step?: string): void => {
    const session = activeSessions.get(id);
    if (!session) return;
    session.status = sessionText(status, 160) || session.status;
    if (step) {
      const text = sessionText(step);
      if (text && session.steps.at(-1) !== text) {
        session.steps.push(text);
      }
    }
  };

  const listSessions = (userId: string): BackgroundSessionDto[] => {
    const now = host.config.now().getTime();
    for (const [id, session] of activeSessions) {
      if (session.expiresAt !== undefined && session.expiresAt <= now) {
        if (session.expiryTimer !== undefined) {
          host.config.cancelScheduled(session.expiryTimer);
        }
        activeSessions.delete(id);
      }
    }
    return [...activeSessions.values()]
      .filter((session) => session.userId === userId)
      .map(({ userId: _userId, expiresAt: _expiresAt, expiryTimer: _expiryTimer, ...session }) => ({
        ...session,
        steps: [...session.steps],
      }));
  };

  const getAgentDefinition = (): AgentDef => {
    archiverDef ??= host.config.loadAgentDefinition();
    return archiverDef;
  };

  /**
   * Fire a background wiki-archiver turn for a deleted topic or active idle
   * snapshot.
   *
   * Reads the forensic archive file produced by `archiveTopicMessages` and
   * distils it into the **shared** wiki (summaries / articles / topic brief /
   * indexes / skills) via the wiki MCP, which the turn launches in topic-id mode
   * so its writes land in the same root normal forum turns query.
   *
   * Fire-and-forget: the async generator is drained on a detached promise so the
   * caller's HTTP response returns immediately. Every failure is best-effort and
   * logged only — a broken archiver must never block or fail a topic deletion.
   */
  const runTurn = (params: RunArchiverTurnParams): boolean => {
    const {
      userId,
      topicId,
      topicTitle,
      archivePath,
      rawArchivePaths = [],
      messageCount,
      mode = "deleted-topic",
    } = params;

    let definition: AgentDef;
    try {
      definition = getAgentDefinition();
    } catch (err) {
      host.config.warn({ err }, "archiver: failed to load wiki-archiver.md — skipping");
      return false;
    }

    const wikiDir = host.storage.getWikiDir();
    const safeTopic = host.config.sanitizeTopicName(topicTitle);
    // Keep the established Claude default for archive quality and compatibility.
    // Every provider now receives the same host-resolved wiki MCP; callers may
    // override both agent and model as a matching pair when desired.
    const agent: AgentKind = params.agent ?? "claude";
    const model = params.model;

    const prompt =
      mode === "active-topic"
        ? [
            `세션 "${topicTitle}" 의 최근 idle 대화 snapshot입니다. 아래 아카이브에서 기억을 추출해 이 토픽 위키에 저장해줘.`,
            `archive_path: ${archivePath}`,
            ...rawArchivePaths.map((path) => `raw_archive_path: ${path}`),
            `wiki_dir: ${wikiDir}`,
          ].join("\n")
        : [
            `세션 "${topicTitle}" 이(가) 삭제되었습니다. 아래 아카이브에서 기억을 추출해 위키에 저장해줘.`,
            `archive_path: ${archivePath}`,
            ...rawArchivePaths.map((path) => `raw_archive_path: ${path}`),
            `wiki_dir: ${wikiDir}`,
            "",
            "#General에 표시될 짧은 한국어 완료 메시지로 최종 응답해줘. " +
              "도구 호출 로그나 원문 전문은 쓰지 말고, 저장한 요약/브리프/문서만 간단히 말해줘.",
          ].join("\n");

    // cwd = workspace root so the archiver's relative `wiki/...` Glob/Read paths
    // resolve against the same shared wiki the MCP writes to.
    const abortController = new AbortController();
    const events = host.agentRuntime.run({
      agent,
      prompt,
      cwd: host.config.workspaceDir,
      systemPrompt: definition.prompt,
      userId,
      // Throwaway session name → wiki MCP runs in topic-id (shared-root) mode.
      session: `__archiver_${safeTopic}`,
      sessionType: "forum",
      topicId,
      abortController,
      model,
      // Limit MCP surface to the wiki server (no playwright/bg-bash/etc.).
      mcpEnabled: ["wiki"],
      // Hidden run: don't record to the cross-agent conversation log.
      silent: true,
    });

    const activeSessionId = `memory:${host.config.createId()}`;
    let archiveBytes = 0;
    try {
      archiveBytes = host.storage.fileSize(archivePath);
    } catch {
      // The provider will report the actionable read failure.
    }
    activeSessions.set(activeSessionId, {
      id: activeSessionId,
      kind: "memory",
      title: `Archive ${topicTitle}`,
      topicId,
      userId,
      startedAt: host.config.now().toISOString(),
      status: "Starting",
      active: true,
      agent,
      model: model ?? definition.model,
      prompt,
      promptTitle: "Prompt",
      steps: [
        `Archive prepared · ${messageCount.toLocaleString()} messages · ${formatArchiverBytes(archiveBytes)}`,
      ],
    });

    host.config.info(
      { userId, topicTitle, archivePath, agent, model },
      "archiver: starting background turn",
    );

    // Baseline for locating the summary file the turn is about to write (fallback
    // when the predicted filename misses). Stamped before draining.
    const startMs = host.config.now().getTime();

    void (async () => {
      let ok = false;
      let sawDelta = false;
      let accumulatedText = "";
      let resultText = "";
      let finalText = "";
      let errorText = "";
      let usage: GeneralArchiverReply["usage"] | undefined;
      try {
        // Drain the stream — the turn's side effects (wiki writes) are the point;
        // only the final assistant text is surfaced to #General for deleted topics.
        for await (const event of events) {
          switch (event.type) {
            case "session":
              updateSession(activeSessionId, "Running", "Provider session started");
              break;
            case "tool_use":
              updateSession(
                activeSessionId,
                `Running ${event.name}`,
                formatArchiverTool(event.name, event.input),
              );
              break;
            case "tool_progress":
              {
                const progress = `${event.toolName === "thinking" ? "Thinking" : event.toolName} · ${Math.max(0, Math.floor(event.elapsed))}s`;
                updateSession(activeSessionId, progress, progress);
              }
              break;
            case "reasoning":
              updateSession(activeSessionId, "Reasoning", `Reasoning: ${event.content}`);
              break;
            case "tool_use_summary":
              updateSession(activeSessionId, event.summary, event.summary);
              break;
            case "status":
              updateSession(activeSessionId, event.content, event.content);
              break;
            case "tool_result":
              updateSession(
                activeSessionId,
                event.isError ? "Tool failed" : "Processing tool result",
                event.isError
                  ? `Tool failed: ${sessionText(event.content) || "unknown error"}`
                  : `Tool result · ${formatArchiverBytes(event.metadata?.returnedBytes ?? Buffer.byteLength(event.content))}`,
              );
              break;
            case "text_delta":
              sawDelta = true;
              accumulatedText += event.content;
              break;
            case "text":
              if (!sawDelta) accumulatedText += event.content;
              break;
            case "result":
              updateSession(
                activeSessionId,
                "Finalizing memory",
                `Memory received · ${formatArchiverBytes(Buffer.byteLength(event.content))}${
                  event.usage
                    ? ` · ${event.usage.inputTokens.toLocaleString()} in / ${event.usage.outputTokens.toLocaleString()} out`
                    : ""
                }`,
              );
              resultText = event.content;
              usage = event.usage
                ? { input: event.usage.inputTokens, output: event.usage.outputTokens }
                : undefined;
              break;
            case "error":
              errorText = event.content;
              updateSession(
                activeSessionId,
                "Failed",
                `Memory archive failed: ${sessionText(event.content)}`,
              );
              break;
            default:
              break;
          }
        }
        ok = !errorText;
        host.config.info({ userId, topicTitle }, "archiver: background turn completed");
      } catch (err) {
        errorText = err instanceof Error ? err.message : String(err);
        updateSession(
          activeSessionId,
          "Failed",
          `Memory archive failed: ${sessionText(errorText)}`,
        );
        host.config.warn({ err, userId, topicTitle }, "archiver: background turn failed");
      } finally {
        finalText = (accumulatedText.trim() ? accumulatedText : resultText).trim();
        const completedSession = activeSessions.get(activeSessionId);
        if (completedSession) {
          if (finalText) completedSession.output = finalText;
          updateSession(
            activeSessionId,
            ok ? "Completed" : "Failed",
            ok
              ? `Memory archive completed · ${formatArchiverBytes(Buffer.byteLength(finalText))}`
              : `Memory archive failed: ${sessionText(errorText) || "unknown error"}`,
          );
          completedSession.active = false;
          completedSession.expiresAt =
            host.config.now().getTime() + host.config.completedSessionRetentionMs;
          completedSession.expiryTimer = host.config.schedule(() => {
            if (activeSessions.get(activeSessionId) === completedSession) {
              activeSessions.delete(activeSessionId);
            }
          }, host.config.completedSessionRetentionMs);
          host.config.unrefScheduled?.(completedSession.expiryTimer);
        }
        try {
          params.onSettled?.(ok);
        } catch (err) {
          host.config.warn({ err, userId, topicTitle }, "archiver: settlement callback failed");
        }
      }
      if (mode === "deleted-topic") {
        // Roll the deleted topic into the #General memory hub regardless of LLM
        // success — even a failed distillation should leave a digest breadcrumb.
        const text = finalText.trimEnd();
        finalizeGeneralMemory(
          host,
          userId,
          topicTitle,
          messageCount,
          startMs,
          ok,
          topicId,
          ok && text ? { text, agent, model, usage } : undefined,
        );
      }
    })();
    return true;
  };

  return Object.freeze({
    runArchiverTurn: runTurn,
    listActiveMemoryArchiverSessions: listSessions,
  });
}

// --- #General memory-hub digest ------------------------------------------

/** Pull the first non-heading, non-frontmatter line of a summary as a digest. */
function distillOneLine(summaryMd: string): string {
  const body = summaryMd.replace(/^---[\s\S]*?---\n?/, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line.replace(/^[-*]\s*/, "").slice(0, 160);
  }
  return "";
}

/**
 * Locate the summary the archiver turn just wrote. The wiki MCP's
 * `save_wiki_entry` writes `summaries/<date>-<slug>.md`, keyed by topic id
 * when one is available and by title for legacy/ephemeral fallback paths.
 */
function findSummaryFile(
  storage: ArchiverStorageHost,
  topicTitle: string,
  date: string,
  sinceMs: number,
  topicId?: string,
): string | null {
  const dir = join(storage.getWikiDir(), "summaries");
  if (!storage.fileExists(dir)) return null;

  const predicted = join(dir, wikiSummaryFilename(date, topicTitle, topicId));
  if (storage.fileExists(predicted)) return predicted;

  let best: { path: string; mtime: number } | null = null;
  for (const f of storage.listDirectory(dir)) {
    if (!f.endsWith(".md")) continue;
    const p = join(dir, f);
    try {
      const m = storage.fileModifiedAt(p);
      if (m >= sinceMs && (!best || m > best.mtime)) best = { path: p, mtime: m };
    } catch {
      /* skip unreadable */
    }
  }
  return best?.path ?? null;
}

/**
 * Update the #General brief with a rolling digest entry for the archived topic
 * and post the archiver completion reply. The brief feeds the General turn's
 * system prompt, so this is the channel that carries deleted-topic memory into
 * the user's private hub. Best-effort — never throws.
 */
function finalizeGeneralMemory(
  host: ArchiverHost,
  userId: string,
  topicTitle: string,
  messageCount: number,
  startMs: number,
  ok: boolean,
  topicId?: string,
  generalReply?: GeneralArchiverReply,
): void {
  const generalTopicId = host.storage.getGeneralTopicId(userId);
  const date = host.config.now().toISOString().slice(0, 10);
  try {
    const summaryPath = ok
      ? findSummaryFile(host.storage, topicTitle, date, startMs, topicId)
      : null;
    const summaryMd = summaryPath ? host.storage.readTextFile(summaryPath) : "";
    const oneLine = (summaryMd && distillOneLine(summaryMd)) || `${messageCount}개 메시지 아카이브`;

    // Rolling digest: dedupe same-title, prepend newest, cap at MAX_BRIEF_ENTRIES.
    const prev = host.storage.getTopicBrief(generalTopicId);
    const prevEntries = (prev?.briefMd ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "));
    const newEntry = `- **${topicTitle}** (${date}): ${oneLine}`;
    const rolled = [
      newEntry,
      ...prevEntries.filter((l) => !l.startsWith(`- **${topicTitle}** `)),
    ].slice(0, MAX_BRIEF_ENTRIES);
    const briefMd = `# 워크스페이스 메모리 허브\n\n삭제된 토픽에서 추출한 최근 기억 다이제스트입니다. 자세한 내용은 \`wiki_query\`로 조회하세요.\n\n## 최근 아카이브\n${rolled.join("\n")}`;

    host.storage.setTopicBrief(generalTopicId, {
      briefMd,
      ...(summaryMd ? { latestSummaryMd: summaryMd, summaryDate: date } : {}),
    });
    host.config.info(
      { topicTitle, summaryPath, entries: rolled.length },
      "archiver: updated #General memory hub brief",
    );
  } catch (err) {
    host.config.warn({ err, topicTitle }, "archiver: failed to update #General brief");
  }

  // (a) Visible completion message in #General so participants see the hub absorbed the topic.
  // Prefer the archiver's own final chat response; fall back to a terse system
  // message if the run failed or produced no visible assistant text.
  try {
    const replyText = generalReply?.text.trim();
    const text =
      replyText ||
      (ok
        ? `🗂 "${topicTitle}" 토픽이 삭제되어 #General 메모리에 아카이브됐어요.`
        : `🗂 "${topicTitle}" 토픽을 아카이브했어요 (요약 추출은 실패 — 원본은 wiki/archive에 보존).`);
    const replyMeta =
      generalReply && replyText
        ? {
            authorId: "ai",
            agentType: generalReply.agent,
            model: generalReply.model,
            usage: generalReply.usage,
          }
        : { authorId: "system" };
    const msg = {
      id: host.config.createId(),
      topicId: generalTopicId,
      text,
      ...replyMeta,
      createdAt: host.config.now().toISOString(),
    };
    host.messaging.appendMessage(msg);
    host.messaging.broadcastMessage(generalTopicId, msg);
  } catch (err) {
    host.config.warn({ err, topicTitle }, "archiver: failed to post #General notification");
  }
}

const defaultArchiverRuntime = createArchiverRuntime({
  storage: {
    getWikiDir: getSharedWikiDir,
    fileExists: existsSync,
    listDirectory: readdirSync,
    readTextFile: (path) => readFileSync(path, "utf-8"),
    fileSize: (path) => statSync(path).size,
    fileModifiedAt: (path) => statSync(path).mtimeMs,
    getGeneralTopicId: (userId) => ensurePersonalGeneral(userId).id,
    getTopicBrief,
    setTopicBrief: (topicId, fields) => {
      setTopicBrief(topicId, fields);
    },
  },
  messaging: {
    appendMessage: appendApiMessage,
    broadcastMessage: (topicId, message) => {
      WsHub.get().broadcastMessage(topicId, message);
    },
  },
  config: {
    workspaceDir: WORKSPACE_DIR,
    completedSessionRetentionMs: COMPLETED_BACKGROUND_SESSION_RETENTION_MS,
    loadAgentDefinition: () => loadAgentPrompt("wiki-archiver.md"),
    sanitizeTopicName: (topicTitle) => sanitizeTopicName(topicTitle, true),
    createId: randomUUID,
    now: () => new Date(),
    schedule: (callback, delayMs) => setTimeout(callback, delayMs),
    cancelScheduled: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    unrefScheduled: (handle) => {
      (handle as ReturnType<typeof setTimeout>).unref?.();
    },
    info: (context, message) => logger.info(context, message),
    warn: (context, message) => logger.warn(context, message),
  },
  agentRuntime: {
    run: runAgent,
  },
});

export function runArchiverTurn(params: RunArchiverTurnParams): boolean {
  return defaultArchiverRuntime.runArchiverTurn(params);
}

export function listActiveMemoryArchiverSessions(userId: string): BackgroundSessionDto[] {
  return defaultArchiverRuntime.listActiveMemoryArchiverSessions(userId);
}
