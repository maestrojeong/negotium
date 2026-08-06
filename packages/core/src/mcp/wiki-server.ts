#!/usr/bin/env bun

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { SHARED_WIKI_DIR } from "#platform/config";
import {
  wikiBriefStorageKey,
  wikiSummaryFilename,
  wikiSummarySlug,
} from "#storage/wiki-summary-names";

// --- CLI parsing -----------------------------------------------------------

export type WikiSurface = "all" | "wiki" | "skills";

export interface WikiTopicBrief {
  briefMd: string;
  latestSummaryMd?: string;
  summaryDate?: string;
  updatedAt: string;
}

export interface WikiMcpHost {
  wikiRoot: string;
  canReadTopicMemory?(selection: string, userId: string): boolean;
  getTopicBrief?(topicId: string): WikiTopicBrief | null;
  resolveTopicBrief?(selection: string, userId: string): WikiTopicBrief | null;
  setTopicBrief?(
    topicId: string,
    fields: {
      briefMd?: string;
      latestSummaryMd?: string;
      summaryDate?: string;
    },
  ): void;
  adoptTopicMemory?(topicId: string, userId: string, memoryKey: string): boolean;
}

export interface WikiMcpContext {
  userId: string;
  /** The room executing the tool, even when topicId points at inherited memory. */
  currentTopicId?: string;
  topicId?: string;
  surface?: WikiSurface;
}

interface WikiMemoryTopic {
  id: string;
  title: string;
  visibility?: string;
  participants: Array<{ userId: string }>;
}

export function resolveAccessibleWikiTopicBrief(
  selection: string,
  userId: string,
  topics: WikiMemoryTopic[],
  resolveBrief: (topicId: string, legacyTitle: string) => { brief: WikiTopicBrief } | null,
): WikiTopicBrief | null {
  const normalized = selection.trim().toLowerCase();
  const accessible = topics.filter(
    (topic) =>
      topic.visibility !== "hidden" &&
      topic.participants.some((participant) => participant.userId === userId),
  );
  const idMatch = accessible.find((topic) => topic.id === selection);
  if (idMatch) return resolveBrief(idMatch.id, idMatch.title)?.brief ?? null;
  const matches = accessible.filter((topic) => topic.title.trim().toLowerCase() === normalized);
  if (matches.length === 0) return null;
  const topic = matches[0]!;
  return resolveBrief(topic.id, topic.title)?.brief ?? null;
}

interface WikiRuntime extends Required<Pick<WikiMcpContext, "userId" | "surface">> {
  currentTopicId?: string;
  topicId?: string;
  host: WikiMcpHost;
  wikiDir: string;
  skillsDir: string;
  topicsDir: string;
  summariesDir: string;
  articlesDir: string;
  archiveDir: string;
}

const wikiRuntime = new AsyncLocalStorage<WikiRuntime>();

function runtime(): WikiRuntime {
  const current = wikiRuntime.getStore();
  if (!current) throw new Error("wiki MCP handler called without a runtime context");
  return current;
}

function parseArgv(): {
  userId: string;
  currentTopicId?: string;
  topicId?: string;
  surface: WikiSurface;
} {
  let userId = "local";
  let currentTopicId: string | undefined;
  let topicId: string | undefined;
  let surface: WikiSurface = "all";

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--user-id=")) userId = a.slice("--user-id=".length);
    else if (a.startsWith("--current-topic-id=")) {
      currentTopicId = a.slice("--current-topic-id=".length);
    } else if (a.startsWith("--topic-id=")) topicId = a.slice("--topic-id=".length);
    else if (a === "--surface=wiki") surface = "wiki";
    else if (a === "--surface=skills") surface = "skills";
  }

  return { userId, currentTopicId, topicId, surface };
}

// --- Helpers ---------------------------------------------------------------

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

const FILE_LOCK_WAIT_MS = 10;
const FILE_LOCK_TIMEOUT_MS = 5_000;
const FILE_LOCK_STALE_MS = 30_000;
const lockWaitArray = new Int32Array(new SharedArrayBuffer(4));

function acquireRecoveryGuard(lockPath: string): () => void {
  const guardPath = `${lockPath}.reclaim`;
  const ownerToken = randomUUID();
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = openSync(guardPath, "wx");
      try {
        writeFileSync(fd, ownerToken, "utf-8");
      } catch (error) {
        closeSync(fd);
        try {
          unlinkSync(guardPath);
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      }
      return () => {
        closeSync(fd);
        try {
          if (readFileSync(guardPath, "utf-8") === ownerToken) unlinkSync(guardPath);
        } catch {
          // The guard is already gone.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for wiki lock recovery guard: ${basename(lockPath)}`);
      }
      Atomics.wait(lockWaitArray, 0, 0, FILE_LOCK_WAIT_MS);
    }
  }
}

function acquireFileLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const ownerToken = randomUUID();
  const deadline = Date.now() + FILE_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, ownerToken, "utf-8");
      } catch (error) {
        closeSync(fd);
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the original write failure.
        }
        throw error;
      }
      return () => {
        closeSync(fd);
        const releaseGuard = acquireRecoveryGuard(lockPath);
        try {
          if (readFileSync(lockPath, "utf-8") === ownerToken) unlinkSync(lockPath);
        } catch {
          // A stale-lock recovery may already have replaced it.
        } finally {
          releaseGuard();
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const releaseGuard = acquireRecoveryGuard(lockPath);
      try {
        try {
          const staleToken = readFileSync(lockPath, "utf-8");
          if (
            Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS &&
            readFileSync(lockPath, "utf-8") === staleToken
          ) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          continue;
        }
      } finally {
        releaseGuard();
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for wiki file lock: ${basename(path)}`);
      }
      Atomics.wait(lockWaitArray, 0, 0, FILE_LOCK_WAIT_MS);
    }
  }
}

function atomicWriteFile(path: string, content: string): void {
  const temporaryPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(temporaryPath, content, "utf-8");
  try {
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}

function safeExt<T, K extends string = string>(
  obj: Record<string, unknown> | undefined | null,
  keys: readonly K[],
  fallback: T,
): T {
  if (!obj || typeof obj !== "object") return fallback;
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value as T;
  }
  return fallback;
}

function topicNameFrom(topicIdStr: string): string {
  return topicIdStr;
}

function slugify(topic: string): string {
  return wikiSummarySlug(topic);
}

// --- Tool handlers (file-based) -------------------------------------------

type WikiQueryKind = "all" | "topic" | "article" | "summary";

interface WikiIndexCandidate {
  kind: Exclude<WikiQueryKind, "all">;
  key: string;
  description: string;
  date?: string;
}

type WikiSearchResultKind = Exclude<WikiQueryKind, "all"> | "skill";

interface WikiSearchResult {
  kind: WikiSearchResultKind;
  key: string;
  score: number;
  keyScore: number;
  description?: string;
  date?: string;
  path?: string;
  text?: string;
  title?: string;
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9가-힣]+/g, " ")
    .trim()
    .replaceAll(/\s+/g, " ");
}

function compactSearchText(value: string): string {
  return normalizeSearchText(value).replaceAll(" ", "");
}

function trigrams(value: string): Set<string> {
  const compact = compactSearchText(value);
  if (compact.length < 3) return new Set(compact ? [compact] : []);
  const result = new Set<string>();
  for (let i = 0; i <= compact.length - 3; i += 1) result.add(compact.slice(i, i + 3));
  return result;
}

function fuzzySearchScore(query: string, candidate: string, maximum: number): number {
  const compactQuery = compactSearchText(query);
  const compactCandidate = compactSearchText(candidate);
  if (compactQuery.length < 3 || compactCandidate.length < 3) return 0;
  const similarity = trigramSimilarity(compactQuery, compactCandidate);
  const minimumSimilarity = compactQuery.length <= 4 ? 0.6 : 0.45;
  return similarity >= minimumSimilarity ? similarity * maximum : 0;
}

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "with",
]);

const SEARCH_MONTHS = new Map([
  ["january", "01"],
  ["jan", "01"],
  ["1월", "01"],
  ["february", "02"],
  ["feb", "02"],
  ["2월", "02"],
  ["march", "03"],
  ["mar", "03"],
  ["3월", "03"],
  ["april", "04"],
  ["apr", "04"],
  ["4월", "04"],
  ["may", "05"],
  ["5월", "05"],
  ["june", "06"],
  ["jun", "06"],
  ["6월", "06"],
  ["july", "07"],
  ["jul", "07"],
  ["7월", "07"],
  ["august", "08"],
  ["aug", "08"],
  ["8월", "08"],
  ["september", "09"],
  ["sep", "09"],
  ["sept", "09"],
  ["9월", "09"],
  ["october", "10"],
  ["oct", "10"],
  ["10월", "10"],
  ["november", "11"],
  ["nov", "11"],
  ["11월", "11"],
  ["december", "12"],
  ["dec", "12"],
  ["12월", "12"],
]);

const SEARCH_RECENCY_TERMS = new Set([
  "latest",
  "newest",
  "recent",
  "earliest",
  "oldest",
  "최근",
  "최신",
  "최초",
  "오래된",
]);

function meaningfulSearchTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => (token.length >= 2 || /^\d+$/.test(token)) && !SEARCH_STOP_WORDS.has(token));
}

function canonicalSearchToken(token: string): string {
  return token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}

function canonicalSearchTokens(value: string): string[] {
  return meaningfulSearchTokens(value).map(canonicalSearchToken);
}

function countToken(tokens: string[], token: string): number {
  let count = 0;
  for (const candidate of tokens) if (candidate === token) count += 1;
  return count;
}

function countPhrase(text: string, phrase: string): number {
  if (!phrase) return 0;
  let count = 0;
  let offset = 0;
  let match = text.indexOf(phrase, offset);
  while (match >= 0) {
    count += 1;
    offset = match + phrase.length;
    match = text.indexOf(phrase, offset);
  }
  return count;
}

function summaryTopicIdentity(key: string): string {
  return normalizeSearchText(key.replace(/^\d{4}-\d{2}-\d{2}-/, ""));
}

function scoreSummaryTime(query: string, key: string, title: string): number | null {
  const date = key.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!date) return 0;
  const tokens = meaningfulSearchTokens(query);
  const documentDate = `${date[1]}-${date[2]}-${date[3]}`;
  const requestedDateMatch = query.match(/\b(\d{4}) (\d{2}) (\d{2})\b/);
  const requestedDate = requestedDateMatch
    ? `${requestedDateMatch[1]}-${requestedDateMatch[2]}-${requestedDateMatch[3]}`
    : undefined;
  const beforeDate = /\bbefore\b/.test(query);
  const afterDate = /\bafter\b/.test(query);
  if (requestedDate && beforeDate && documentDate >= requestedDate) return null;
  if (requestedDate && afterDate && documentDate <= requestedDate) return null;
  const queryYear = tokens.find((token) => /^\d{4}(?:년)?$/.test(token))?.replace(/년$/, "");
  const queryMonth = tokens.map((token) => SEARCH_MONTHS.get(token)).find(Boolean);
  const hasRecencyTerm = tokens.some((token) => SEARCH_RECENCY_TERMS.has(token));
  const yearMatches = !queryYear || queryYear === date[1];
  const monthMatches = !queryMonth || queryMonth === date[2];
  if ((!queryYear && !queryMonth && !hasRecencyTerm) || !yearMatches || !monthMatches) return 0;

  const normalizedMetadata = `${normalizeSearchText(key)} ${normalizeSearchText(title)}`;
  const contentTokens = tokens.filter(
    (token) =>
      !/^\d{4}(?:년)?$/.test(token) &&
      !SEARCH_MONTHS.has(token) &&
      !SEARCH_RECENCY_TERMS.has(token),
  );
  const contentMatches = contentTokens.filter((token) => normalizedMetadata.includes(token)).length;
  const relationScore = requestedDate && (beforeDate || afterDate) ? 60 : 0;
  const exactDateScore = requestedDate === documentDate ? 90 : 0;
  return 30 + relationScore + exactDateScore + contentMatches * 15;
}

function trigramSimilarity(left: string, right: string): number {
  const a = trigrams(left);
  const b = trigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const gram of a) if (b.has(gram)) overlap += 1;
  return (2 * overlap) / (a.size + b.size);
}

function parseWikiIndex(path: string): WikiIndexCandidate[] {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const candidates: WikiIndexCandidate[] = [];
  const entryPattern = /^\s*-\s*\[\[(topic|articles|summaries)\/([^\]]+)\]\]\s*(.*)$/;
  for (const line of text.split("\n")) {
    const match = line.match(entryPattern);
    if (!match) continue;
    const namespace = match[1]!;
    const key = match[2]!.replace(/\.md$/i, "");
    const tail = match[3]!.trim();
    const dateMatch = tail.match(/\((\d{4}-\d{2}-\d{2})(?:[^)]*)\)\s*$/);
    const description = dateMatch ? tail.slice(0, dateMatch.index).trim() : tail;
    candidates.push({
      kind: namespace === "topic" ? "topic" : namespace === "articles" ? "article" : "summary",
      key,
      description,
      ...(dateMatch ? { date: dateMatch[1] } : {}),
    });
  }
  return candidates;
}

function indexCandidateExists(candidate: WikiIndexCandidate): boolean {
  // Topic indexes may point at canonical DB-backed memories rather than local files.
  if (candidate.kind === "topic") return true;
  const root = candidate.kind === "article" ? runtime().articlesDir : runtime().summariesDir;
  const filePath = resolve(root, `${candidate.key}.md`);
  const relativePath = relative(root, filePath);
  if (relativePath.startsWith("..") || relativePath.startsWith("/")) return false;
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function scoreIndexKey(query: string, key: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const compactQuery = compactSearchText(normalizedQuery);
  const normalizedKey = normalizeSearchText(key);
  const compactKey = compactSearchText(normalizedKey);
  const tokens = meaningfulSearchTokens(normalizedQuery);
  let score = 0;
  if (normalizedKey === normalizedQuery) score += 120;
  else if (compactKey === compactQuery) score += 110;
  else {
    if (
      compactQuery.length >= 2 &&
      (compactKey.startsWith(compactQuery) || compactQuery.startsWith(compactKey))
    ) {
      score += 65;
    }
    if (tokens.length > 0 && compactQuery.length >= 3 && compactKey.includes(compactQuery)) {
      score += 45;
    }
    score += fuzzySearchScore(compactQuery, compactKey, 55);
  }
  for (const token of tokens) {
    if (normalizedKey.includes(token)) score += 10;
  }
  return score;
}

function scoreIndexCandidate(query: string, candidate: WikiIndexCandidate): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;
  const normalizedDescription = normalizeSearchText(candidate.description);
  const tokens = canonicalSearchTokens(normalizedQuery);
  const descriptionTokens = new Set(canonicalSearchTokens(normalizedDescription));
  let score = scoreIndexKey(normalizedQuery, candidate.key);
  if (tokens.length > 0 && normalizedDescription.includes(normalizedQuery)) score += 30;
  let descriptionMatches = 0;
  for (const token of tokens) {
    if (descriptionTokens.has(token)) {
      score += 5;
      descriptionMatches += 1;
    }
  }
  if (tokens.length > 1 && descriptionMatches === tokens.length) score += 25;
  if (candidate.kind === "topic") {
    const requestsCurrent = /\b(?:current|active|ongoing|open)\b|현재|진행 중/.test(
      normalizedQuery,
    );
    const archivedCandidate = /\b(?:archive|archived|historical|closed)\b|보관|종료/.test(
      `${normalizeSearchText(candidate.key)} ${normalizedDescription}`,
    );
    if (requestsCurrent && archivedCandidate) score -= 40;
  }
  return score;
}

function wikiQuery(args: Record<string, unknown>): CallToolResult {
  const question = String(safeExt(args, ["question", "query", "q", "text"], "")).trim();
  const requestedKind = String(safeExt(args, ["kind", "type"], "all"));
  const kind: WikiQueryKind =
    requestedKind === "topic" || requestedKind === "article" || requestedKind === "summary"
      ? requestedKind
      : "all";
  const requestedLimit = Number(safeExt(args, ["limit", "maxResults"], 8));
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 8, 1), 20);
  if (!question) {
    return {
      content: [{ type: "text", text: "A non-empty wiki query is required." }],
      isError: true,
    };
  }
  const normalizedQuery = normalizeSearchText(question);
  if (!normalizedQuery) {
    return { content: [{ type: "text", text: "No matching wiki articles found." }] };
  }

  const canReadTopicMemory = runtime().host.canReadTopicMemory;
  const temporalDirection = /\b(?:latest|newest|recent)\b|최근|최신/.test(normalizedQuery)
    ? "newest"
    : /\b(?:earliest|oldest)\b|가장 오래된|최초/.test(normalizedQuery)
      ? "oldest"
      : undefined;

  const visibleIndexCandidates = [
    ...parseWikiIndex(resolve(runtime().wikiDir, "topic-index.md")),
    ...parseWikiIndex(resolve(runtime().wikiDir, "article-index.md")),
  ]
    .filter((candidate) => kind === "all" || candidate.kind === kind)
    .filter(
      (candidate) =>
        candidate.kind !== "topic" ||
        !canReadTopicMemory ||
        canReadTopicMemory(candidate.key, runtime().userId),
    );
  const hasStaleExactIndexMatch = visibleIndexCandidates.some(
    (candidate) =>
      !indexCandidateExists(candidate) && scoreIndexKey(question, candidate.key) >= 100,
  );
  const indexCandidates = visibleIndexCandidates
    .filter(indexCandidateExists)
    .map((candidate) => ({
      candidate,
      keyScore: scoreIndexKey(question, candidate.key),
      score: scoreIndexCandidate(question, candidate),
    }))
    .filter(({ keyScore, score }) => keyScore >= 25 || score >= 40)
    .sort(
      (left, right) =>
        right.score - left.score || left.candidate.key.localeCompare(right.candidate.key),
    );

  const strongestIndex = indexCandidates[0];
  if (
    kind === "topic" &&
    strongestIndex &&
    (strongestIndex.keyScore >= 25 || strongestIndex.score >= 40)
  ) {
    const runnerUp = indexCandidates[1];
    const ambiguous =
      strongestIndex.keyScore < 100 &&
      runnerUp !== undefined &&
      runnerUp.score >= strongestIndex.score * 0.9;
    if (ambiguous) {
      const lines = ["Found 2 ambiguous wiki candidates:", ""];
      for (const { candidate, score } of [strongestIndex, runnerUp]) {
        lines.push(
          `- kind: ${candidate.kind}`,
          `  key: ${candidate.key}`,
          `  score: ${score.toFixed(2)}`,
          `  description: ${candidate.description || "(none)"}`,
          ...(candidate.date ? [`  date: ${candidate.date}`] : []),
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
    const lines = ["Found 1 wiki candidate:", ""];
    for (const { candidate, score } of [strongestIndex]) {
      lines.push(
        `- kind: ${candidate.kind}`,
        `  key: ${candidate.key}`,
        `  score: ${score.toFixed(2)}`,
        `  description: ${candidate.description || "(none)"}`,
        ...(candidate.date ? [`  date: ${candidate.date}`] : []),
      );
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  const results: string[] = [];
  const scored: WikiSearchResult[] = [];

  function scan(dir: string, label: string): void {
    ensureDir(dir);
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          const sub = join(dir, entry.name);
          // Limit depth: only go one level deep for articles/skills
          if (label === "articles" || label === "skills") {
            try {
              for (const f of readdirSync(sub, { withFileTypes: true })) {
                if (!f.isFile() || !f.name.endsWith(".md")) continue;
                const fp = join(sub, f.name);
                try {
                  const text = readFileSync(fp, "utf-8");
                  const key = `${entry.name}/${f.name.replace(/\.md$/i, "")}`;
                  scored.push({
                    kind: label === "articles" ? "article" : "skill",
                    key,
                    keyScore: scoreIndexKey(question, key),
                    score: scoreMatch(text, key, label === "articles" ? "article" : "skill"),
                    path: `${label}/${entry.name}/${f.name}`,
                    text,
                    title: titleFromDocument(text, key),
                  });
                } catch {
                  /* skip unreadable */
                }
              }
            } catch {
              /* skip unreadable dir */
            }
          }
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          if (
            label === "topic" &&
            canReadTopicMemory &&
            !canReadTopicMemory(entry.name.replace(/\.md$/i, ""), runtime().userId)
          ) {
            continue;
          }
          const fp = join(dir, entry.name);
          try {
            const text = readFileSync(fp, "utf-8");
            const key = entry.name.replace(/\.md$/i, "");
            const resultKind =
              label === "articles"
                ? "article"
                : label === "topic"
                  ? "topic"
                  : label === "summaries"
                    ? "summary"
                    : "skill";
            scored.push({
              kind: resultKind,
              key,
              keyScore: scoreIndexKey(question, key),
              score: scoreMatch(text, key, resultKind),
              path: `${label}/${entry.name}`,
              text,
              title: titleFromDocument(text, key),
              ...(label === "summaries" && /^\d{4}-\d{2}-\d{2}/.test(key)
                ? { date: key.slice(0, 10) }
                : {}),
            });
          } catch {
            /* skip unreadable */
          }
        }
      }
    } catch {
      /* dir may not exist */
    }
  }

  function titleFromDocument(text: string, key: string): string {
    const titleLine = text.split("\n").find((line) => /^#+\s*/.test(line));
    return titleLine ? titleLine.replace(/^#+\s*/, "") : basename(key);
  }

  function scoreMatch(text: string, key: string, resultKind: WikiSearchResultKind): number {
    const titleLine = text.split("\n").find((line) => /^#+\s*/.test(line)) ?? "";
    const title = titleLine.replace(/^#+\s*/, "");
    const normalizedKey = normalizeSearchText(key);
    const normalizedTitle = normalizeSearchText(title);
    const normalizedBody = normalizeSearchText(text.replace(titleLine, ""));
    const compactQuery = compactSearchText(normalizedQuery);
    const compactKey = compactSearchText(normalizedKey);
    const compactTitle = compactSearchText(normalizedTitle);
    const tokens = canonicalSearchTokens(normalizedQuery);
    const keyTokens = new Set(canonicalSearchTokens(normalizedKey));
    const titleTokens = new Set(canonicalSearchTokens(normalizedTitle));
    const bodyTokens = canonicalSearchTokens(normalizedBody);
    let score = 0;
    let strongMetadataEvidence = false;

    if (normalizedKey === normalizedQuery) {
      score += 120;
      strongMetadataEvidence = true;
    } else if (compactKey === compactQuery) {
      score += 110;
      strongMetadataEvidence = true;
    } else if (
      compactQuery.length >= 2 &&
      (compactKey.startsWith(compactQuery) || compactQuery.startsWith(compactKey))
    ) {
      score += 65;
      strongMetadataEvidence = true;
    }
    if (tokens.length > 0 && compactQuery.length >= 3 && compactKey.includes(compactQuery)) {
      score += 45;
      strongMetadataEvidence = true;
    }
    const fuzzyKeyScore = fuzzySearchScore(compactQuery, compactKey, 55);
    score += fuzzyKeyScore;
    if (fuzzyKeyScore > 0) strongMetadataEvidence = true;

    if (normalizedTitle === normalizedQuery) {
      score += 115;
      strongMetadataEvidence = true;
    } else if (compactTitle === compactQuery) {
      score += 105;
      strongMetadataEvidence = true;
    } else if (compactQuery.length >= 2 && compactTitle.startsWith(compactQuery)) {
      score += 60;
      strongMetadataEvidence = true;
    }
    const fuzzyTitleScore = fuzzySearchScore(compactQuery, compactTitle, 50);
    score += fuzzyTitleScore;
    if (fuzzyTitleScore > 0) strongMetadataEvidence = true;
    if (resultKind === "summary") {
      const temporalScore = scoreSummaryTime(normalizedQuery, key, title);
      if (temporalScore === null) return 0;
      score += temporalScore;
      if (temporalScore > 0) strongMetadataEvidence = true;
    }

    const isMultiToken = tokens.length > 1;
    if (tokens.length > 0 && normalizedTitle.includes(normalizedQuery)) {
      score += 35;
      strongMetadataEvidence = true;
    }
    const phraseMatches = isMultiToken ? countPhrase(normalizedBody, normalizedQuery) : 0;
    if (phraseMatches > 0) score += phraseMatches * 12;
    else if (tokens.length === 1 && tokens[0]!.length >= 5 && normalizedBody.includes(tokens[0]!)) {
      score += 16;
    }

    let bodyMatches = 0;
    let minimumBodyFrequency = Number.POSITIVE_INFINITY;
    for (const token of tokens) {
      if (keyTokens.has(token)) score += 10;
      if (titleTokens.has(token)) score += 12;
      const bodyFrequency = countToken(bodyTokens, token);
      if (bodyFrequency > 0) {
        score += Math.min(bodyFrequency, 3) * 4;
        bodyMatches += 1;
        minimumBodyFrequency = Math.min(minimumBodyFrequency, bodyFrequency);
      }
    }
    if (isMultiToken && bodyMatches === tokens.length) {
      score += 8 * Math.min(minimumBodyFrequency, 3);
    }
    const minimumBodyTokens = hasStaleExactIndexMatch ? 3 : 2;
    const partialArticleEvidence =
      resultKind === "article" && bodyMatches >= 3 && bodyMatches / tokens.length >= 0.6;
    const strongBodyEvidence =
      tokens.length >= minimumBodyTokens &&
      ((bodyMatches === tokens.length && (phraseMatches > 0 || minimumBodyFrequency >= 1)) ||
        partialArticleEvidence);
    if (!strongMetadataEvidence && !strongBodyEvidence) return 0;
    return score;
  }

  if (kind === "all" || kind === "article") scan(runtime().articlesDir, "articles");
  // Skills are node-local runtime knowledge, not canonical workspace memory.
  // Keep the legacy all-in-one server compatible while ensuring the explicit
  // wiki surface cannot read a node's skill library.
  if (kind === "all" && runtime().surface === "all") scan(runtime().skillsDir, "skills");
  if (kind === "all" || kind === "topic") scan(runtime().topicsDir, "topic");
  if (kind === "all" || kind === "summary") scan(runtime().summariesDir, "summaries");

  const merged = new Map<string, WikiSearchResult>();
  for (const { candidate, keyScore, score } of indexCandidates) {
    merged.set(`${candidate.kind}:${candidate.key}`, {
      kind: candidate.kind,
      key: candidate.key,
      keyScore,
      score,
      description: candidate.description,
      date: candidate.date,
    });
  }
  const documentThreshold = kind === "topic" ? 24 : 16;
  for (const document of scored) {
    if (document.score < documentThreshold) continue;
    const id = `${document.kind}:${document.key}`;
    const indexed = merged.get(id);
    merged.set(
      id,
      indexed
        ? { ...indexed, ...document, score: Math.max(indexed.score, document.score) }
        : document,
    );
  }

  let ranked = [...merged.values()].sort(
    (left, right) =>
      right.score - left.score ||
      (left.kind === "summary" && right.kind === "summary"
        ? temporalDirection === "oldest"
          ? (left.date ?? "").localeCompare(right.date ?? "")
          : (right.date ?? "").localeCompare(left.date ?? "")
        : 0) ||
      left.key.localeCompare(right.key),
  );

  if (kind === "summary") {
    const sameTopic = ranked.filter((result) => {
      const identity = summaryTopicIdentity(result.key);
      return identity.length >= 3 && normalizedQuery.includes(identity);
    });
    if (sameTopic.length > 0) ranked = sameTopic;

    const requestedDateMatch = normalizedQuery.match(/\b(\d{4}) (\d{2}) (\d{2})\b/);
    const requestedDate = requestedDateMatch
      ? `${requestedDateMatch[1]}-${requestedDateMatch[2]}-${requestedDateMatch[3]}`
      : undefined;
    const beforeDate = /\bbefore\b/.test(normalizedQuery);
    const afterDate = /\bafter\b/.test(normalizedQuery);
    if (requestedDate && beforeDate) {
      ranked = ranked.filter((result) => !result.date || result.date < requestedDate);
    } else if (requestedDate && afterDate) {
      ranked = ranked.filter((result) => !result.date || result.date > requestedDate);
    }
    ranked.sort((left, right) => {
      if (beforeDate) {
        return (right.date ?? "").localeCompare(left.date ?? "") || right.score - left.score;
      }
      if (afterDate) {
        return (left.date ?? "").localeCompare(right.date ?? "") || right.score - left.score;
      }
      if (requestedDate) {
        const dateDifference =
          Number(right.date === requestedDate) - Number(left.date === requestedDate);
        if (dateDifference !== 0) return dateDifference;
      }
      if (temporalDirection) {
        const dateDifference =
          temporalDirection === "oldest"
            ? (left.date ?? "").localeCompare(right.date ?? "")
            : (right.date ?? "").localeCompare(left.date ?? "");
        if (dateDifference !== 0) return dateDifference;
      }
      return (
        right.score - left.score ||
        (right.date ?? "").localeCompare(left.date ?? "") ||
        left.key.localeCompare(right.key)
      );
    });
  }

  if (kind === "topic" && ranked[0]) {
    const runnerUp = ranked[1];
    const ambiguous =
      ranked[0].keyScore < 100 && runnerUp !== undefined && runnerUp.score >= ranked[0].score * 0.9;
    if (ambiguous) {
      ranked = ranked.slice(0, 2);
    } else {
      ranked = ranked.slice(0, 1);
    }
  } else {
    ranked = ranked.slice(0, limit);
  }

  if (ranked.length === 0) {
    results.push("No matching wiki articles found.");
  } else {
    results.push(`Found ${ranked.length} matching result(s):\n`);
    for (const result of ranked) {
      if (result.kind === "skill") {
        const body = (result.text ?? "").trim().slice(0, 400);
        results.push(
          `## ${result.title ?? result.key}\nPath: ${result.path}\n\n${body}${(result.text?.length ?? 0) > 400 ? "\n...(truncated)" : ""}\n`,
        );
        continue;
      }
      results.push(
        `- kind: ${result.kind}`,
        `  key: ${result.key}`,
        `  score: ${result.score.toFixed(2)}`,
        ...(result.title ? [`  title: ${result.title}`] : []),
        `  description: ${result.description || "(none)"}`,
        ...(result.date ? [`  date: ${result.date}`] : []),
        ...(result.path ? [`  path: ${result.path}`, `  Path: ${result.path}`] : []),
        ...(result.text
          ? [
              `  excerpt: ${result.text
                .replace(/^---[\s\S]*?---\n?/, "")
                .replace(/^#.*$/m, "")
                .trim()
                .slice(0, 400)}`,
            ]
          : []),
      );
    }
  }

  return { content: [{ type: "text", text: results.join("\n") }] };
}

