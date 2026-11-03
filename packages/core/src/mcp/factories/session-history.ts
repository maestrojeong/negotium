import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpError } from "../mcp-helpers";
import {
  SESSION_HISTORY_DEFAULT_LINE_LIMIT,
  SESSION_HISTORY_DEFAULT_SEARCH_LIMIT,
  SESSION_HISTORY_MAX_LINE_LIMIT,
  SESSION_HISTORY_MAX_SEARCH_LIMIT,
} from "../session-history-limits";
import { createSessionHistoryReader, type SessionHistoryTarget } from "../session-history-reader";

export interface SessionHistoryMcpContext {
  userId: string;
  /** Topic title — the conversation log is keyed by (userId, topic title). */
  topic: string;
  topicId?: string;
  maxCalls?: number;
  maxTotalBytes?: number;
  maxChunkBytes?: number;
}

export function createSessionHistoryMcpServer(context: SessionHistoryMcpContext): McpServer {
  const reader = createSessionHistoryReader({
    maxCalls: context.maxCalls,
    maxTotalBytes: context.maxTotalBytes,
    maxChunkBytes: context.maxChunkBytes,
  });
  const self: SessionHistoryTarget = { userId: context.userId, topic: context.topic };

  const server = new McpServer({ name: "session-history", version: "1.0.0" });

  const requireContext = (): ReturnType<typeof mcpError> | null => {
    if (!context.userId || !context.topic) {
      return mcpError("Error: missing userId/topic context.");
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
    async () => requireContext() ?? reader.listBoundaries(self),
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
        .describe(
          `Number of entries. Defaults to ${SESSION_HISTORY_DEFAULT_LINE_LIMIT}, max ${SESSION_HISTORY_MAX_LINE_LIMIT}.`,
        ),
      sessionId: z
        .string()
        .optional()
        .describe("Restrict to one session's entry range (see list_session_boundaries)."),
    },
    async (args) => requireContext() ?? reader.read(self, args),
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
          `Max matches to return. Defaults to ${SESSION_HISTORY_DEFAULT_SEARCH_LIMIT}, max ${SESSION_HISTORY_MAX_SEARCH_LIMIT}.`,
        ),
    },
    async (args) => requireContext() ?? reader.search(self, args),
  );

  return server;
}
