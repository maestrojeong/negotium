#!/usr/bin/env node
import "./stdio-protect";
import { createDecisionMcpServer } from "#mcp/factories/decision";
import { connectStdio, parseUserIdArg } from "#mcp/mcp-helpers";
import { isAgentKind } from "#types";

const args = process.argv.slice(2);
const topic = args.find((arg) => arg.startsWith("--topic="))?.slice("--topic=".length) || "";
const topicId = args.find((arg) => arg.startsWith("--topic-id="))?.slice("--topic-id=".length);
const agentArg = args.find((arg) => arg.startsWith("--agent="))?.slice("--agent=".length);
const model = args.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);

await connectStdio(
  createDecisionMcpServer({
    userId: parseUserIdArg(args),
    topic,
    topicId,
    agent: agentArg && isAgentKind(agentArg) ? agentArg : "codex",
    model,
  }),
);
