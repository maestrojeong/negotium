#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

function parseCli(argv = process.argv.slice(2)) {
  const options = { host: "127.0.0.1" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const nextValue = () => inlineValue ?? argv[++index];
    switch (flag) {
      case "--host":
        options.host = nextValue();
        break;
      case "--port": {
        const value = Number(nextValue());
        if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid --port: ${value}`);
        options.port = value;
        break;
      }
      case "--user-data-dir":
        options.userDataDir = nextValue();
        break;
      case "--headless":
        options.headless = true;
        break;
      case "--headed":
        options.headless = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.port) throw new Error("--port is required");
  return options;
}

const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("mcp-patchright/package.json"));
const [{ BrowserManager }, { handleTool }, { tools }] = await Promise.all([
  import(pathToFileURL(resolve(packageRoot, "dist/browser/manager.js")).href),
  import(pathToFileURL(resolve(packageRoot, "dist/tools/handlers.js")).href),
  import(pathToFileURL(resolve(packageRoot, "dist/tools/registry.js")).href),
]);

function createMcpServer(defaultStartOptions, sharedManager) {
  const server = new Server(
    { name: "mcp-patchright", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const manager = sharedManager ?? new BrowserManager(defaultStartOptions);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await handleTool(manager, request.params.name, request.params.arguments ?? {});
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          },
        ],
        isError: true,
      };
    }
  });
  return server;
}

// Egress proxy is passed via env (not argv) so credentials stay out of `ps`.
// The parent backend sets NEGOTIUM_BROWSER_PROXY_* from resolveBrowserProxy().
function proxyFromEnv() {
  const server = process.env.NEGOTIUM_BROWSER_PROXY_SERVER;
  if (!server) return undefined;
  const proxy = { server };
  if (process.env.NEGOTIUM_BROWSER_PROXY_USERNAME)
    proxy.username = process.env.NEGOTIUM_BROWSER_PROXY_USERNAME;
  if (process.env.NEGOTIUM_BROWSER_PROXY_PASSWORD)
    proxy.password = process.env.NEGOTIUM_BROWSER_PROXY_PASSWORD;
  if (process.env.NEGOTIUM_BROWSER_PROXY_BYPASS)
    proxy.bypass = process.env.NEGOTIUM_BROWSER_PROXY_BYPASS;
  return proxy;
}

const options = parseCli();
const proxy = proxyFromEnv();
const defaultStartOptions = {
  ...(options.userDataDir ? { userDataDir: options.userDataDir } : {}),
  ...(options.headless !== undefined ? { headless: options.headless } : {}),
  ...(proxy ? { proxy } : {}),
};
const sharedManager = new BrowserManager(defaultStartOptions);
const app = createMcpExpressApp({ host: options.host });

const transports = {};
const servers = {};
let httpServer;

app.get("/health", async (_req, res) => {
  res.json({
    ok: true,
    name: "mcp-patchright",
    transports: Object.keys(transports).length,
    browser: await sharedManager.status().catch(() => undefined),
  });
});

app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    const normalizedSessionId = Array.isArray(sessionId)
      ? sessionId[0]
      : typeof sessionId === "string"
        ? sessionId
        : undefined;
    let transport;
    if (normalizedSessionId && transports[normalizedSessionId]) {
      const existingTransport = transports[normalizedSessionId];
      if (!(existingTransport instanceof StreamableHTTPServerTransport)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session uses a different transport protocol" },
          id: null,
        });
        return;
      }
      transport = existingTransport;
    } else if (!normalizedSessionId && req.method === "POST" && isInitializeRequest(req.body)) {
      let server;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (!transport || !server) return;
          transports[newSessionId] = transport;
          servers[newSessionId] = server;
        },
      });
      server = createMcpServer(defaultStartOptions, sharedManager);
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) {
          delete transports[sid];
          const managedServer = servers[sid];
          delete servers[sid];
          void managedServer?.close().catch(() => undefined);
        }
      };
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling /mcp request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/sse", async (_req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer(defaultStartOptions, sharedManager);
  transports[transport.sessionId] = transport;
  servers[transport.sessionId] = server;
  res.on("close", () => {
    const sid = transport.sessionId;
    delete transports[sid];
    delete servers[sid];
    void server.close().catch(() => undefined);
  });
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const normalizedSessionId =
    typeof sessionId === "string"
      ? sessionId
      : Array.isArray(sessionId) && typeof sessionId[0] === "string"
        ? sessionId[0]
        : undefined;
  const existingTransport = normalizedSessionId ? transports[normalizedSessionId] : undefined;
  if (!(existingTransport instanceof SSEServerTransport)) {
    res.status(400).send("No SSE transport found for sessionId");
    return;
  }
  await existingTransport.handlePostMessage(req, res, req.body);
});

async function shutdown() {
  for (const [sessionId, transport] of Object.entries(transports)) {
    await transport.close().catch(() => undefined);
    delete transports[sessionId];
  }
  for (const [sessionId, server] of Object.entries(servers)) {
    await server.close().catch(() => undefined);
    delete servers[sessionId];
  }
  await sharedManager.close().catch(() => undefined);
  await new Promise((resolveClose) => httpServer?.close(() => resolveClose()));
  process.exit(0);
}

httpServer = app.listen(options.port, options.host, () => {
  console.error(`mcp-patchright listening on http://${options.host}:${options.port}`);
  console.error(`  SSE:        http://${options.host}:${options.port}/sse`);
  console.error(`  Streamable: http://${options.host}:${options.port}/mcp`);
});
httpServer.on("error", (error) => {
  console.error("mcp-patchright HTTP server error:", error);
  process.exit(1);
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
