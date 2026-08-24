import {
  logger,
  NEGOTIUM_VERSION,
  NODE_CONTROL_TOKEN,
  onShutdown,
  runShutdown,
  waitForRequiredRuntimeProcessLease,
} from "@negotium/core";
import { inspectNodeDaemon } from "@negotium/node";
import {
  OTIUM_ADAPTER_CONTROL_HEADER,
  OTIUM_ADAPTER_CONTROL_PREFIX,
  OTIUM_RELAYED_HEADER,
} from "@/control-protocol";
import { loadJoins, type OtiumJoin } from "@/join";
import { MAX_PEER_REQUEST_BODY_BYTES } from "@/protocol";
import { TunnelClient, type TunnelLogger } from "@/tunnel-client";

export interface OtiumSidecarOptions {
  port: number;
  relayUrl?: string;
}

/** Stamp every log line from one workspace's tunnel with its cell id, so a
 *  multi-workspace host's reconnect warnings say *which* cell is unreachable
 *  instead of reading as one undifferentiated stream. */
function withCellId(base: TunnelLogger, cellId: string): TunnelLogger {
  return {
    info: (obj, msg) => base.info({ ...obj, cellId }, msg),
    warn: (obj, msg) => base.warn({ ...obj, cellId }, msg),
    error: (obj, msg) => base.error({ ...obj, cellId }, msg),
  };
}

export interface TunnelTarget {
  cellId: string;
  relayUrl: string;
  secret: string;
}

/**
 * Which of the joined workspaces get a tunnel, and to which relay.
 *
 * Pulled out of {@link runOtiumSidecar} so the one-tunnel-per-join decision —
 * the fix for the bug where only `loadJoins()[0]` ever got dialed — is
 * unit-testable without booting `Bun.serve`, a process lease, or a real
 * WebSocket. `--relay`/`OTIUM_RELAY_URL` still override every join uniformly,
 * matching the single-tunnel behaviour this replaces; a join with no relay
 * anywhere (legacy v0 credential) is reported skipped rather than silently
 * dropped.
 */
export function resolveTunnelTargets(
  joins: readonly Pick<OtiumJoin, "cellId" | "relay" | "secret">[],
  relayOverride?: string,
): { targets: TunnelTarget[]; skippedNoRelay: string[] } {
  const targets: TunnelTarget[] = [];
  const skippedNoRelay: string[] = [];
  const envRelay = process.env.OTIUM_RELAY_URL?.trim();
  for (const join of joins) {
    const relayUrl = relayOverride?.trim() || join.relay || envRelay;
    if (!relayUrl) {
      skippedNoRelay.push(join.cellId);
      continue;
    }
    targets.push({ cellId: join.cellId, relayUrl, secret: join.secret });
  }
  return { targets, skippedNoRelay };
}

export interface OtiumSidecarDependencies {
  inspectNode?: typeof inspectNodeDaemon;
  fetch?: typeof fetch;
}

/**
 * Paths the public relay is allowed to reach.
 *
 * The proxy authenticates *itself* to the node with `NODE_CONTROL_TOKEN`, a
 * full host capability, so whatever it forwards arrives already trusted. That
 * makes the set of forwardable paths a security boundary rather than routing
 * convenience: anything reachable here is reachable by anyone who can reach the
 * relay. Local administration (`_workspaces`) is deliberately outside it.
 */
function isPublicPeerPath(pathname: string): boolean {
  return pathname === "/ready" || pathname.startsWith("/api/v1/peer/");
}

/** Forward one public peer request to the currently advertised canonical Node. */
export async function proxyOtiumPeerRequest(
  req: Request,
  dependencies: OtiumSidecarDependencies = {},
): Promise<Response> {
  const inspectNode = dependencies.inspectNode ?? inspectNodeDaemon;
  const fetchRequest = dependencies.fetch ?? fetch;
  if (!isPublicPeerPath(new URL(req.url).pathname)) {
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  }
  const status = await inspectNode();
  if (!status.running || !status.info) {
    return Response.json(
      { ok: false, error: "canonical Negotium node is unavailable" },
      { status: 503 },
    );
  }
  const source = new URL(req.url);
  const target = new URL(`http://127.0.0.1:${status.info.port}`);
  target.pathname = `${OTIUM_ADAPTER_CONTROL_PREFIX}${source.pathname}`;
  target.search = source.search;
  const headers = new Headers(req.headers);
  headers.set(OTIUM_ADAPTER_CONTROL_HEADER, NODE_CONTROL_TOKEN);
  // Defence in depth behind the path whitelist: the node refuses local
  // administration outright when a request carries this marker, so a future
  // widening of the whitelist cannot quietly expose an admin route. Set (never
  // merged) after the inbound headers are copied, so a caller cannot clear it.
  headers.set(OTIUM_RELAYED_HEADER, "1");
  try {
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    // The relay-to-sidecar hop uses a streamed body, so Bun adds chunked
    // framing. The sidecar buffers that stream before the Node-owned hop;
    // forwarding both framing modes makes Bun reject the request before it
    // reaches the adapter route.
    headers.delete("transfer-encoding");
    headers.delete("content-length");
    if (body) headers.set("content-length", String(body.byteLength));
    return await fetchRequest(
      new Request(target.toString(), { method: req.method, headers, body, signal: req.signal }),
    );
  } catch (error) {
    logger.warn({ err: error }, "otium sidecar: canonical node request failed");
    return Response.json(
      { ok: false, error: "canonical Negotium node connection failed" },
      { status: 503 },
    );
  }
}

