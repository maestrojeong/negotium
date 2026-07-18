import {
  logger,
  NEGOTIUM_VERSION,
  NODE_CONTROL_TOKEN,
  onShutdown,
  runShutdown,
  waitForRequiredRuntimeProcessLease,
} from "@negotium/core";
import { inspectNodeDaemon } from "@negotium/node";
import { OTIUM_ADAPTER_CONTROL_HEADER, OTIUM_ADAPTER_CONTROL_PREFIX } from "@/control-protocol";
import { loadJoin } from "@/join";
import { MAX_PEER_INPUT_REQUEST_BYTES } from "@/protocol";
import { TunnelClient } from "@/tunnel-client";

export interface OtiumSidecarOptions {
  port: number;
  relayUrl?: string;
}

export interface OtiumSidecarDependencies {
  inspectNode?: typeof inspectNodeDaemon;
  fetch?: typeof fetch;
}

/** Forward one public peer request to the currently advertised canonical Node. */
export async function proxyOtiumPeerRequest(
  req: Request,
  dependencies: OtiumSidecarDependencies = {},
): Promise<Response> {
  const inspectNode = dependencies.inspectNode ?? inspectNodeDaemon;
  const fetchRequest = dependencies.fetch ?? fetch;
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
  const join = loadJoin();
  if (!join) {
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
      void runShutdown("test");
    },
  });
  try {
    server = Bun.serve({
      port: options.port,
      hostname: "127.0.0.1",
      idleTimeout: 240,
      maxRequestBodySize: MAX_PEER_INPUT_REQUEST_BYTES,
      fetch: (req) => proxyOtiumPeerRequest(req),
    });
  } catch (error) {
    lease.stop();
    throw error;
  }

  const selectedRelay =
    options.relayUrl?.trim() || join.relay || process.env.OTIUM_RELAY_URL?.trim();
  const tunnel = selectedRelay
    ? new TunnelClient({
        relayUrl: selectedRelay,
        token: join.secret,
        targetOrigin: `http://127.0.0.1:${server.port}`,
        nodeVersion: `negotium@${NEGOTIUM_VERSION}`,
        logger,
      })
    : null;
  tunnel?.start();

  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  onShutdown("otium-sidecar-server", 130, () => server?.stop(true));
  onShutdown("otium-sidecar-tunnel", 120, () => tunnel?.stop());
  onShutdown("otium-sidecar-lease", 110, () => lease.stop());
  onShutdown("otium-sidecar-completed", -100, resolveCompleted);
  process.stdout.write(
    `negotium Otium adapter listening on 127.0.0.1:${server.port} (canonical node pid ${initialNode.info?.pid})\n`,
  );
  await completed;
}
