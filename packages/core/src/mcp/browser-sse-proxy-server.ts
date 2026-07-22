#!/usr/bin/env bun
import "#mcp/stdio-protect";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const upstreamUrl = process.env.NEGOTIUM_BROWSER_SSE_URL;
const capability = process.env.NEGOTIUM_BROWSER_OWNER_CAPABILITY;
if (!upstreamUrl || !capability) throw new Error("browser SSE proxy configuration is missing");

function authenticatedHeaders(initial?: ConstructorParameters<typeof Headers>[0]): Headers {
  const headers = new Headers(initial);
  headers.set("X-Browser-Capability", capability as string);
  return headers;
}

const authenticatedFetch = (input: string | URL | Request, init?: RequestInit) =>
  fetch(input, { ...init, headers: authenticatedHeaders(init?.headers) });

const upstream = new Client({ name: "negotium-browser-sse-proxy", version: "1.0.0" });
const upstreamTransport = new SSEClientTransport(new URL(upstreamUrl), {
  eventSourceInit: { fetch: authenticatedFetch },
  requestInit: { headers: authenticatedHeaders() },
});
await upstream.connect(upstreamTransport);

const server = new Server(
  { name: "negotium-browser-sse-proxy", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
server.setRequestHandler(CallToolRequestSchema, (request) =>
  upstream.callTool({
    name: request.params.name,
    arguments: request.params.arguments ?? {},
  }),
);

async function shutdown(): Promise<void> {
  await upstream.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await server.connect(new StdioServerTransport());
