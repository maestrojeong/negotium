#!/usr/bin/env node
import { createCompactionLogMcpServer } from "#mcp/factories/compaction-log";
import { connectStdio } from "#mcp/mcp-helpers";

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const filePath = process.env.NEGOTIUM_COMPACTION_LOG_PATH;
if (!filePath) {
  process.stderr.write("compaction-log-server: NEGOTIUM_COMPACTION_LOG_PATH is required\n");
  process.exit(1);
}

await connectStdio(
  createCompactionLogMcpServer({
    filePath,
    maxCalls: positiveEnv("NEGOTIUM_COMPACTION_LOG_MAX_CALLS"),
    maxTotalBytes: positiveEnv("NEGOTIUM_COMPACTION_LOG_MAX_TOTAL_BYTES"),
    maxChunkBytes: positiveEnv("NEGOTIUM_COMPACTION_LOG_MAX_CHUNK_BYTES"),
  }),
);
