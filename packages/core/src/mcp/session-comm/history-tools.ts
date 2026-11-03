/**
 * Cross-topic session-history tools (`*_session_history_of`) — registration
 * only, shared by the hosted factory and the stdio session-comm server.
 *
 * Storage-free on purpose (the hosted factory must not read process or
 * storage state): the reader that resolves `to` and reads the manifest is
 * injected. Access is exactly session-comm's addressing scope — a room the
 * caller can name in `list_sessions` (same surface, same workspace, the
 * roster or the hub's reach set) and, for a subagent, only a room it may
 * `tell_session`. See `history-target.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpErrorResponse, McpResponse } from "#mcp/mcp-helpers";
import {
  SESSION_HISTORY_DEFAULT_LINE_LIMIT,
  SESSION_HISTORY_DEFAULT_SEARCH_LIMIT,
  SESSION_HISTORY_MAX_LINE_LIMIT,
  SESSION_HISTORY_MAX_SEARCH_LIMIT,
} from "#mcp/session-history-limits";

type MaybePromise<T> = T | Promise<T>;
type Result = McpResponse | McpErrorResponse;

export interface SessionHistoryOfReader {
  listBoundaries(to: string): MaybePromise<Result>;
  read(
    to: string,
    args: { offset?: number; limit?: number; sessionId?: string },
  ): MaybePromise<Result>;
  search(
    to: string,
    args: { query: string; sessionId?: string; limit?: number },
  ): MaybePromise<Result>;
}

export const SESSION_HISTORY_OF_TOOL_NAMES = [
  "list_session_boundaries_of",
  "read_session_history_of",
  "search_session_history_of",
] as const;

const to = z
  .string()
  .describe("Target session/topic name, exactly as list_sessions shows it (local sessions only).");

export function registerSessionHistoryOfTools(
  server: McpServer,
  reader: SessionHistoryOfReader,
): void {
  server.tool(
    "list_session_boundaries_of",
    [
      "Like list_session_boundaries, but for ANOTHER local session you can see in list_sessions:",
      "lists that topic's provider sessions (compactions, agent switches) with their 1-based",
      "entry ranges from its append-only raw conversation manifest. Call this before",
      "read_session_history_of / search_session_history_of to target a range. Read-only: the",
      "other session is not notified and nothing is injected into it. Use your own",
      "list_session_boundaries for the current topic.",
    ].join(" "),
    { to },
    async (args) => reader.listBoundaries(args.to),
  );

  server.tool(
    "read_session_history_of",
    [
      "Read ANOTHER local session's full-fidelity raw conversation manifest in bounded chunks",
      "(messages, tool calls, reasoning — including what its /compact summarized away). Use it",
      "when a tell_session/ask_session message points you at the sender's history (an entry",
      "range or sessionId) instead of pasting it, or when you need another topic's exact prior",
      "context. Only sessions listed by list_sessions are readable. Shares this turn's read",
      "budget with the other *_of tools.",
    ].join(" "),
    {
      to,
      offset: z.number().optional().describe("One-based entry number. Defaults to 1."),
      limit: z
        .number()
        .optional()
        .describe(
          `Number of entries. Defaults to ${SESSION_HISTORY_DEFAULT_LINE_LIMIT}, max ${SESSION_HISTORY_MAX_LINE_LIMIT}.`,
        ),
      sessionId: z
        .string()
        .optional()
        .describe("Restrict to one session's entry range (see list_session_boundaries_of)."),
    },
    async ({ to: target, ...args }) => reader.read(target, args),
  );

  server.tool(
    "search_session_history_of",
    [
      "Keyword-search ANOTHER local session's full raw conversation manifest (case-insensitive",
      "substring). Returns matching entry numbers with snippets — pass one to",
      "read_session_history_of for full context. Only sessions listed by list_sessions are",
      "searchable.",
    ].join(" "),
    {
      to,
      query: z.string().min(1).describe("Case-insensitive substring to search for."),
      sessionId: z.string().optional().describe("Restrict the scan to one session's range."),
      limit: z
        .number()
        .optional()
        .describe(
          `Max matches to return. Defaults to ${SESSION_HISTORY_DEFAULT_SEARCH_LIMIT}, max ${SESSION_HISTORY_MAX_SEARCH_LIMIT}.`,
        ),
    },
    async ({ to: target, ...args }) => reader.search(target, args),
  );
}
