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

import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { migrateLegacyCompactedConversations } from "@negotium/core/conversation-migration";
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
  reapOrphanBrowsers,
  reconcilePendingAskUserQuestionGates,
  resolveCuaRsBinary,
  runNodeRequestHandlers,
  runShutdown,
  runtimeBus,
  STATE_DIR,
  type StartedNegotiumNodeModules,
  setCuaRsMcpPort,
  setFileHooks,
  setNodeMcpServers,
  setRuntimeMcpPort,
  startAskUserQuestionGateOwner,
  startBashrsCompletionsWorker,
  startDurableTurnRequestWorker,
  startNegotiumNodeModules,
  startSessionInboxWorker,
  stopAskUserQuestionGateOwner,
  sweepStaleSubagentCards,
  WORKSPACE_DIR,
} from "@negotium/core/node-host";
import { closeNegotiumMcpSessions, handleNegotiumMcpRequest } from "@negotium/mcp";
import { McpHost, McpManifest, type McpServerSpec } from "@negotium/mcp-host";
import {
  createNodeControlHandler,
  NODE_CONTROL_PROTOCOL_VERSION,
  NODE_DAEMON_ROLE,
  removeNodeDaemonInfo,
  writeNodeDaemonInfo,
} from "./control";
import { nodeFileStore } from "./files";
import { runSingletonStartupMaintenance } from "./startup-maintenance";

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
export { NodeFileStore, nodeFileStore } from "./files";

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
 * A pinned node port for single-node workstations. When set to a valid
 * 1-65535 integer, `startDefaultNode` binds that port instead of asking the
 * kernel for an ephemeral one whenever `port: 0` is passed (which is the
 * default for every detached `__node-daemon` spawn). Invalid or empty values
 * fall back to ephemeral allocation. 0 is intentionally not a valid override
 * so it can never shadow the "auto" signal.
 */
function readFixedNodePort(): number | undefined {
  const raw = process.env.NEGOTIUM_NODE_PORT;
  if (raw === undefined || raw === "") return undefined;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
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

const CUA_RS_MCP_KEY = "cua-rs";
const CUA_RS_MCP_MANIFEST_FILE = "cua-rs-mcp-manifest.json";
/** Bearer token for cua-rs /mcp, kept beside the manifest. See `cuaRsToken`. */
const CUA_RS_MCP_TOKEN_FILE = "cua-rs-mcp.token";
const CUA_RS_MCP_PORT_RANGE = { base: 9350, max: 9399 };

type CuaRsMcpHost = {
  host: McpHost;
  stopSweeper: () => void;
};

/**
 * The bearer token cua-rs 0.8.0 wants on /mcp, persisted across node restarts.
 *
 * Pinned by the node rather than generated by the server, because a generated
 * token is only printed to the child's stderr and the node needs the value in
 * hand to put it in the config a turn receives.
 *
 * Persisted rather than fresh per start, which was the first attempt and was
 * wrong: `McpHost.ensure` adopts an already-running process across a node
 * restart, via the port file it left behind. A new random token then belonged to
 * nobody — the adopted child had been started with a different one — and every
 * desktop tool answered 401. A token on disk is the same token the adopted
 * process was started with, so adoption keeps working.
 */
function cuaRsToken(): string {
  const file = join(RUN_DIR, CUA_RS_MCP_TOKEN_FILE);
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // Absent or unreadable: write a new one below.
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * Whether cua-rs on `port` accepts `token`.
 *
 * Any answer other than 401 counts: the request is deliberately malformed JSON-RPC
 * so the server rejects it on content, and what is being tested is only whether it
 * got past the auth layer first.
 */
async function cuaRsAuthOk(port: number, token: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{}",
      signal: AbortSignal.timeout(2_000),
    });
    return res.status !== 401;
  } catch {
    // Unreachable is not an auth verdict; leave it to the health machinery.
    return true;
  }
}

/**
 * Start cua-rs as a node-owned HTTP service. Its dedicated manifest is
 * transient node runtime state, not the user-managed `negotium mcp` manifest.
 */