function wikiTopicBrief(args: Record<string, unknown>): CallToolResult {
  const rawTopic = safeExt<string | undefined>(
    args,
    ["topic", "topicName", "topicId"],
    runtime().topicId,
  );
  if (!rawTopic) {
    return {
      content: [
        {
          type: "text",
          text: "No topic specified (provide --topic-id or topic arg).",
        },
      ],
    };
  }

  const { getTopicBrief, resolveTopicBrief } = runtime().host;
  const hasAuthorizedBridge = Boolean(runtime().topicId && (getTopicBrief || resolveTopicBrief));
  if (hasAuthorizedBridge) {
    try {
      const brief = resolveTopicBrief
        ? resolveTopicBrief(rawTopic, runtime().userId)
        : getTopicBrief!(rawTopic);
      if (brief) {
        const lines = [
          `# Topic Brief: ${topicNameFrom(rawTopic)}`,
          "",
          brief.briefMd || "(empty brief)",
        ];
        if (brief.latestSummaryMd) {
          lines.push("", "## Latest Summary", "", brief.latestSummaryMd);
        }
        if (brief.summaryDate) {
          lines.push("", `Summary date: ${brief.summaryDate}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }
    } catch {
      // The SQLite mirror is optional; fall through to the canonical file.
    }
    return {
      content: [{ type: "text", text: `No brief found for topic: ${rawTopic}` }],
    };
  }

  const topicKey = wikiSummarySlug(rawTopic.replace(/^topic\//, "").replace(/\.md$/i, ""));
  const filePath = resolve(runtime().topicsDir, `${topicKey}.md`);
  try {
    const content = readFileSync(filePath, "utf-8");
    return {
      content: [{ type: "text", text: `# Topic Brief: ${topicKey}\n\n${content}` }],
    };
  } catch {
    // Report the same not-found result for DB- and file-backed lookups.
  }
  return {
    content: [{ type: "text", text: `No brief found for topic: ${rawTopic}` }],
  };
}

function wikiRead(args: Record<string, unknown>): CallToolResult {
  const rawKind = String(safeExt(args, ["kind", "type"], "article"));
  const kind = rawKind === "topic" || rawKind === "summary" ? rawKind : "article";
  const rawKey = String(safeExt(args, ["key", "slug", "topic"], "")).trim();
  if (!rawKey) {
    return { content: [{ type: "text", text: "A wiki document key is required." }], isError: true };
  }

  if (kind === "topic") {
    const result = wikiTopicBrief({ topic: rawKey });
    const resultText = result.content
      .map((entry) => (entry.type === "text" ? entry.text : ""))
      .join("\n");
    const adopt = safeExt<boolean>(args, ["adopt", "use", "select"], false);
    if (!adopt || resultText.startsWith("No brief found for topic")) return result;

    const currentTopicId = runtime().currentTopicId;
    const memoryKey = wikiSummarySlug(rawKey.replace(/^topic\//, "").replace(/\.md$/i, ""));
    if (
      !currentTopicId ||
      !runtime().host.adoptTopicMemory?.(currentTopicId, runtime().userId, memoryKey)
    ) {
      return {
        content: [
          ...result.content,
          { type: "text", text: "\nMemory was read but could not be adopted by this topic." },
        ],
      };
    }
    return {
      content: [...result.content, { type: "text", text: `\nAdopted topic memory: ${memoryKey}` }],
    };
  }

  if (
    rawKey.includes("\\") ||
    rawKey.split("/").some((part) => part === "..") ||
    rawKey.startsWith("/")
  ) {
    return { content: [{ type: "text", text: "Invalid wiki document key." }], isError: true };
  }
  const root = kind === "summary" ? runtime().summariesDir : runtime().articlesDir;
  const key = rawKey
    .replace(new RegExp(`^(?:${kind === "summary" ? "summaries" : "articles"})/`), "")
    .replace(/\.md$/i, "");
  const filePath = resolve(root, `${key}.md`);
  const relativePath = relative(root, filePath);
  if (relativePath.startsWith("..") || relativePath.startsWith("/")) {
    return { content: [{ type: "text", text: "Invalid wiki document key." }], isError: true };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    return {
      content: [{ type: "text", text: `# Wiki ${kind}: ${key}\n\n${content}` }],
    };
  } catch {
    return { content: [{ type: "text", text: `No ${kind} found for: ${rawKey}` }] };
  }
}

function wikiLastConversation(args: Record<string, unknown>): CallToolResult {
  const rawTopic = safeExt<string | undefined>(
    args,
    ["topic", "topicName", "topicId"],
    runtime().topicId,
  );
  const turns = safeExt(args, ["turns", "limit", "n"], 5);
  const maxTurns = Math.min(Math.max(1, Number(turns) || 5), 10);

  if (!rawTopic) {
    return { content: [{ type: "text", text: "No topic specified." }] };
  }

  const name = slugify(topicNameFrom(rawTopic));

  // Try per-topic archive dir first, then flat file. This is a read path —
  // it must never create directories on lookup (that previously left an
  // empty `wiki/archive/<topic>/` behind for every topic name ever queried,
  // even when nothing was ever archived under the per-topic layout).
  const archiveDir = resolve(runtime().archiveDir, name);

  try {
    // List archive files sorted by name (which should be date-sorted)
    let files = existsSync(archiveDir)
      ? readdirSync(archiveDir)
          .filter((f) => f.endsWith(".jsonl"))
          .sort()
          .reverse()
      : [];
    if (files.length === 0) {
      // Try flat archive
      files = existsSync(runtime().archiveDir)
        ? readdirSync(runtime().archiveDir)
            .filter((f) => f.startsWith(name) && f.endsWith(".jsonl"))
            .sort()
            .reverse()
        : [];
    }
    if (files.length === 0) {
      return {
        content: [{ type: "text", text: `No archive found for topic: ${rawTopic}` }],
      };
    }

    // Read most recent archive file
    const actualPath = files[0].includes("/")
      ? files[0]
      : resolve(
          existsSync(archiveDir) && readdirSync(archiveDir).includes(files[0])
            ? archiveDir
            : runtime().archiveDir,
          files[0],
        );

    try {
      const raw = readFileSync(actualPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);

      // Reconstruct turns from UnifiedEvent JSONL: pair user_message with following text/result
      const turns: string[] = [];
      let currentUser = "";
      let currentAssistant = "";

      const truncate = (s: string, max: number) =>
        s.length > max ? `${s.slice(0, max)}\n...(truncated)` : s;

      const flush = () => {
        if (currentUser || currentAssistant) {
          turns.push(
            `**User**: ${truncate(currentUser || "(no prompt)", 500)}\n\n**Assistant**: ${truncate(currentAssistant || "(no response)", 1000)}`,
          );
          currentUser = "";
          currentAssistant = "";
        }
      };

      for (const line of lines) {
        try {
          // Archives are written by archiveTopicMessages → TopicArchiveTranscriptRecord:
          // { type: "message", role: "user"|"assistant"|"system", text: "..." }
          const record = JSON.parse(line) as {
            type: string;
            role?: string;
            text?: string;
          };
          if (record.type === "message" && record.role === "user") {
            flush();
            currentUser = record.text ?? "";
          } else if (record.type === "message" && record.role === "assistant") {
            currentAssistant += record.text ?? "";
          }
        } catch {
          // skip malformed lines
        }
      }
      flush();

      if (turns.length === 0) {
        return {
          content: [{ type: "text", text: `Archive file found but no valid entries.` }],
        };
      }

      const recent = turns.slice(-maxTurns);
      return {
        content: [
          {
            type: "text",
            text: `## Last ${recent.length} turns from "${rawTopic}" (${files[0]})\n\n${recent.join("\n\n---\n\n")}`,
          },
        ],
      };
    } catch {
      return {
        content: [{ type: "text", text: `Could not read archive for: ${rawTopic}` }],
      };
    }
  } catch {
    return {
      content: [{ type: "text", text: `No archive found for: ${rawTopic}` }],
    };
  }
}

function skillQuery(args: Record<string, unknown>): CallToolResult {
  const question = safeExt(args, ["question", "query", "q"], "");
  const query = question.toLowerCase();

  ensureDir(runtime().skillsDir);

  const matches: { name: string; path: string; desc: string }[] = [];

  try {
    for (const entry of readdirSync(runtime().skillsDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const skillFile = resolve(runtime().skillsDir, entry.name, "skill.md");
      try {
        const text = readFileSync(skillFile, "utf-8");
        const lower = text.toLowerCase();
        let score = 0;
        for (const w of query.split(/\s+/).filter(Boolean)) {
          if (lower.includes(w)) score += w.length >= 3 ? 3 : 1;
        }
        if (score > 0) {
          // Extract name/description from frontmatter
          const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
          let name = entry.name;
          let desc = "";
          if (fmMatch) {
            const fm = fmMatch[1];
            const nMatch = fm.match(/^name:\s*(.+)$/m);
            const dMatch = fm.match(/^description:\s*(.+)$/m);
            if (nMatch) name = nMatch[1].trim();
            if (dMatch) desc = dMatch[1].trim();
          }
          matches.push({ name, path: `skills/${entry.name}/skill.md`, desc });
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* dir may not exist */
  }

  if (matches.length === 0) {
    return { content: [{ type: "text", text: "No matching skills found." }] };
  }

  const lines = matches.map((m) => `- **${m.name}** (${m.path})${m.desc ? ` — ${m.desc}` : ""}`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

function skillSave(args: Record<string, unknown>): CallToolResult {
  const name = safeExt(args, ["name", "skill_name"], "");
  const content: string = safeExt(args, ["content", "text", "body"], "");

  if (!name) return { content: [{ type: "text", text: "Missing skill name." }] };
  if (!content) return { content: [{ type: "text", text: "Missing skill content." }] };

  function extractGotchas(md: string): string[] {
    // No `m` flag: `$` anchors to end-of-string so lazy [\s\S]*? isn't fooled
    // by mid-section newlines the way it would be in multiline mode.
    const m = md.match(/(?:^|\n)## Gotchas\s*\n([\s\S]*?)(?=\n## |$)/);
    if (!m) return [];
    return m[1].split("\n").filter((l) => l.trim().startsWith("-"));
  }

  function mergeGotchas(target: string, extra: string[]): string {
    const existing = new Set(extractGotchas(target).map((l) => l.toLowerCase()));
    const fresh = extra.filter((l) => !existing.has(l.toLowerCase()));
    if (fresh.length === 0) return target;
    const sectionMatch = target.match(/(?:^|\n)(## Gotchas\s*\n[\s\S]*?)(?=\n## |$)/);
    if (sectionMatch) {
      const block = sectionMatch[1];
      const insert = `${block.trimEnd()}\n${fresh.join("\n")}`;
      return target.replace(block, insert);
    }
    return `${target.trimEnd()}\n\n## Gotchas\n${fresh.join("\n")}\n`;
  }

  const skillDir = resolve(runtime().skillsDir, name);
  ensureDir(skillDir);
  const skillPath = resolve(skillDir, "skill.md");

  let finalContent = content;
  try {
    const existing = readFileSync(skillPath, "utf-8");
    finalContent = mergeGotchas(content, extractGotchas(existing));
  } catch {
    // new skill — no existing file to merge from
  }

  writeFileSync(skillPath, finalContent, "utf-8");

  return {
    content: [
      {
        type: "text",
        text: `Skill "${name}" saved at skills/${name}/skill.md`,
      },
    ],
  };
}

function saveWikiEntry(args: Record<string, unknown>): CallToolResult {
  const rawTopic = safeExt(args, ["topic", "topicName"], "");
  const content: string = safeExt(args, ["content", "text", "body"], "");

  if (!rawTopic) return { content: [{ type: "text", text: "Missing topic." }] };
  if (!content) return { content: [{ type: "text", text: "Missing content." }] };

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const topicId = runtime().topicId;
  const fileSlug = wikiBriefStorageKey(rawTopic, topicId);

  // Save to summaries directory
  ensureDir(runtime().summariesDir);
  const baseSummaryName = wikiSummaryFilename(dateStr, rawTopic, topicId);
  let summaryName = baseSummaryName;
  let counter = 1;
  while (true) {
    try {
      writeFileSync(resolve(runtime().summariesDir, summaryName), content, {
        encoding: "utf-8",
        flag: "wx",
      });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      counter += 1;
      summaryName = baseSummaryName.replace(/\.md$/, `~${counter}.md`);
    }
  }

  // Record the latest summary. The fresh brief is written authoritatively by
  // save_topic_brief (called after this step). We only backfill brief_md here so
  // a summary-only write — e.g. the no-substance path, which skips
  // save_topic_brief — can't create a title-key row with an empty brief_md that
  // shadows an existing brief (see resolveTopicBrief precedence). Backfill order:
  // an existing brief file, else a legacy id-keyed row migrated forward. We
  // never overwrite an existing title brief_md with empty.
  const setTopicBrief = runtime().host.setTopicBrief;
  const getTopicBrief = runtime().host.getTopicBrief;
  let sqliteUpdated = false;
  if (topicId && setTopicBrief) {
    try {
      const briefPath = resolve(runtime().topicsDir, `${fileSlug}.md`);
      let briefMd = existsSync(briefPath) ? readFileSync(briefPath, "utf-8") : undefined;
      if (briefMd === undefined && getTopicBrief && !getTopicBrief(fileSlug)?.briefMd) {
        // No brief file and no title-keyed brief yet: carry a legacy id-keyed
        // brief into the title row so this write cannot hide it.
        const legacy = getTopicBrief(topicId)?.briefMd;
        if (legacy) briefMd = legacy;
      }
      setTopicBrief(fileSlug, {
        latestSummaryMd: content,
        summaryDate: dateStr,
        ...(briefMd !== undefined ? { briefMd } : {}),
      });
      sqliteUpdated = true;
    } catch {
      // DB update failed — file save succeeded, not critical.
    }
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Saved summary: summaries/${summaryName}` +
          (sqliteUpdated ? "\nSQLite latest-summary also updated." : ""),
      },
    ],
  };
}

function saveTopicBrief(args: Record<string, unknown>): CallToolResult {
  const rawTopic = safeExt(args, ["topic", "topicName"], "");
  const content: string = safeExt(args, ["content", "brief", "text", "body"], "");

  if (!rawTopic) return { content: [{ type: "text", text: "Missing topic." }] };
  if (!content) return { content: [{ type: "text", text: "Missing content." }] };

  const topicId = runtime().topicId;
  const fileSlug = wikiBriefStorageKey(rawTopic, topicId);

  // Write the canonical accumulated persona brief file.
  const briefPath = resolve(runtime().topicsDir, `${fileSlug}.md`);
  ensureDir(dirname(briefPath));
  const existed = existsSync(briefPath);
  writeFileSync(briefPath, content, "utf-8");

  // Mirror the brief into SQLite so it is injected at the next session start.
  // Partial upsert: only brief_md is touched, leaving latest_summary_md and
  // summary_date (written by save_wiki_entry) intact.
  const setTopicBrief = runtime().host.setTopicBrief;
  let sqliteUpdated = false;
  if (topicId && setTopicBrief) {
    try {
      setTopicBrief(fileSlug, { briefMd: content });
      sqliteUpdated = true;
    } catch {
      // DB update failed — file save succeeded, not critical.
    }
  }

  return {
    content: [
      {
        type: "text",
        text:
          `Saved brief: topic/${fileSlug}.md (${existed ? "updated" : "created"})` +
          (sqliteUpdated ? "\nSQLite brief also updated." : ""),
      },
    ],
  };
}

function indexUpsert(args: Record<string, unknown>): CallToolResult {
  const slug = safeExt(args, ["slug", "id"], "");
  const desc = safeExt(args, ["description", "desc", "text"], "");
  const kind: string = safeExt(args, ["kind", "type"], "article");
  const section = safeExt<string | undefined>(args, ["section", "category"], undefined);
  const date = safeExt<string | undefined>(args, ["date", "created"], undefined);

  if (!slug) return { content: [{ type: "text", text: "Missing slug." }] };

  const today = new Date().toISOString().slice(0, 10);
  const dateStr = date ?? today;

  const indexPath = (() => {
    if (kind === "topic") return resolve(runtime().wikiDir, "topic-index.md");
    if (kind === "skill") return resolve(runtime().wikiDir, "skill-index.md");
    return resolve(runtime().wikiDir, "article-index.md");
  })();

  ensureDir(dirname(indexPath));
  const releaseLock = acquireFileLock(indexPath);

  try {
    let index: string;
    try {
      index = readFileSync(indexPath, "utf-8");
    } catch {
      index = "";
    }

    const lines = index.split("\n");
    const link = (() => {
      switch (kind) {
        case "summary":
          return `- [[summaries/${slug}]] ${desc} (${dateStr})`;
        case "topic":
          return `- [[topic/${slug}]] ${desc} (${dateStr})`;
        case "skill":
          return `- [[skills/${slug}]] ${desc} (${dateStr})`;
        default:
          return `- [[articles/${slug}]] ${desc} (${dateStr})`;
      }
    })();

    // Find every existing entry for this canonical target. Historical versions
    // appended duplicates because they searched for [[slug]] while writing
    // [[topic/slug]].
    const target = (() => {
      switch (kind) {
        case "summary":
          return `summaries/${slug}`;
        case "topic":
          return `topic/${slug}`;
        case "skill":
          return `skills/${slug}`;
        default:
          return `articles/${slug}`;
      }
    })();
    const slugPattern = `[[${target}]]`;
    let replaced = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(slugPattern)) {
        if (!replaced) {
          lines[i] = link;
          replaced = true;
        } else {
          lines.splice(i, 1);
        }
      }
    }

    if (!replaced) {
      // Append to appropriate section
      if (section) {
        let sectionIdx = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("## ") && lines[i].includes(section)) {
            sectionIdx = i;
            break;
          }
        }
        if (sectionIdx >= 0) {
          // Insert after section heading, before next section
          let insertAt = sectionIdx + 1;
          while (
            insertAt < lines.length &&
            lines[insertAt].trim() !== "" &&
            !lines[insertAt].startsWith("## ")
          ) {
            insertAt++;
          }
          lines.splice(insertAt, 0, link);
        } else {
          lines.push(`\n## ${section}`, link);
        }
      } else {
        lines.push(link);
      }
    }

    atomicWriteFile(indexPath, lines.join("\n"));

    return { content: [{ type: "text", text: `Index updated: ${link}` }] };
  } finally {
    releaseLock();
  }
}

// --- MCP Tool definitions -------------------------------------------------

const WIKI_TOOLS: Tool[] = [
  {
    name: "wiki_query",
    description: "Search topic, article, or summary indexes and return relevant candidates.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question or topic to search for",
        },
        topic: {
          type: "string",
          description: "Optional topic name to narrow the search",
        },
        kind: {
          type: "string",
          enum: ["all", "topic", "article", "summary"],
          description: "Document kind to search; defaults to all",
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of candidates; defaults to 8",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "wiki_read",
    description:
      "Read one topic, article, or summary returned by wiki_query. For a clearly matching continuing persona, set adopt=true when reading a topic.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["topic", "article", "summary"] },
        key: { type: "string", description: "Canonical key returned by wiki_query" },
        adopt: {
          type: "boolean",
          description: "For kind=topic, persist this canonical memory key for the current room",
        },
      },
      required: ["kind", "key"],
    },
  },
  {
    name: "wiki_topic_brief",
    description: "Get the lightweight topic brief for a specific topic.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic name (e.g. 'dev', 'trading', 'research')",
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "wiki_last_conversation",
    description: "Read the last N turns from the most recent archived session log for a topic.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Topic name (e.g. 'dev', 'trading')",
        },
        turns: {
          type: "number",
          description: "Number of recent turns (max 10), default 5",
          minimum: 1,
          maximum: 10,
        },
      },
      required: ["topic"],
    },
  },
  {
    name: "save_wiki_entry",
    description: "Save a session summary directly to wiki/summaries/.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic name of the session" },
        content: { type: "string", description: "Session summary in markdown" },
      },
      required: ["topic", "content"],
    },
  },
  {
    name: "save_topic_brief",
    description:
      "Write the accumulated persona/topic brief to wiki/topic/<topic>.md and mirror it into SQLite for next-session injection. Call this AFTER save_wiki_entry (archive → summary → brief order).",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Topic name of the session" },
        content: {
          type: "string",
          description: "Full accumulated topic brief in markdown (persona layer + recent work)",
        },
      },
      required: ["topic", "content"],
    },
  },
  {
    name: "index_upsert",
    description: "Upsert an entry in wiki/article-index.md, topic-index.md, or skill-index.md.",
    inputSchema: {
      type: "object",
      properties: {
        slug: {
          type: "string",
          description: "Article/summary slug or topic name",
        },
        description: {
          type: "string",
          description: "Single-line description for the index row",
        },
        kind: {
          type: "string",
          enum: ["article", "summary", "topic", "skill"],
          description: "Which index to update",
        },
        section: {
          type: "string",
          description: "For kind='article': H2 section title",
        },
        date: {
          type: "string",
          description: "Override entry date YYYY-MM-DD (default: today)",
        },
      },
      required: ["slug", "description", "kind"],
    },
  },
];

const SKILL_TOOLS: Tool[] = [
  {
    name: "skill_query",
    description: "Search this node's local skill library and return matching definitions.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The skill name or description of what you want to do",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "skill_save",
    description: "Create or update a skill on this node.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill folder name in kebab-case",
        },
        content: {
          type: "string",
          description: "Skill definition in markdown (with frontmatter name+description)",
        },
      },
      required: ["name", "content"],
    },
  },
];

