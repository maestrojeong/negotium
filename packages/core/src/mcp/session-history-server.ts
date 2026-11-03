#!/usr/bin/env node
import "./stdio-protect";
import { createSessionHistoryMcpServer } from "#mcp/factories/session-history";
import { connectStdio, parseUserIdArg } from "#mcp/mcp-helpers";
import { sessionHistoryBudgetFromEnv } from "#mcp/session-history-limits";

const args = process.argv.slice(2);
const topic = args.find((arg) => arg.startsWith("--topic="))?.slice("--topic=".length) || "";
const topicId =
  args.find((arg) => arg.startsWith("--topic-id="))?.slice("--topic-id=".length) || undefined;

await connectStdio(
  createSessionHistoryMcpServer({
    userId: parseUserIdArg(args),
    topic,
    topicId,
    ...sessionHistoryBudgetFromEnv(),
  }),
);
