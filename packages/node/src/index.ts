/**
 * Node bootstrap shared by Terminal, adapters, and `negotium serve`.
 *
 * Starting a node means: bind the single open port (runtime MCP endpoint),
 * tell core which port agents should dial back to, start the session-inbox
 * consumer that drains ask/tell/abort queues, bring up the node's assigned
 * MCP servers (manifest → running instances → agent turn catalog), and
 * register shutdown cleanup so agent/browser/bash children never outlive the
 * node. External integrations mount extra routes on the same port through
 * core's registerNodeRequestHandler (plugin chain ahead of the MCP handler).
 */

import { createServer } from "node:net";
import {
  abortAllRooms,
  acquireRuntimeProcessLease,
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
  setFileHooks,
  setNodeMcpServers,
  setRuntimeMcpPort,
  startDurableTurnRequestWorker,
  startNegotiumNodeModules,
  startSessionInboxWorker,
  sweepStaleSubagentCards,
  WORKSPACE_DIR,
} from "@negotium/core";
import { handleNegotiumMcpRequest } from "@negotium/mcp";
import { McpHost, McpManifest } from "@negotium/mcp-host";
import {
  createNodeControlHandler,
  NODE_CONTROL_PROTOCOL_VERSION,
  NODE_DAEMON_ROLE,
  removeNodeDaemonInfo,
  writeNodeDaemonInfo,
} from "./control";
import { nodeFileStore } from "./files";

export type {
  NodeDaemonConnection,
  NodeDaemonInfo,
  NodeDaemonStatus,
} from "./control";
export {
  inspectNodeDaemon,
  NODE_CONTROL_BASE_PATH,
  NODE_CONTROL_PROTOCOL_VERSION,
  NODE_DAEMON_INFO_PATH,
  NODE_RUNTIME_CONTRACT_BASE_PATH,
  NODE_RUNTIME_CONTRACT_VERSION,
  readNodeDaemonInfo,
  stopNodeDaemon,
  waitForNodeDaemon,
} from "./control";

export interface NodeHandle {
  port: number;
  /** Settles after every registered node cleanup handler has completed. */
  completed: Promise<void>;
  stop: () => Promise<void>;
}

export interface StartNodeOptions {
  port?: number;
  /** Reject request bodies above this size before route handlers parse them. */
  maxRequestBodySize?: number;
  modules?: readonly NegotiumNodeModule[];
  /** Publish this node as the state directory's client-connectable process. */
  advertise?: boolean;
  /** Refuse to start while another healthy node owns this state directory. */
  singleton?: boolean;
}

async function availableLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error("failed to allocate a loopback port"));
      });
    });
  });
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

