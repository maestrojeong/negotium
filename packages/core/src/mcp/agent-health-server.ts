#!/usr/bin/env node

import "./stdio-protect";
import { createAgentHealthMcpServer } from "./factories/agent-health";
import { connectStdio, parseUserIdArg } from "./mcp-helpers";

const userId = parseUserIdArg(process.argv.slice(2));
await connectStdio(createAgentHealthMcpServer({ userId }));
