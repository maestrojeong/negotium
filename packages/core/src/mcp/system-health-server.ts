#!/usr/bin/env node
import { createSystemHealthMcpServer } from "#mcp/factories/system-health";
import { connectStdio } from "#mcp/mcp-helpers";

await connectStdio(createSystemHealthMcpServer());
