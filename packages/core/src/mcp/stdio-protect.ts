/** Standalone stdio MCP bootstrap. Embedded consumers should call protectMcpStdio explicitly. */
import { protectMcpStdio } from "#mcp/factories/stdio-protection";

export const restoreMcpStdioProtection = protectMcpStdio({
  env: process.env,
  console,
});
