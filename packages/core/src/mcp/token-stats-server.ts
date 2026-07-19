#!/usr/bin/env node
import { createTokenStatsMcpServer } from "#mcp/factories/token-stats";
import { connectStdio, parseUserIdArg } from "#mcp/mcp-helpers";

const userId = parseUserIdArg(process.argv.slice(2));
if (!userId) {
  process.stderr.write("token-stats-server: --user-id is required\n");
  process.exit(1);
}
await connectStdio(createTokenStatsMcpServer({ userId }));
