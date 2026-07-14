/**
 * Node bootstrap shared by `negotium chat` and `negotium serve`.
 *
 * Starting a node means: bind the single open port (runtime MCP endpoint),
 * tell core which port agents should dial back to, start the session-inbox
 * consumer that drains ask/tell/abort queues, bring up the node's assigned
 * MCP servers (manifest → running instances → agent turn catalog), and
 * register shutdown cleanup so agent/browser/bash children never outlive the
 * node. External integrations mount extra routes on the same port through
 * core's registerNodeRequestHandler (plugin chain ahead of the MCP handler).
 */

import {
  abortAllRooms,
  DATA_DIR,
  killAllBgBash,
  killAllPlaywright,
  killOwnedCodexTreesForShutdown,
  logger,
  NEGOTIUM_PORT,
  type NegotiumNodeModule,
  type NodeMcpEntry,
  nodeRequestHandlerNames,
  onShutdown,
  RUN_DIR,
  runNodeRequestHandlers,
  runShutdown,
  runtimeBus,
  STATE_DIR,
  type StartedNegotiumNodeModules,
  setNodeMcpServers,
  setRuntimeMcpPort,
  startNegotiumNodeModules,
  startSessionInboxWorker,
  sweepStaleSubagentCards,
  WORKSPACE_DIR,
} from "@negotium/core";
import { handleNegotiumMcpRequest } from "@negotium/mcp";
import { McpHost, McpManifest } from "@negotium/mcp-host";

export interface NodeHandle {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Resolve the node's MCP manifest into live servers and install them into the
 * agent-turn catalog. Long-lived http servers are ensured (spawned + port
 * allocated) via mcp-host; stdio specs pass through as launch commands.
 * Best-effort per entry — one broken server must not block the node.
 */
async function wireNodeMcps(host: McpHost, manifest: McpManifest): Promise<void> {
  const entries: NodeMcpEntry[] = [];
  for (const spec of manifest.list()) {
    if (!manifest.isEnabled(spec.key)) continue;
    try {
      if (spec.transport === "http") {
        const instance = await host.ensure(spec.key);
        if (!instance.port) throw new Error("no port allocated");
        entries.push({ key: spec.key, kind: "http", port: instance.port });
      } else {
        entries.push({
          key: spec.key,
          kind: "stdio",
          command: spec.command,
          args: spec.args,
          ...(spec.env ? { env: spec.env } : {}),
        });
      }
    } catch (err) {
      logger.warn({ err, key: spec.key }, "node mcp: failed to bring up manifest server");
    }
  }
  setNodeMcpServers(entries);
  if (entries.length > 0) {
    logger.info({ keys: entries.map((e) => e.key) }, "node mcp: manifest servers installed");
  }
}

export function startNode(
  opts: { port?: number; modules?: readonly NegotiumNodeModule[] } = {},
): NodeHandle {
  sweepStaleSubagentCards();
  const server = Bun.serve({
    port: opts.port ?? NEGOTIUM_PORT,
    hostname: "127.0.0.1",
    idleTimeout: 240,
    async fetch(req) {
      // External integrations (otium worker, future peers, webhooks) mount
      // ahead of the built-in routes via registerNodeRequestHandler.
      const plugin = await runNodeRequestHandlers(req);
      if (plugin) return plugin;
      const mcp = await handleNegotiumMcpRequest(req);
      if (mcp) return mcp;
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ ok: true, name: "negotium", stateDir: STATE_DIR });
      }
      return new Response("negotium node", { status: 404 });
    },
  });
  const port = server.port;
  if (!port) throw new Error("negotium node failed to bind a port");
  setRuntimeMcpPort(port);
  const stopInbox = startSessionInboxWorker();
  let modules: StartedNegotiumNodeModules;
  try {
    modules = startNegotiumNodeModules(opts.modules ?? [], {
      port,
      stateDir: STATE_DIR,
      dataDir: DATA_DIR,
      runDir: RUN_DIR,
      workspaceDir: WORKSPACE_DIR,
      bus: runtimeBus(),
    });
  } catch (error) {
    stopInbox();
    server.stop(true);
    throw error;
  }

  // Node-assigned MCPs come up in the background — turns that start before
  // they're ready simply run without them for that turn.
  const mcpHost = new McpHost();
  const manifest = new McpManifest();
  const stopSweeper = mcpHost.startSweeper();
  void wireNodeMcps(mcpHost, manifest);

  // Priority convention (see core lifecycle.ts): 100 = graceful
  // network/queue closes, 50 = external-process reapers.
  onShutdown("node-server", 130, () => {
    stopInbox();
    server.stop(true);
  });
  onShutdown("active-agent-turns", 120, async () => {
    abortAllRooms();
    await killOwnedCodexTreesForShutdown();
  });
  onShutdown("node-modules", 110, () => modules.stop());
  onShutdown("node-mcp-host", 50, async () => {
    stopSweeper();
    await mcpHost.stopAll();
  });
  onShutdown("playwright", 50, () => killAllPlaywright());
  onShutdown("background-bash", 50, () => killAllBgBash());

  logger.info(
    {
      port,
      stateDir: STATE_DIR,
      plugins: nodeRequestHandlerNames(),
      modules: modules.names,
      capabilities: modules.capabilities,
    },
    "negotium node started",
  );

  return {
    port,
    // Manual stop routes through the same registry as SIGINT/SIGTERM so
    // cleanup never diverges between the two paths (idempotent once-guard).
    stop: () => runShutdown("test"),
  };
}

/** Reference-host composition. Disabled modules are never imported. */
export async function startDefaultNode(opts: { port?: number } = {}): Promise<NodeHandle> {
  const modules: NegotiumNodeModule[] = [];
  if (process.env.NEGOTIUM_CRON !== "0") {
    const { createCronModule } = await import("@negotium/module-cron");
    modules.push(createCronModule());
  }
  return startNode({ ...opts, modules });
}
