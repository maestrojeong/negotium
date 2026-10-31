import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { errMsg } from "#platform/error";
import { type ConversationEntry, readRawConversation } from "#storage/conversations";
import { eventSpeaker, eventText } from "#storage/topic-archive";
import { mcpError, mcpOk } from "../mcp-helpers";

const DEFAULT_MAX_CALLS = 20;
const DEFAULT_MAX_TOTAL_BYTES = 768 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;
const DEFAULT_LINE_LIMIT = 300;
const MAX_LINE_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;
const SEARCH_SNIPPET_RADIUS = 160;

export interface SessionHistoryMcpContext {
  userId: string;
  /** Topic title — the conversation log is keyed by (userId, topic title). */
  topic: string;
  topicId?: string;
  maxCalls?: number;
  maxTotalBytes?: number;
  maxChunkBytes?: number;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : fallback;
}

/** Mirrors compaction-log.ts's byte-bounded clipping so one oversized entry cannot blow a budget. */
function fitUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n[... oversized entry clipped ...]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const bytes = Buffer.from(text, "utf8");
  if (maxBytes <= markerBytes) {
    return bytes.subarray(0, maxBytes).toString("utf8").replace(/�+$/u, "");
  }
  const available = Math.max(0, maxBytes - markerBytes);
  const headBudget = Math.ceil(available * 0.6);
  const tailBudget = available - headBudget;
  const head = bytes.subarray(0, headBudget).toString("utf8").replace(/�+$/u, "");
  const tail = bytes
    .subarray(Math.max(0, bytes.length - tailBudget))
    .toString("utf8")
    .replace(/^�+/u, "");
  return `${head}${marker}${tail}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One rendered line: `[<entry#>] <ts> <speaker>: <text>`. Entry numbers are 1-based positions in the raw manifest, not byte-file line numbers (malformed lines are skipped on read). */
function renderEntry(entry: ConversationEntry, index: number): string {
  const speaker = eventSpeaker(entry.event, entry.agent);
  const text = eventText(entry.event);
  return `[${index}] ${entry.ts} ${speaker}: ${text}`;
}

type SessionBoundary = {
  entryIndex: number;
  sessionId: string;
  agent: string;
  startedAt: string;
  endedAt?: string;
  endedBy: "compacted" | "agent-switch" | "active" | "initial";
};

/**
 * Derive session/compact boundaries from the raw manifest's `session` events.
 *
 * Heuristic (see compactTopicSession/switchTopicAgent in topics/session.ts
 * and agents/topic-agent-switch.ts): a compact appends a new `session` event
 * for the SAME agent with a new sessionId; an agent switch appends one for a
 * DIFFERENT agent. The raw manifest carries no explicit "compacted here"
 * marker of its own — that marker only lives in the replaceable active
 * projection, which compaction overwrites.
 *
 * Providers also re-announce the SAME sessionId at the start of every turn
 * of a resumed session (Claude's system init, Codex's `thread.started`), and
 * every streamed event — including that re-announcement — gets recorded
 * into the raw manifest. Without deduping those repeats, a long-lived
 * session would mint a spurious "compacted" boundary on every single turn.
 * Only an actual sessionId change is a real boundary; a repeat of the
 * current sessionId is a no-op re-announcement.
 */
function deriveBoundaries(entries: ConversationEntry[]): SessionBoundary[] {
  const boundaries: SessionBoundary[] = [];
  entries.forEach((entry, i) => {
    if (entry.event.type !== "session") return;
    const index = i + 1;
    const previous = boundaries.at(-1);
    if (previous && previous.sessionId === entry.event.sessionId) return;
    if (previous) {
      previous.endedAt = entry.ts;
      previous.endedBy = previous.agent === entry.agent ? "compacted" : "agent-switch";
    }
    boundaries.push({
      entryIndex: index,
      sessionId: entry.event.sessionId,
      agent: entry.agent,
      startedAt: entry.ts,
      endedBy: "active",
    });
  });
  if (boundaries.length === 0 && entries.length > 0) {
    // Topics created before the raw manifest always carried a leading
    // `session` event, or ones whose first session event rotted off a
    // malformed line, still get one entry covering everything.
    boundaries.push({
      entryIndex: 1,
      sessionId: "(unknown — no session event found)",
      agent: entries[0]?.agent ?? "unknown",
      startedAt: entries[0]?.ts ?? "",
      endedBy: "active",
    });
  }
  return boundaries;
}

export function createSessionHistoryMcpServer(context: SessionHistoryMcpContext): McpServer {
  const maxCalls = positiveInt(context.maxCalls, DEFAULT_MAX_CALLS);
  const maxTotalBytes = positiveInt(context.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const maxChunkBytes = positiveInt(context.maxChunkBytes, DEFAULT_MAX_CHUNK_BYTES);
  let calls = 0;
  let totalBytes = 0;

  const server = new McpServer({ name: "session-history", version: "1.0.0" });

  const requireContext = (): ReturnType<typeof mcpError> | null => {
    if (!context.userId || !context.topic) {
      return mcpError("Error: missing userId/topic context.");
    }
    return null;
  };

  const budgetExceeded = (): ReturnType<typeof mcpError> | null => {
    if (calls > maxCalls || totalBytes >= maxTotalBytes) {
      return mcpError(
        JSON.stringify({
          error:
            "session-history read budget exhausted for this turn; answer with what you already read",
          calls,
          max_calls: maxCalls,
          total_read_bytes: totalBytes,
          max_total_bytes: maxTotalBytes,
        }),
      );
    }
    return null;
  };

  server.tool(
    "list_session_boundaries",
    [
      "List every provider session this topic has had, in order, from the append-only raw",
      "conversation manifest (survives /compact and agent switches — nothing is ever deleted",
      "from it). Each entry gives the 1-based entry-index range covering that session, whether",
      "it ended via compaction or an agent switch, and its provider sessionId. Call this BEFORE",
      "read_session_history or search_session_history so you know which entry range to target",
      "instead of scanning from entry 1.",
    ].join(" "),
    {},
    async () => {
      const guard = requireContext();
      if (guard) return guard;
      calls += 1;
      const budget = budgetExceeded();
      if (budget) return budget;
      try {
        const entries = readRawConversation(context.userId, context.topic);
        const boundaries = deriveBoundaries(entries);
        const payload = JSON.stringify(
          { total_entries: entries.length, sessions: boundaries },
          null,
          2,
        );
        totalBytes += Buffer.byteLength(payload, "utf8");
        return mcpOk(payload);
      } catch (error) {
        return mcpError(`list_session_boundaries failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool(
    "read_session_history",
    [
      "Read the full-fidelity raw conversation manifest in bounded chunks — includes everything",
      "that ever happened in this topic (messages, tool calls, reasoning, session/compact",
      "boundaries), even content a /compact summarized away from the active context. Entry",
      "numbers are 1-based positions, as returned by list_session_boundaries. Start by calling",
      "list_session_boundaries, then pass sessionId to read only that session's range instead of",
      "paging through the whole topic.",
    ].join(" "),
    {
      offset: z.number().optional().describe("One-based entry number. Defaults to 1."),
      limit: z
        .number()
        .optional()
        .describe(`Number of entries. Defaults to ${DEFAULT_LINE_LIMIT}, max ${MAX_LINE_LIMIT}.`),
      sessionId: z
        .string()
        .optional()
        .describe("Restrict to one session's entry range (see list_session_boundaries)."),
    },
    async ({ offset: rawOffset, limit: rawLimit, sessionId }) => {
      const guard = requireContext();
      if (guard) return guard;
      calls += 1;
      const budget = budgetExceeded();
      if (budget) return budget;
      try {
        const entries = readRawConversation(context.userId, context.topic);
        let lower = 0;
        let upper = entries.length;
        if (sessionId) {
          const boundaries = deriveBoundaries(entries);
          const match = boundaries.find((b) => b.sessionId === sessionId);
          if (!match) return mcpError(`Unknown sessionId: ${sessionId}`);
          lower = match.entryIndex - 1;
          const next = boundaries.find((b) => b.entryIndex > match.entryIndex);
          upper = next ? next.entryIndex - 1 : entries.length;
        }
        const offset = positiveInt(rawOffset, 1);
        const limit = Math.min(positiveInt(rawLimit, DEFAULT_LINE_LIMIT), MAX_LINE_LIMIT);
        const start = Math.max(lower, offset - 1);
        if (start >= upper) {
          return mcpOk(
            JSON.stringify({
              content: "(end of range)",
              offset,
              returned_entries: 0,
              total_entries: entries.length,
              calls,
            }),
          );
        }

        const rendered: string[] = [];
        let returnedBytes = 0;
        let index = start;
        const callBudget = Math.min(maxChunkBytes, Math.max(1, maxTotalBytes - totalBytes));
        while (index < upper && rendered.length < limit) {
          const line = fitUtf8(renderEntry(entries[index], index + 1), Math.max(1, callBudget));
          const separatorBytes = rendered.length > 0 ? 1 : 0;
          const lineBytes = Buffer.byteLength(line, "utf8");
          if (rendered.length > 0 && returnedBytes + separatorBytes + lineBytes > callBudget) break;
          rendered.push(line);
          returnedBytes += separatorBytes + lineBytes;
          index += 1;
          if (returnedBytes >= callBudget) break;
        }
        totalBytes += returnedBytes;

        return mcpOk(
          JSON.stringify({
            content: rendered.join("\n"),
            offset,
            returned_entries: rendered.length,
            returned_bytes: returnedBytes,
            total_entries: entries.length,
            total_read_bytes: totalBytes,
            calls,
            ...(index < upper ? { next_offset: index + 1 } : {}),
            ...(calls >= maxCalls || totalBytes >= maxTotalBytes
              ? { note: "Read budget nearly exhausted; wrap up with what you have." }
              : {}),
          }),
        );
      } catch (error) {
        return mcpError(`read_session_history failed: ${errMsg(error)}`);
      }
    },
  );

  server.tool(
    "search_session_history",
    [
      "Keyword-search the full raw conversation manifest (case-insensitive substring match)",
      "across every session this topic has ever had, including content a /compact summarized",
      "away. Returns matching entry numbers with a short snippet around the match — pass one",
      "into read_session_history to see full context. Plain linear scan, no index: fine at this",
      "topic's size, but prefer sessionId to narrow the scan when you already know which session",
      "from list_session_boundaries.",
    ].join(" "),
    {
      query: z.string().min(1).describe("Case-insensitive substring to search for."),
      sessionId: z.string().optional().describe("Restrict the scan to one session's range."),
      limit: z
        .number()
        .optional()
        .describe(
          `Max matches to return. Defaults to ${DEFAULT_SEARCH_LIMIT}, max ${MAX_SEARCH_LIMIT}.`,
        ),
    },
    async ({ query, sessionId, limit: rawLimit }) => {
      const guard = requireContext();
      if (guard) return guard;
      calls += 1;
      const budget = budgetExceeded();
      if (budget) return budget;
      try {
        const entries = readRawConversation(context.userId, context.topic);
        let lower = 0;
        let upper = entries.length;
        if (sessionId) {
          const boundaries = deriveBoundaries(entries);
          const match = boundaries.find((b) => b.sessionId === sessionId);
          if (!match) return mcpError(`Unknown sessionId: ${sessionId}`);
          lower = match.entryIndex - 1;
          const next = boundaries.find((b) => b.entryIndex > match.entryIndex);
          upper = next ? next.entryIndex - 1 : entries.length;
        }
        const limit = Math.min(positiveInt(rawLimit, DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);
        // A case-insensitive RegExp matched against the ORIGINAL text, rather than
        // `text.toLowerCase().indexOf(needle)`, because lowercasing can change a
        // string's length for some Unicode code points (e.g. "İ" -> "i̇", 1 -> 2
        // UTF-16 units) — that would desync the match index from `text` and the
        // snippet could drift away from the actual match.
        const needleRegex = new RegExp(escapeRegExp(query), "i");
        const matches: {
          entry: number;
          sessionId: string | undefined;
          agent: string;
          ts: string;
          snippet: string;
        }[] = [];
        const boundaries = sessionId ? undefined : deriveBoundaries(entries);
        let returnedBytes = 0;
        let budgetStopped = false;
        const callBudget = Math.min(maxChunkBytes, Math.max(1, maxTotalBytes - totalBytes));
        for (let i = lower; i < upper && matches.length < limit; i++) {
          const entry = entries[i];
          const text = eventText(entry.event);
          const found = needleRegex.exec(text);
          if (!found) continue;
          const at = found.index;
          const start = Math.max(0, at - SEARCH_SNIPPET_RADIUS);
          const end = Math.min(text.length, at + found[0].length + SEARCH_SNIPPET_RADIUS);
          const snippet = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
          const matchedSessionId =
            sessionId ?? boundaries?.findLast((b) => b.entryIndex <= i + 1)?.sessionId;
          const candidate = {
            entry: i + 1,
            sessionId: matchedSessionId,
            agent: entry.agent,
            ts: entry.ts,
            snippet,
          };
          // Count the bytes of the exact object pushed below (not a partial
          // {entry, snippet} stand-in) so totalBytes isn't undercounted.
          const lineBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
          if (returnedBytes + lineBytes > callBudget) {
            budgetStopped = true;
            break;
          }
          returnedBytes += lineBytes;
          matches.push(candidate);
        }
        totalBytes += returnedBytes;

        return mcpOk(
          JSON.stringify({
            query,
            matches,
            match_count: matches.length,
            total_entries: entries.length,
            calls,
            ...(matches.length >= limit
              ? { note: "Hit the match limit; narrow the query or pass sessionId for more." }
              : budgetStopped
                ? {
                    note: "Read budget ran out before the scan finished; this result is incomplete, not necessarily 'no matches'.",
                  }
                : {}),
          }),
        );
      } catch (error) {
        return mcpError(`search_session_history failed: ${errMsg(error)}`);
      }
    },
  );

  return server;
}
