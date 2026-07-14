import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "#agents/index";
import { WsHub } from "#bus";
import { WORKSPACE_DIR } from "#platform/config";
import { logger } from "#platform/logger";
import { type AgentDef, loadAgentPrompt } from "#prompts/builders";
import { sanitizeTopicName } from "#security/sanitize";
import { appendApiMessage } from "#storage/api-messages";
import { getTopicBrief, setTopicBrief } from "#storage/api-topic-brief";
import { getSharedWikiDir } from "#storage/wiki";
import { wikiSummaryFilename } from "#storage/wiki-summary-names";
import { ensurePersonalGeneral } from "#topics/personal-general";
import type { AgentKind } from "#types";

/**
 * Rolling cap on the #General digest. The General-brief injection embeds
 * `briefMd` whole (no slice), so an unbounded digest would inflate every
 * General turn's system prompt — keep it to the most recent N topics (~<2KB).
 */
const MAX_BRIEF_ENTRIES = 8;

/**
 * Below this message count a session has no extractable substance worth a full
 * archiver turn (greetings, a single quick question). Mirrors Otium's
 * `MIN_EXCHANGE_COUNT` gate.
 */
const MIN_ARCHIVE_MESSAGES = 4;

// The wiki-archiver prompt is loaded once and cached — a missing/!malformed
// file must not crash the delete path, so loading is wrapped at call sites.
let _archiverDef: AgentDef | null = null;
function getArchiverDef(): AgentDef {
  if (!_archiverDef) _archiverDef = loadAgentPrompt("wiki-archiver.md");
  return _archiverDef;
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
  /** Number of messages in the archive — gates the MIN threshold. */
  messageCount: number;
  /** Deleted topics update the #General memory hub; active idle snapshots do not. */
  mode?: "deleted-topic" | "active-topic";
  /** Override the archiver agent backend (default: maestro). */
  agent?: AgentKind;
  /** Override the archiver model (default: the prompt's frontmatter model). */
  model?: string;
}

interface GeneralArchiverReply {
  text: string;
  agent: AgentKind;
  model?: string;
  usage?: { input: number; output: number };
}

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
export function runArchiverTurn(params: RunArchiverTurnParams): void {
  const { userId, topicId, topicTitle, archivePath, messageCount, mode = "deleted-topic" } = params;

  if (messageCount < MIN_ARCHIVE_MESSAGES) {
    logger.info(
      { userId, topicTitle, messageCount, min: MIN_ARCHIVE_MESSAGES },
      "archiver: skipped — too few messages to distil",
    );
    return;
  }

  let archiverDef: AgentDef;
  try {
    archiverDef = getArchiverDef();
  } catch (err) {
    logger.warn({ err }, "archiver: failed to load wiki-archiver.md — skipping");
    return;
  }

  const wikiDir = getSharedWikiDir();
  const safeTopic = sanitizeTopicName(topicTitle, true);
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
          `wiki_dir: ${wikiDir}`,
        ].join("\n")
      : [
          `세션 "${topicTitle}" 이(가) 삭제되었습니다. 아래 아카이브에서 기억을 추출해 위키에 저장해줘.`,
          `archive_path: ${archivePath}`,
          `wiki_dir: ${wikiDir}`,
          "",
          "#General에 표시될 짧은 한국어 완료 메시지로 최종 응답해줘. " +
            "도구 호출 로그나 원문 전문은 쓰지 말고, 저장한 요약/브리프/문서만 간단히 말해줘.",
        ].join("\n");

  // cwd = workspace root so the archiver's relative `wiki/...` Glob/Read paths
  // resolve against the same shared wiki the MCP writes to.
  const abortController = new AbortController();
  const events = runAgent({
    agent,
    prompt,
    cwd: WORKSPACE_DIR,
    systemPrompt: archiverDef.prompt,
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

  logger.info(
    { userId, topicTitle, archivePath, agent, model },
    "archiver: starting background turn",
  );

  // Baseline for locating the summary file the turn is about to write (fallback
  // when the predicted filename misses). Stamped before draining.
  const startMs = Date.now();

  void (async () => {
    let ok = false;
    let sawDelta = false;
    let accumulatedText = "";
    let resultText = "";
    let usage: GeneralArchiverReply["usage"] | undefined;
    try {
      // Drain the stream — the turn's side effects (wiki writes) are the point;
      // only the final assistant text is surfaced to #General for deleted topics.
      for await (const event of events) {
        switch (event.type) {
          case "text_delta":
            sawDelta = true;
            accumulatedText += event.content;
            break;
          case "text":
            if (!sawDelta) accumulatedText += event.content;
            break;
          case "result":
            resultText = event.content;
            usage = event.usage
              ? { input: event.usage.inputTokens, output: event.usage.outputTokens }
              : undefined;
            break;
          default:
            break;
        }
      }
      ok = true;
      logger.info({ userId, topicTitle }, "archiver: background turn completed");
    } catch (err) {
      logger.warn({ err, userId, topicTitle }, "archiver: background turn failed");
    }
    if (mode === "deleted-topic") {
      // Roll the deleted topic into the #General memory hub regardless of LLM
      // success — even a failed distillation should leave a digest breadcrumb.
      const text = (accumulatedText.trim() ? accumulatedText : resultText).trimEnd();
      finalizeGeneralMemory(
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
  topicTitle: string,
  date: string,
  sinceMs: number,
  topicId?: string,
): string | null {
  const dir = join(getSharedWikiDir(), "summaries");
  if (!existsSync(dir)) return null;

  const predicted = join(dir, wikiSummaryFilename(date, topicTitle, topicId));
  if (existsSync(predicted)) return predicted;

  let best: { path: string; mtime: number } | null = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const p = join(dir, f);
    try {
      const m = statSync(p).mtimeMs;
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
  userId: string,
  topicTitle: string,
  messageCount: number,
  startMs: number,
  ok: boolean,
  topicId?: string,
  generalReply?: GeneralArchiverReply,
): void {
  const generalTopicId = ensurePersonalGeneral(userId).id;
  const date = new Date().toISOString().slice(0, 10);
  try {
    const summaryPath = ok ? findSummaryFile(topicTitle, date, startMs, topicId) : null;
    const summaryMd = summaryPath ? readFileSync(summaryPath, "utf-8") : "";
    const oneLine = (summaryMd && distillOneLine(summaryMd)) || `${messageCount}개 메시지 아카이브`;

    // Rolling digest: dedupe same-title, prepend newest, cap at MAX_BRIEF_ENTRIES.
    const prev = getTopicBrief(generalTopicId);
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

    setTopicBrief(generalTopicId, {
      briefMd,
      ...(summaryMd ? { latestSummaryMd: summaryMd, summaryDate: date } : {}),
    });
    logger.info(
      { topicTitle, summaryPath, entries: rolled.length },
      "archiver: updated #General memory hub brief",
    );
  } catch (err) {
    logger.warn({ err, topicTitle }, "archiver: failed to update #General brief");
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
      id: randomUUID(),
      topicId: generalTopicId,
      text,
      ...replyMeta,
      createdAt: new Date().toISOString(),
    };
    appendApiMessage(msg);
    WsHub.get().broadcastMessage(generalTopicId, msg);
  } catch (err) {
    logger.warn({ err, topicTitle }, "archiver: failed to post #General notification");
  }
}
