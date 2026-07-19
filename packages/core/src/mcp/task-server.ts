#!/usr/bin/env node
import "./stdio-protect";
import { createTaskMcpServer } from "#mcp/factories/task";
import { connectStdio, parseUserIdArg } from "#mcp/mcp-helpers";

const args = process.argv.slice(2);
const topic = args.find((arg) => arg.startsWith("--topic="))?.slice("--topic=".length) || "";
const topicId =
  args.find((arg) => arg.startsWith("--topic-id="))?.slice("--topic-id=".length) || undefined;

await connectStdio(
  createTaskMcpServer({
    userId: parseUserIdArg(args),
    topic,
    topicId,
  }),
);