async function wireCuaRsMcp(): Promise<CuaRsMcpHost | undefined> {
  setCuaRsMcpPort(undefined);
  const binary = resolveCuaRsBinary();
  if (!binary) return undefined;

  const manifestFile = join(RUN_DIR, CUA_RS_MCP_MANIFEST_FILE);
  // This manifest is generated from the currently resolved binary. Removing a
  // stale copy lets an upgraded binary take effect on the next node start.
  rmSync(manifestFile, { force: true });
  const manifest = new McpManifest({ file: manifestFile });
  const token = cuaRsToken();
  const spec: McpServerSpec = {
    key: CUA_RS_MCP_KEY,
    transport: "http",
    command: binary,
    args: ["{port}"],
    env: { CUA_HTTP_TOKEN: token },
    portRange: CUA_RS_MCP_PORT_RANGE,
    scope: "node",
    healthIntervalMs: 15_000,
  };
  manifest.add(spec);

  const host = new McpHost({ manifest });
  const stopSweeper = host.startSweeper();
  try {
    let instance = await host.ensure(CUA_RS_MCP_KEY);
    if (!instance.port) throw new Error("cua-rs started without an HTTP port");
    // An adopted process started before this token existed -- by a node that
    // predates the token, or with a file since replaced -- will never accept it,
    // and the failure is invisible until a turn tries a tool and gets 401. One
    // request settles it, and stopping the instance makes `ensure` spawn a child
    // that receives the token through its environment.
    if (!(await cuaRsAuthOk(instance.port, token))) {
      logger.warn({ port: instance.port }, "cua-rs rejected the node's token; restarting it");
      await host.stop(CUA_RS_MCP_KEY);
      instance = await host.ensure(CUA_RS_MCP_KEY);
      if (!instance.port) throw new Error("cua-rs restarted without an HTTP port");
      if (!(await cuaRsAuthOk(instance.port, token))) {
        throw new Error("cua-rs will not accept the node's bearer token");
      }
    }
    setCuaRsMcpPort(instance.port, token);
    logger.info({ pid: instance.pid, port: instance.port }, "cua-rs MCP server ready");
    return { host, stopSweeper };
  } catch (error) {
    stopSweeper();
    await host.stopAll();
    setCuaRsMcpPort(undefined);
    logger.warn({ err: error }, "cua-rs MCP server unavailable");
    return undefined;
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
  try {
    if (opts.singleton) {
      // The lease makes this process the sole authority over the shared
      // profile tree. Reap browsers the previous daemon lost before serving
      // any turn instead of waiting for the periodic janitor interval.
      runSingletonStartupMaintenance({
        reapBrowsers: reapOrphanBrowsers,
        migrateConversations: migrateLegacyCompactedConversations,
      });
    }
    startAskUserQuestionGateOwner();
    reconcilePendingAskUserQuestionGates();
  } catch (error) {
    processLease?.stop();
    stopAskUserQuestionGateOwner();
    throw error;
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
    stopAskUserQuestionGateOwner();
    throw error;
  }
  const port = server.port;
  if (!port) {
    processLease?.stop();
    stopAskUserQuestionGateOwner();
    throw new Error("negotium node failed to bind a port");
  }
  setRuntimeMcpPort(port);
  const stopTurnRequests = startDurableTurnRequestWorker();
  const stopInbox = startSessionInboxWorker();
  // bash-rs only writes result.json; this watcher is the sole path that
  // turns a finished background job into the turn the caller was promised.
  const stopBashrsCompletions = startBashrsCompletionsWorker();
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
    stopBashrsCompletions();
    server.stop(true);
    processLease?.stop();
    stopAskUserQuestionGateOwner();
    throw error;
  }

  // Node-assigned MCPs come up in the background — turns that start before
  // they're ready simply run without them for that turn.
  const mcpHost = new McpHost();
  const manifest = new McpManifest();
  const stopSweeper = mcpHost.startSweeper();
  const cuaRsMcp = wireCuaRsMcp();

  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  let advertised: ReturnType<typeof writeNodeDaemonInfo> | null = null;
  try {
    advertised = opts.advertise ? writeNodeDaemonInfo(port, startedAt) : null;
  } catch (error) {
    stopSweeper();
    setCuaRsMcpPort(undefined);
    void cuaRsMcp.then(async (managed) => {
      managed?.stopSweeper();
      await managed?.host.stopAll();
    });
    stopTurnRequests();
    stopInbox();
    stopBashrsCompletions();
    server.stop(true);
    processLease?.stop();
    stopAskUserQuestionGateOwner();
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
    stopBashrsCompletions();
    server.stop(true);
  });
  if (advertised) {
    onShutdown("node-daemon-advertisement", 129, () => {
      removeNodeDaemonInfo({ pid: advertised.pid, port: advertised.port });
    });
  }
  if (processLease) onShutdown("node-daemon-lease", 128, () => processLease.stop());
  onShutdown("runtime-mcp-sessions", 125, closeNegotiumMcpSessions);
  onShutdown("active-agent-turns", 120, async () => {
    abortAllRooms();
    await killOwnedCodexTreesForShutdown();
  });
  onShutdown("ask-user-gate-owner", 119, stopAskUserQuestionGateOwner);
  onShutdown("node-modules", 110, () => modules.stop());
  onShutdown("node-mcp-host", 50, async () => {
    stopSweeper();
    await mcpHost.stopAll();
  });
  onShutdown("cua-rs-mcp-host", 50, async () => {
    setCuaRsMcpPort(undefined);
    const managed = await cuaRsMcp;
    managed?.stopSweeper();
    await managed?.host.stopAll();
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
  const port =
    opts.port === 0 ? (readFixedNodePort() ?? (await availableLoopbackPort())) : opts.port;
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
