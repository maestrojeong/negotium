import { type McpContent, mcpError, mcpOk } from "#mcp/mcp-helpers";

export type McpTextContent = McpContent;

export type McpToolResult = {
  content: McpTextContent[];
  isError?: true;
};

export type SharedMcpTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (input: any) => McpToolResult | Promise<McpToolResult>;
};

export function textResult(text: string): McpToolResult {
  return mcpOk(text);
}

export function errorResult(text: string): McpToolResult {
  return mcpError(text);
}
