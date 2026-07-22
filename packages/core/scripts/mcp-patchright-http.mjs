#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
import {
  createBrowserVaultTransforms,
  prepareBrowserToolInputForRedaction,
} from "./browser-vault-transform.mjs";
import { createBrowserWebAuthnGuard } from "./browser-webauthn-policy.mjs";

const expectedCapability = process.env.NEGOTIUM_BROWSER_CAPABILITY;
if (!expectedCapability) throw new Error("NEGOTIUM_BROWSER_CAPABILITY is required");
const browserRsCapability = randomBytes(32).toString("hex");

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

async function allocateLoopbackPort() {
  const server = createNetServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate backend port");
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

function browserRsUrl(port, owner) {
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  url.searchParams.set("owner", owner);
  return url;
}

async function connectBrowserRs(port, owner, capability) {
  const client = new Client({ name: "negotium-browser-gateway", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(browserRsUrl(port, owner), {
    requestInit: { headers: { "X-Browser-Capability": capability } },
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function waitForBrowserRs(port, child, capability, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null && !child.killed) {
    let client;
    try {
      client = await connectBrowserRs(port, "__negotium_gateway_probe__", capability);
      const result = await client.listTools();
      if (result.tools.length > 0) return true;
    } catch {
      // Browser.rs may still be binding its HTTP listener.
    } finally {
      await client?.close().catch(() => undefined);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return false;
}

async function startBrowserRs(options, capability) {
  const binary = process.env.NEGOTIUM_BROWSER_RS_BIN?.trim();
  if (!binary) return undefined;
  // The Browser.rs integration does not yet accept Negotium's authenticated
  // egress proxy configuration. Preserve proxy credentials and routing by
  // selecting the Patchright backend whenever proxying is enabled.
  if (process.env.NEGOTIUM_BROWSER_PROXY_SERVER) {
    console.error("Browser.rs skipped because a browser egress proxy is configured");
    return undefined;
  }

  const port = await allocateLoopbackPort();
  const args = ["--host", "127.0.0.1", "--port", String(port)];
  if (options.userDataDir) args.push("--user-data-dir", options.userDataDir);
  args.push(options.headless ? "--headless" : "--headed");
  // Browser.rs needs OS/session details to launch Chrome, but it must not
  // inherit unrelated API keys or Vault credentials from the Negotium host.
  const childEnv = { AB_HTTP_CAPABILITY: capability };
  for (const key of [
    "HOME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "AB_CHROME",
    "AB_CONNECT",
    "RUST_LOG",
    "RUST_BACKTRACE",
  ]) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  const child = spawn(binary, args, {
    stdio: "ignore",
    env: childEnv,
  });
  const spawnFailed = new Promise((resolveFailure) =>
    child.once("error", () => resolveFailure(false)),
  );
  const ready = await Promise.race([waitForBrowserRs(port, child, capability), spawnFailed]);
  if (!ready) {
    child.kill("SIGTERM");
    console.error("Browser.rs failed startup validation; using Patchright fallback");
    return undefined;
  }
  return { child, port };
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
const patchrightExposedTools = secureBrowserToolCatalog(tools);
const webAuthnGuard = createBrowserWebAuthnGuard();
const options = parseCli();
let browserRsBackend = await startBrowserRs(options, browserRsCapability).catch((error) => {
  console.error(`Browser.rs startup failed; using Patchright fallback: ${error}`);
  return undefined;
});
const browserRsClients = new Set();
let shuttingDown = false;

function disableBrowserRs(reason) {
  const backend = browserRsBackend;
  if (!backend) return;
  browserRsBackend = undefined;
  console.error(`Browser.rs backend unavailable (${reason}); switching to Patchright`);
  for (const client of browserRsClients) void client.close().catch(() => undefined);
  browserRsClients.clear();
  if (backend.child.exitCode === null && !backend.child.killed) backend.child.kill("SIGTERM");
}

if (browserRsBackend) {
  browserRsBackend.child.once("error", (error) =>
    disableBrowserRs(`spawn error: ${error.message}`),
  );
  browserRsBackend.child.once("exit", (code, signal) => {
    if (!shuttingDown) disableBrowserRs(`exit code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
}

function createMcpServer(defaultStartOptions, sharedManager, owner) {
  const server = new Server(
    { name: "negotium-browser-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const manager = sharedManager ?? new BrowserManager(defaultStartOptions);
  const callPatchrightTool = (toolName, toolInput) =>
    manager.runAsOwner(owner, async () => {
      await webAuthnGuard.beforeTool(toolName, manager);
      const toolResult = await handleTool(manager, toolName, toolInput);
      await webAuthnGuard.afterTool(toolName, manager);
      return toolResult;
    });
  let upstreamClientPromise;
  const upstreamClient = async () => {
    if (!browserRsBackend) return undefined;
    upstreamClientPromise ??= connectBrowserRs(
      browserRsBackend.port,
      owner,
      browserRsCapability,
    ).then((client) => {
      browserRsClients.add(client);
      return client;
    });
    return upstreamClientPromise;
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const client = await upstreamClient();
    if (!client) return { tools: patchrightExposedTools };
    try {
      const result = await client.listTools();
      return { tools: secureBrowserToolCatalog(result.tools) };
    } catch (error) {
      disableBrowserRs(error instanceof Error ? error.message : String(error));
      return { tools: patchrightExposedTools };
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    let boundary;
    try {
      const toolName = request.params.name;
      const securedInput = secureBrowserToolInput(
        toolName,
        vaultTransforms.substitute(request.params.arguments ?? {}),
        owner,
      );
      const prepared = prepareBrowserToolInputForRedaction(toolName, securedInput);
      const toolInput = prepared.input;
      boundary = prepared.boundary;
      const client = await upstreamClient();
      let result;
      if (client) {
        try {
          result = await client.callTool({ name: toolName, arguments: toolInput });
        } catch (error) {
          // `isError` tool results are returned normally; an exception here is
          // a transport/protocol failure. Retire the unhealthy backend and
          // retry this call once through the policy-equivalent fallback.
          disableBrowserRs(error instanceof Error ? error.message : String(error));
          result = await callPatchrightTool(toolName, toolInput);
        }
      } else {
        result = await callPatchrightTool(toolName, toolInput);
      }
      return vaultTransforms.postprocess(secureBrowserToolOutput(toolName, result), boundary);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return vaultTransforms.postprocess(
        {
          content: [
            {
              type: "text",
              text: message,
            },
          ],
          isError: true,
        },
        boundary,
      );
    }
  });
  const closeServer = server.close.bind(server);
  server.close = async () => {
    const client = await upstreamClientPromise?.catch(() => undefined);
    if (client) {
      browserRsClients.delete(client);
      await client.close().catch(() => undefined);
    }
    return closeServer();
  };
  return server;
}

function requestOwner(req, allowQuery = false) {
  const owner =
    req.header("x-browser-owner") ??
    (allowQuery && typeof req.query.owner === "string" ? req.query.owner : undefined);
  if (!owner || owner.length > 256) return undefined;
  return owner;
}

function sseRequestOwner(req) {
  const owner = requestOwner(req) ?? (typeof req.query.owner === "string" ? req.query.owner : "");
  if (!owner || owner.length > 256) return undefined;
  return owner;
}

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
  if (hasOwnerCapability(req, owner)) return true;
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
    name: "negotium-browser-gateway",
    backend: browserRsBackend ? "browser-rs" : "mcp-patchright",
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
    const owner = requestOwner(req, true);
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
  const owner = requestOwner(req, true);
  if (!owner) {
    res.status(400).json({ ok: false, error: "owner is required" });
    return;
  }
  let closed;
  if (browserRsBackend) {
    const url = new URL(`http://127.0.0.1:${browserRsBackend.port}/owners`);
    url.searchParams.set("owner", owner);
    const response = await fetch(url, {
      method: "DELETE",
      headers: { "X-Browser-Capability": browserRsCapability },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      res
        .status(502)
        .json({ ok: false, error: `Browser.rs owner cleanup failed (${response.status})` });
      return;
    }
    const result = await response.json();
    closed = typeof result.closed === "number" ? result.closed : 0;
  } else {
    closed = await sharedManager.closeOwnerPages(owner);
  }
  res.json({ ok: true, owner, closed });
});

async function shutdown() {
  shuttingDown = true;
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
  for (const client of browserRsClients) await client.close().catch(() => undefined);
  browserRsClients.clear();
  if (browserRsBackend?.child.exitCode === null && !browserRsBackend.child.killed) {
    browserRsBackend.child.kill("SIGTERM");
  }
  await sharedManager.close().catch(() => undefined);
  await new Promise((resolveClose) => httpServer?.close(() => resolveClose()));
  process.exit(0);
}

httpServer = app.listen(options.port, options.host, () => {
  console.error(
    `negotium browser gateway (${browserRsBackend ? "browser-rs" : "mcp-patchright"}) listening on http://${options.host}:${options.port}`,
  );
  console.error(`  SSE:        http://${options.host}:${options.port}/sse`);
  console.error(`  Streamable: http://${options.host}:${options.port}/mcp`);
});
httpServer.on("error", (error) => {
  console.error("mcp-patchright HTTP server error:", error);
  process.exit(1);
});

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
