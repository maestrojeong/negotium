#!/usr/bin/env node
import "#mcp/stdio-protect";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const surface = process.argv.find((arg) => arg.startsWith("--surface="))?.slice(10);
const url = process.env.NEGOTIUM_CANONICAL_MCP_BRIDGE_URL;
const token = process.env.NEGOTIUM_CANONICAL_MCP_BRIDGE_TOKEN;
const TIMEOUT_MS = 20_000;

const taskTools: Tool[] = [
  {
    name: "task_create",
    description: "Add one or more tasks to this topic's shared Otium task list.",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              active_form: { type: "string" },
              blocked_by: { type: "array", items: { type: "string" } },
              owner: { type: "string" },
            },
            required: ["subject"],
          },
        },
      },
      required: ["tasks"],
    },
  },
  {
    name: "task_update",
    description: "Update tasks in this topic's shared Otium task list.",
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              subject: { type: "string" },
              active_form: { type: "string" },
              blocked_by: { type: "array", items: { type: "string" } },
              owner: { type: "string" },
            },
            required: ["id"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "task_list",
    description: "Read this topic's shared Otium task list.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "task_get",
    description: "Read one task as JSON.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "task_delete",
    description: "Delete tasks from this topic's shared Otium task list.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } }, all: { type: "boolean" } },
    },
  },
];

const wikiTools: Tool[] = [
  {
    name: "wiki_query",
    description: "Search the canonical workspace wiki.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "wiki_topic_brief",
    description: "Read this canonical topic's brief.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wiki_last_conversation",
    description: "Read recent archived conversation context for this canonical topic.",
    inputSchema: {
      type: "object",
      properties: { turns: { type: "number", minimum: 1, maximum: 10 } },
    },
  },
  {
    name: "save_wiki_entry",
    description: "Save a summary to the canonical workspace wiki.",
    inputSchema: {
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    },
  },
  {
    name: "index_upsert",
    description: "Upsert a canonical wiki index entry.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        description: { type: "string" },
        kind: { type: "string", enum: ["article", "summary", "topic"] },
        section: { type: "string" },
        date: { type: "string" },
      },
      required: ["slug", "description", "kind"],
    },
  },
];

const tools = surface === "task" ? taskTools : surface === "wiki" ? wikiTools : [];
const allowed = new Set(tools.map((tool) => tool.name));

function error(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const server = new Server(
  { name: `canonical-${surface ?? "invalid"}`, version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const tool = request.params.name;
  if (!url || !token || !allowed.has(tool)) return error("Canonical MCP bridge unavailable.");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tool, input: request.params.arguments ?? {} }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as {
      result?: CallToolResult;
      error?: string;
    } | null;
    if (!response.ok || !body?.result)
      return error(body?.error ?? `Canonical MCP bridge failed (${response.status}).`);
    return body.result;
  } catch (cause) {
    return error(`Canonical MCP bridge failed: ${(cause as Error).message}`);
  }
});

await server.connect(new StdioServerTransport());