/** Run the public Otium peer surface and relay tunnel without embedding a Node. */
export async function runOtiumSidecar(options: OtiumSidecarOptions): Promise<void> {
  const joins = loadJoins();
  if (joins.length === 0) {
    throw new Error("not joined to an Otium workspace — run `negotium otium join <code>` first");
  }
  const initialNode = await inspectNodeDaemon();
  if (!initialNode.running) {
    throw new Error("canonical Negotium node is not running");
  }
  const ready = await proxyOtiumPeerRequest(new Request("http://127.0.0.1/ready"));
  if (!ready.ok) {
    throw new Error(
      "canonical Negotium node has no Otium runtime; restart it after joining the workspace",
    );
  }

  let server: ReturnType<typeof Bun.serve> | undefined;
  const lease = await waitForRequiredRuntimeProcessLease("adapter:otium", {
    workloadName: "Otium adapter",
    onLost: () => {
      process.stderr.write("negotium otium: singleton lease lost; shutting down\n");
      void runShutdown("singleton-lease-lost");
    },
  });
  try {
    server = Bun.serve({
      port: options.port,
      hostname: "127.0.0.1",
      idleTimeout: 240,
      maxRequestBodySize: MAX_PEER_REQUEST_BODY_BYTES,
      fetch: (req) => proxyOtiumPeerRequest(req),
    });
  } catch (error) {
    lease.stop();
    throw error;
  }

  /**
   * One tunnel per joined workspace, not just the first (M-6 parity with the
   * node daemon's `mounted` map in node-runtime.ts).
   *
   * The sidecar used to build a single `TunnelClient` from `loadJoin()` —
   * `loadJoins()[0]`, the *oldest* join by file order. A host joined to
   * several workspaces (or carrying a dead join left over from a revoked
   * enrollment) got relay reachability for exactly one of them, chosen by
   * accident of ordering; the other N-1 credentials sat on disk with no
   * tunnel ever attempted for them, in total silence. Multi-workspace attach
   * was already real at the daemon layer — this was the one place it wasn't.
   */
  const { targets, skippedNoRelay } = resolveTunnelTargets(joins, options.relayUrl);
  const tunnels = new Map<string, TunnelClient>();
  for (const target of targets) {
    tunnels.set(
      target.cellId,
      new TunnelClient({
        relayUrl: target.relayUrl,
        token: target.secret,
        targetOrigin: `http://127.0.0.1:${server.port}`,
        nodeVersion: `negotium@${NEGOTIUM_VERSION}`,
        logger: withCellId(logger, target.cellId),
      }),
    );
  }
  if (skippedNoRelay.length > 0) {
    logger.warn(
      { cellIds: skippedNoRelay },
      "otium sidecar: no relay URL for these joined workspaces; they have no tunnel and will not be reachable",
    );
  }
  for (const tunnel of tunnels.values()) tunnel.start();

  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  onShutdown("otium-sidecar-server", 130, () => server?.stop(true));
  onShutdown("otium-sidecar-tunnel", 120, () => {
    for (const tunnel of tunnels.values()) tunnel.stop();
  });
  onShutdown("otium-sidecar-lease", 110, () => lease.stop());
  onShutdown("otium-sidecar-completed", -100, resolveCompleted);
  process.stdout.write(
    `negotium Otium adapter listening on 127.0.0.1:${server.port} (canonical node pid ${initialNode.info?.pid}, ${tunnels.size}/${joins.length} workspace tunnel${joins.length === 1 ? "" : "s"} started)\n`,
  );
  await completed;
}
