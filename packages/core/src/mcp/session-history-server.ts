#!/usr/bin/env node
import "./stdio-protect";
import { createSessionHistoryMcpServer } from "#mcp/factories/session-history";
import { connectStdio, parseUserIdArg } from "#mcp/mcp-helpers";

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const args = process.argv.slice(2);
const topic = args.find((arg) => arg.startsWith("--topic="))?.slice("--topic=".length) || "";
const topicId =
  args.find((arg) => arg.startsWith("--topic-id="))?.slice("--topic-id=".length) || undefined;

await connectStdio(
  createSessionHistoryMcpServer({
    userId: parseUserIdArg(args),
    topic,
    topicId,
    maxCalls: positiveEnv("NEGOTIUM_SESSION_HISTORY_MAX_CALLS"),
    maxTotalBytes: positiveEnv("NEGOTIUM_SESSION_HISTORY_MAX_TOTAL_BYTES"),
    maxChunkBytes: positiveEnv("NEGOTIUM_SESSION_HISTORY_MAX_CHUNK_BYTES"),
  }),
);