// --- Server ----------------------------------------------------------------

export function createWikiMcpServer(context: WikiMcpContext, host: WikiMcpHost): Server {
  const surface = context.surface ?? "all";
  const wikiDir = resolve(host.wikiRoot);
  const current: WikiRuntime = {
    userId: context.userId,
    currentTopicId: context.currentTopicId ?? context.topicId,
    topicId: context.topicId,
    surface,
    host,
    wikiDir,
    skillsDir: resolve(wikiDir, "skills"),
    topicsDir: resolve(wikiDir, "topic"),
    summariesDir: resolve(wikiDir, "summaries"),
    articlesDir: resolve(wikiDir, "articles"),
    archiveDir: resolve(wikiDir, "archive"),
  };
  const tools =
    surface === "wiki"
      ? WIKI_TOOLS
      : surface === "skills"
        ? SKILL_TOOLS
        : [...WIKI_TOOLS, ...SKILL_TOOLS];
  for (const directory of [
    current.skillsDir,
    current.topicsDir,
    current.summariesDir,
    current.articlesDir,
    current.archiveDir,
  ]) {
    ensureDir(directory);
  }

  const server = new Server(
    { name: "wiki-server", version: "2.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => ({
      tools,
    }),
  );
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    return wikiRuntime.run(current, () => {
      const { name, arguments: args } = request.params;
      const handlers: Record<string, (a: Record<string, unknown>) => CallToolResult> = {
        wiki_query: wikiQuery,
        wiki_read: wikiRead,
        wiki_topic_brief: wikiTopicBrief,
        wiki_last_conversation: wikiLastConversation,
        skill_query: skillQuery,
        skill_save: skillSave,
        save_wiki_entry: saveWikiEntry,
        save_topic_brief: saveTopicBrief,
        index_upsert: indexUpsert,
      };
      const handler = tools.some((tool) => tool.name === name) ? handlers[name] : undefined;
      return handler
        ? handler((args ?? {}) as Record<string, unknown>)
        : { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    });
  });
  return server;
}

