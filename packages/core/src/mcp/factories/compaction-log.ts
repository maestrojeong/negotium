import { readFileSync, realpathSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpError, mcpOk } from "../mcp-helpers";

const DEFAULT_MAX_CALLS = 12;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024;
const DEFAULT_MAX_CHUNK_BYTES = 64 * 1024;
const DEFAULT_LINE_LIMIT = 300;
const MAX_LINE_LIMIT = 500;

export interface CompactionLogMcpContext {
  filePath: string;
  maxCalls?: number;
  maxTotalBytes?: number;
  maxChunkBytes?: number;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : fallback;
}

function fitUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n[... oversized line clipped ...]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const bytes = Buffer.from(text, "utf8");
  if (maxBytes <= markerBytes) {
    return bytes
      .subarray(0, maxBytes)
      .toString("utf8")
      .replace(/\uFFFD+$/u, "");
  }
  const available = Math.max(0, maxBytes - markerBytes);
  const headBudget = Math.ceil(available * 0.6);
  const tailBudget = available - headBudget;
  const head = bytes
    .subarray(0, headBudget)
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
  const tail = bytes
    .subarray(Math.max(0, bytes.length - tailBudget))
    .toString("utf8")
    .replace(/^\uFFFD+/u, "");
  return `${head}${marker}${tail}`;
}

export function createCompactionLogMcpServer(context: CompactionLogMcpContext): McpServer {
  if (!context.filePath) throw new Error("compaction-log MCP requires filePath");
  const filePath = realpathSync(context.filePath);
  const lines = readFileSync(filePath, "utf8").split("\n");
  const maxCalls = positiveInt(context.maxCalls, DEFAULT_MAX_CALLS);
  const maxTotalBytes = positiveInt(context.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES);
  const maxChunkBytes = positiveInt(context.maxChunkBytes, DEFAULT_MAX_CHUNK_BYTES);
  let calls = 0;
  let totalBytes = 0;

  const server = new McpServer({ name: "compaction-log", version: "1.0.0" });
  server.tool(
    "read_compaction_log",
    [
      `Read the immutable conversation snapshot in bounded chunks. It contains ${lines.length} lines.`,
      "Start at offset 1, then inspect the final chunk using total_lines from the response.",
      "Read intermediate chunks only when needed. Return a summary instead of calling after the budget is exhausted.",
    ].join(" "),
    {
      offset: z.number().optional().describe("One-based line number. Defaults to 1."),
      limit: z
        .number()
        .optional()
        .describe(`Number of lines. Defaults to ${DEFAULT_LINE_LIMIT}, max ${MAX_LINE_LIMIT}.`),
    },
    async ({ offset: rawOffset, limit: rawLimit }) => {
      calls += 1;
      if (calls > maxCalls || totalBytes >= maxTotalBytes) {
        return mcpError(
          JSON.stringify({
            error: "compaction log read budget exhausted; produce the summary now",
            calls,
            max_calls: maxCalls,
            total_lines: lines.length,
          }),
        );
      }

      const offset = positiveInt(rawOffset, 1);
      const limit = Math.min(positiveInt(rawLimit, DEFAULT_LINE_LIMIT), MAX_LINE_LIMIT);
      const start = Math.max(0, offset - 1);
      if (start >= lines.length) {
        return mcpOk(
          JSON.stringify({
            content: "(end of compaction log)",
            offset,
            returned_lines: 0,
            total_lines: lines.length,
            calls,
          }),
        );
      }

      const selected: string[] = [];
      let returnedBytes = 0;
      let index = start;
      const callBudget = Math.min(maxChunkBytes, maxTotalBytes - totalBytes);
      while (index < lines.length && selected.length < limit) {
        const line = fitUtf8(lines[index] ?? "", Math.max(1, callBudget));
        const separatorBytes = selected.length > 0 ? 1 : 0;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (selected.length > 0 && returnedBytes + separatorBytes + lineBytes > callBudget) break;
        selected.push(line);
        returnedBytes += separatorBytes + lineBytes;
        index += 1;
        if (returnedBytes >= callBudget) break;
      }
      totalBytes += returnedBytes;

      return mcpOk(
        JSON.stringify({
          content: selected.join("\n"),
          offset,
          returned_lines: selected.length,
          returned_bytes: returnedBytes,
          total_lines: lines.length,
          total_read_bytes: totalBytes,
          calls,
          ...(index < lines.length ? { next_offset: index + 1 } : {}),
          ...(calls >= maxCalls || totalBytes >= maxTotalBytes
            ? { note: "Read budget exhausted; produce the summary now." }
            : {}),
        }),
      );
    },
  );
  return server;
}
