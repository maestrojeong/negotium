export type McpTextContent = { type: "text"; text: string };

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
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