export function startNode(opts: StartNodeOptions = {}): NodeHandle {
  sweepStaleSubagentCards();
  setFileHooks(nodeFileStore.hooks);
  const startedAt = new Date().toISOString();
  const processLease = opts.singleton
    ? acquireRuntimeProcessLease(NODE_DAEMON_ROLE, {
        onLost: () => {
          logger.error("node daemon: singleton lease lost; shutting down");
          void runShutdown("test");
        },
      })
    : null;
  if (opts.singleton && !processLease) {
    throw new Error(`a Negotium node is already running for ${STATE_DIR}`);
  }

  let requestStop = () => {
    void runShutdown("test");
  };
  let server: ReturnType<typeof Bun.serve>;
  const control = createNodeControlHandler({
    port: () => server?.port ?? 0,
    startedAt,
    requestShutdown: () => requestStop(),
  });
  try {
    server = Bun.serve({
      port: opts.port ?? NEGOTIUM_PORT,
      hostname: "127.0.0.1",
      idleTimeout: 240,
      ...(opts.maxRequestBodySize ? { maxRequestBodySize: opts.maxRequestBodySize } : {}),
      async fetch(req) {
        const controlResponse = await control(req);
        if (controlResponse) return controlResponse;
        // External integrations (otium worker, future peers, webhooks) mount
        // ahead of the built-in routes via registerNodeRequestHandler.
        const plugin = await runNodeRequestHandlers(req);
        if (plugin) return plugin;
        const mcp = await handleNegotiumMcpRequest(req);
        if (mcp) return mcp;
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return Response.json({
            ok: true,
            name: "negotium",
            pid: process.pid,
            protocolVersion: NODE_CONTROL_PROTOCOL_VERSION,
            stateDir: STATE_DIR,
          });
        }
        return new Response("negotium node", { status: 404 });
      },
    });
  } catch (error) {
    processLease?.stop();
    throw error;
  }
  const port = server.port;
  if (!port) {
    processLease?.stop();
    throw new Error("negotium node failed to bind a port");
  }
  setRuntimeMcpPort(port);
  const stopTurnRequests = startDurableTurnRequestWorker();
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
    stopTurnRequests();
    stopInbox();
    server.stop(true);
    processLease?.stop();
    throw error;
  }

  // Node-assigned MCPs come up in the background — turns that start before
  // they're ready simply run without them for that turn.
  const mcpHost = new McpHost();
  const manifest = new McpManifest();
  const stopSweeper = mcpHost.startSweeper();

  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  let advertised: ReturnType<typeof writeNodeDaemonInfo> | null = null;
  try {
    advertised = opts.advertise ? writeNodeDaemonInfo(port, startedAt) : null;
  } catch (error) {
    stopSweeper();
    stopTurnRequests();
    stopInbox();
    server.stop(true);
    processLease?.stop();
    void modules.stop();
    void mcpHost.stopAll();
    throw error;
  }
  void wireNodeMcps(mcpHost, manifest);

  // Priority convention (see core lifecycle.ts): 100 = graceful
  // network/queue closes, 50 = external-process reapers.
  onShutdown("node-server", 130, () => {
    stopTurnRequests();
    stopInbox();
    server.stop(true);
  });
  if (advertised) {
    onShutdown("node-daemon-advertisement", 129, () => {
      removeNodeDaemonInfo({ pid: advertised.pid, port: advertised.port });
    });
  }
  if (processLease) onShutdown("node-daemon-lease", 128, () => processLease.stop());
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
  onShutdown("node-completed", -100, resolveCompleted);

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

  const stop = () => runShutdown("test");
  requestStop = () => {
    void stop();
  };
  return {
    port,
    completed,
    // Manual stop routes through the same registry as SIGINT/SIGTERM so
    // cleanup never diverges between the two paths (idempotent once-guard).
    stop,
  };
}

/** Reference-host composition. Disabled modules are never imported. */
export async function startDefaultNode(
  opts: Omit<StartNodeOptions, "modules"> = {},
): Promise<NodeHandle> {
  const modules: NegotiumNodeModule[] = [];
  if (process.env.NEGOTIUM_CRON !== "0") {
    const { createCronModule } = await import("@negotium/module-cron");
    modules.push(createCronModule());
  }
  const port = opts.port === 0 ? await availableLoopbackPort() : opts.port;
  return startNode({ ...opts, port, modules });
}

/** Long-lived local node entry used by the CLI's detached child process. */
export async function runNodeDaemon(
  opts: { port?: number; maxRequestBodySize?: number } = {},
): Promise<void> {
  const node = await startDefaultNode({
    port: opts.port ?? 0,
    ...(opts.maxRequestBodySize ? { maxRequestBodySize: opts.maxRequestBodySize } : {}),
    advertise: true,
    singleton: true,
  });
  await node.completed;

  // This entrypoint owns the whole process. Shutdown handlers have completed,
  // so do not rely on every imported adapter/database/socket to release its
  // final Bun handle before the process can disappear. A former singleton that
  // remains half-alive can still run module-level timers and interfere with the
  // replacement daemon.
  await new Promise<void>((resolve) => setImmediate(resolve));
  process.exit(0);
}