// --- Entrypoint ------------------------------------------------------------

async function main() {
  const context = parseArgv();
  let bridge: Partial<WikiMcpHost> = {};
  if (context.topicId) {
    try {
      const [briefs, topics, topicLifecycle] = await Promise.all([
        import("#storage/api-topic-brief"),
        import("#storage/api-topics"),
        import("#topics/derive"),
      ]);
      bridge = {
        getTopicBrief: briefs.getTopicBrief,
        canReadTopicMemory: (selection, userId) => {
          const normalized = selection
            .trim()
            .toLowerCase()
            .replace(/^topic\//, "")
            .replace(/\.md$/i, "");
          return topics.listTopics().some((topic) => {
            if (topic.visibility === "hidden") return false;
            if (!topic.participants.some((participant) => participant.userId === userId))
              return false;
            return (
              topic.id === selection ||
              topic.title.trim().toLowerCase() === normalized ||
              wikiSummarySlug(topic.title).toLowerCase() === normalized ||
              topic.memoryKey?.toLowerCase() === normalized
            );
          });
        },
        resolveTopicBrief: (selection, userId) =>
          resolveAccessibleWikiTopicBrief(
            selection,
            userId,
            topics.listTopics(),
            briefs.resolveTopicBrief,
          ),
        setTopicBrief: briefs.setTopicBrief,
        adoptTopicMemory: (topicId, userId, memoryKey) => {
          const topic = topics.getTopic(topicId);
          if (
            !topic?.participants.some(
              (participant) => participant.userId === userId && participant.role === "owner",
            )
          ) {
            return false;
          }
          return topicLifecycle.updateTopic(topicId, { memoryKey });
        },
      };
    } catch {
      // DB not available — degrade gracefully (file-only).
    }
  }
  const transport = new StdioServerTransport();
  await createWikiMcpServer(context, {
    wikiRoot: SHARED_WIKI_DIR,
    ...bridge,
  }).connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("wiki-server fatal:", err);
    exit(1);
  });
}
