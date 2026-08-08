/**
 * Remote transport for the Runtime Gateway (D-2).
 *
 * The gateway contract (`/api/v1/control/runtime/v1/...`) is loopback-only by
 * construction: it is authenticated with `NODE_CONTROL_TOKEN`, a full host
 * capability that must never cross a network. This module gives the hub the
 * same contract over the relay without moving that token:
 *
 *   hub ──(peer token, minted by Central)──► relay ──► worker sidecar
 *                                                        │ loopback
 *                                                        ▼
 *                                       this handler swaps the peer token for
 *                                       NODE_CONTROL_TOKEN in-process and calls
 *                                       the node's own gateway handler
 *
 * So the credential on the wire is a short-lived, Central-verified peer token
 * scoped to one workspace, and the host capability never leaves the machine.
 *
 * Only the hub may call it (`fromIsPrimary`), and only the read/turn subset of
 * the contract is exposed — the mutating control routes stay loopback-only.
 */
import { NODE_CONTROL_TOKEN } from "@negotium/core";

/** Mirrors `NODE_RUNTIME_CONTRACT_BASE_PATH` without importing @negotium/node. */
const RUNTIME_CONTRACT_PATH = "/api/v1/control/runtime/v1";

/** Public prefix the hub addresses; rewritten to the contract path locally. */
export const OTIUM_GATEWAY_FORWARD_PREFIX = "/api/v1/peer/runtime";

/**
 * Exactly the contract the Otium gateway client speaks. Anything outside this
 * list stays loopback-only, so widening the remote surface has to be a
 * deliberate edit here rather than a side effect of adding a control route.
 */
function allowedRuntimePath(path: string, method: string): boolean {
  if (method === "GET") {
    if (path === "/health" || path === "/events" || path === "/topics") return true;
    return /^\/topics\/[^/]+(\/messages)?$/.test(path);
  }
  if (method === "POST") return path === "/turns";
  return false;
}

export interface GatewayForwardOptions {
  /** Loopback origin of the canonical node, e.g. `http://127.0.0.1:57621`. */
  nodeOrigin: string;
  fetch?: typeof fetch;
}

/**
 * Translate one relayed gateway call into a loopback control call.
 * Returns null when the path is not a gateway-forward path.
 *
 * The response is piped back unbuffered so `/events` stays a live SSE stream
 * rather than an eventual single blob.
 */
export async function forwardGatewayRequest(
  req: Request,
  options: GatewayForwardOptions,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(OTIUM_GATEWAY_FORWARD_PREFIX)) return null;
  const runtimePath = url.pathname.slice(OTIUM_GATEWAY_FORWARD_PREFIX.length) || "/";
  if (!allowedRuntimePath(runtimePath, req.method)) {
    return Response.json({ ok: false, error: "gateway route not forwarded" }, { status: 404 });
  }

  const target = new URL(`${options.nodeOrigin.replace(/\/+$/, "")}${RUNTIME_CONTRACT_PATH}${runtimePath}`);
  target.search = url.search;
  const headers = new Headers(req.headers);
  // Replace the peer token with the host capability. This is the only place the
  // swap happens, and it happens after the caller was verified as the hub.
  headers.set("authorization", `Bearer ${NODE_CONTROL_TOKEN}`);
  // The relay hop streams bodies, so Bun would otherwise send both chunked
  // framing and a length once we buffer — same fix as the sidecar proxy.
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  headers.delete("host");
  const body =
    req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  if (body) headers.set("content-length", String(body.byteLength));

  const fetchRequest = options.fetch ?? fetch;
  return fetchRequest(
    new Request(target.toString(), {
      method: req.method,
      headers,
      body,
      signal: req.signal,
    }),
  );
}
