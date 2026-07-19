#!/usr/bin/env node
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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
import {
  secureBrowserToolCatalog,
  secureBrowserToolInput,
  secureBrowserToolOutput,
} from "./browser-passkey-policy.mjs";
import { createBrowserVaultTransforms } from "./browser-vault-transform.mjs";

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

const vaultTransforms = await createBrowserVaultTransforms(
  process.env.NEGOTIUM_BROWSER_VAULT_USER_ID,
);
const exposedTools = secureBrowserToolCatalog(tools);

function createMcpServer(defaultStartOptions, sharedManager, owner) {
  const server = new Server(
    { name: "mcp-patchright", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  const manager = sharedManager ?? new BrowserManager(defaultStartOptions);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const toolName = request.params.name;
      const toolInput = secureBrowserToolInput(
        toolName,
        vaultTransforms.substitute(request.params.arguments ?? {}),
      );
      const result = await manager.runAsOwner(owner, () =>
        handleTool(manager, toolName, toolInput),
      );
      return vaultTransforms.redact(secureBrowserToolOutput(toolName, result));
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return {
        content: [
          {
            type: "text",
            text: vaultTransforms.redact(message),
          },
        ],
        isError: true,
      };
    }
  });
  return server;
}

function requestOwner(req) {
  const owner = req.header("x-browser-owner");
  if (!owner || owner.length > 256) return undefined;
  return owner;
}

function sseRequestOwner(req) {
  const owner = requestOwner(req) ?? (typeof req.query.owner === "string" ? req.query.owner : "");
  if (!owner || owner.length > 256) return undefined;
  return owner;
}

const expectedCapability = process.env.NEGOTIUM_BROWSER_CAPABILITY;
if (!expectedCapability) throw new Error("NEGOTIUM_BROWSER_CAPABILITY is required");

function safeCapabilityEqual(provided, expectedValue) {
  if (!provided) return false;
  const actual = Buffer.from(provided);
  const expected = Buffer.from(expectedValue);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hasCapability(req) {
  const provided = req.header("x-browser-capability");
  return safeCapabilityEqual(provided, expectedCapability);
}

function hasOwnerCapability(req, owner) {
  const expected = createHmac("sha256", expectedCapability).update(owner).digest("hex");
  return safeCapabilityEqual(req.header("x-browser-capability"), expected);
}

function requireCapability(req, res) {
  if (hasCapability(req)) return true;
  res.status(401).json({ ok: false, error: "invalid browser capability" });
  return false;
}

function requireOwnerCapability(req, res, owner) {
  const queryCapability =
    req.path === "/sse" && typeof req.query.capability === "string"
      ? req.query.capability
      : undefined;
  const expected = createHmac("sha256", expectedCapability).update(owner).digest("hex");
  if (hasOwnerCapability(req, owner) || safeCapabilityEqual(queryCapability, expected)) return true;
  res.status(401).json({ ok: false, error: "invalid browser owner capability" });
  return false;
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
const sessionOwners = {};
const sseTransports = {};
const sseServers = {};
const sseMessageTokens = {};
let httpServer;

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "mcp-patchright",
  });
});

// Claude Code and Maestro use the legacy two-endpoint SSE transport. The
// initial connection is authenticated with the owner capability. A fresh,
// per-session token embedded in the advertised message endpoint prevents
// another loopback process from injecting JSON-RPC messages by session ID.
app.get("/sse", async (req, res) => {
  const owner = sseRequestOwner(req);
  if (!owner) {
    res.status(400).json({ ok: false, error: "browser owner is required in SSE mode" });
    return;
  }
  if (!requireOwnerCapability(req, res, owner)) return;

  const messageToken = randomBytes(32).toString("hex");
  const transport = new SSEServerTransport(
    `/message?token=${encodeURIComponent(messageToken)}`,
    res,
  );
  const server = createMcpServer(defaultStartOptions, sharedManager, owner);
  sseTransports[transport.sessionId] = transport;
  sseServers[transport.sessionId] = server;
  sseMessageTokens[transport.sessionId] = messageToken;
  transport.onclose = () => {
    const sessionId = transport.sessionId;
    delete sseTransports[sessionId];
    delete sseMessageTokens[sessionId];
    const managedServer = sseServers[sessionId];
    delete sseServers[sessionId];
    void managedServer?.close().catch(() => undefined);
  };
  await server.connect(transport);
});

app.post("/message", async (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
  const messageToken = typeof req.query.token === "string" ? req.query.token : "";
  const transport = sseTransports[sessionId];
  const expectedMessageToken = sseMessageTokens[sessionId];
  if (!transport) {
    res.status(404).send("SSE session not found");
    return;
  }
  if (!expectedMessageToken || !safeCapabilityEqual(messageToken, expectedMessageToken)) {
    res.status(401).send("invalid SSE message token");
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

app.all("/mcp", async (req, res) => {
  try {
    const owner = requestOwner(req);
    if (!owner) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32600, message: "browser owner is required in HTTP mode" },
        id: null,
      });
      return;
    }
    if (!requireOwnerCapability(req, res, owner)) return;
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
      if (sessionOwners[normalizedSessionId] !== owner) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Browser owner does not match this session" },
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
          sessionOwners[newSessionId] = owner;
        },
      });
      server = createMcpServer(defaultStartOptions, sharedManager, owner);
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) {
          delete transports[sid];
          delete sessionOwners[sid];
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

app.delete("/owners", async (req, res) => {
  if (!requireCapability(req, res)) return;
  const owner = requestOwner(req);
  if (!owner) {
    res.status(400).json({ ok: false, error: "owner is required" });
    return;
  }
  const closed = await sharedManager.closeOwnerPages(owner);
  res.json({ ok: true, owner, closed });
});

async function shutdown() {
  for (const [sessionId, transport] of Object.entries(sseTransports)) {
    await transport.close().catch(() => undefined);
    delete sseTransports[sessionId];
    delete sseMessageTokens[sessionId];
  }
  for (const [sessionId, server] of Object.entries(sseServers)) {
    await server.close().catch(() => undefined);
    delete sseServers[sessionId];
  }
  for (const [sessionId, transport] of Object.entries(transports)) {
    await transport.close().catch(() => undefined);
    delete transports[sessionId];
    delete sessionOwners[sessionId];
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
