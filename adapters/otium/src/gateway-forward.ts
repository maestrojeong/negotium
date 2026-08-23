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
 * the contract plus the room operations the hub owns (create, delete, update,
 * abort, session reset/compact) is exposed — every other control route stays
 * loopback-only.
 */
import { NODE_CONTROL_TOKEN } from "@negotium/core";
import { RUNTIME_GATEWAY_CONTROL_PATH } from "@negotium/core/runtime-gateway";

/** Mirrors `NODE_RUNTIME_SURFACE_SCOPE_HEADER`, for the same reason. */
const SURFACE_SCOPE_HEADER = "x-negotium-surface-scope";
/** Mirrors `NODE_RUNTIME_SURFACE_SCOPE_STRICT_HEADER`. */
const SURFACE_SCOPE_STRICT_HEADER = "x-negotium-surface-scope-strict";

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
    if (path === "/cron/scripts" || path === "/cron/jobs") return true;
    if (/^\/cron\/jobs\/[^/]+\/runs$/.test(path)) return true;
    if (/^\/topics\/[^/]+(\/messages|\/usage)?$/.test(path)) return true;
    if (/^\/topics\/[^/]+\/files\/[^/]+$/.test(path)) return true;
    return /^\/topics\/[^/]+\/visuals\/\d+$/.test(path);
  }
  if (method === "POST") {
    if (path === "/turns" || path === "/input-files" || path === "/manager-topic") return true;
    // Creating a room on the worker the hub is already driving. This is not a
    // new class of authority: the hub already starts turns on this worker's
    // rooms, reconfigures them and deletes them (D-8), so refusing the one verb
    // that brings a room into existence only meant a user with the worker in
    // their Otium sidebar had to SSH into that machine and use the CLI to get a
    // room there. D-1 is untouched — the node still owns the room it creates and
    // shares it back to Otium through the same mirror/mapping pass as any other,
    // so there is no second authority over the transcript.
    //
    // Exact path, so `/topics/:id/...` creation-adjacent routes (derive, import)
    // are unaffected and stay loopback-only on their own terms.
    if (path === "/topics") return true;
    if (path === "/cron/jobs") return true;
    if (/^\/cron\/jobs\/[^/]+\/(run|cancel)$/.test(path)) return true;
    // Turn and session control on a room the hub already runs turns on (D-8).
    // Aborting is strictly narrower than starting: it can only stop work the
    // hub itself queued. Reset and compact discard the agent session, never the
    // transcript, so the worst a hub can do here is make its own next turn
    // start cold. Listed as exact sub-paths rather than a `/topics/:id/...`
    // wildcard, so a future control route under the same prefix is not
    // forwarded by accident.
    // Delivering the user's selection for an `ask_user_question` card this
    // worker published. Narrower than `/turns`, which the hub already has: it
    // cannot start work, only unblock a turn the worker is already running, and
    // only with a choice the worker itself offered. Without it a mirrored room's
    // ask card is unanswerable from the hub, which is the whole point of
    // rendering it there.
    if (/^\/topics\/[^/]+\/messages\/[^/]+\/ask-answer$/.test(path)) return true;
    return /^\/topics\/[^/]+\/(abort|session\/(reset|compact))$/.test(path);
  }
  // The two mutations a hub must reach on a room it already runs turns on
  // (D-8): deleting it, so a room the hub no longer shows stops being
  // re-mirrored on the next sync pass instead of bouncing right back, and
  // reconfiguring it, so the hub's agent/model/effort/AI-mode picker changes
  // the row the turn runner actually reads.
  //
  // Scoped to exactly `/topics/:id`, one segment, no sub-path. Every other
  // mutation stays loopback-only.
  if (method === "DELETE" || method === "PATCH") {
    return /^\/topics\/[^/]+$/.test(path) || /^\/cron\/jobs\/[^/]+$/.test(path);
  }
  return false;
}

export interface GatewayForwardOptions {
  /** Loopback origin of the canonical node, e.g. `http://127.0.0.1:57621`. */
  nodeOrigin: string;
  /**
   * The workspace the verified caller speaks for, or null when this node has
   * not resolved it yet. Always stated, never omitted: the node reads the
   * header's presence as "this is a workspace-scoped caller", so leaving it out
   * would hand a remote hub every workspace's rooms (M-8).
   */
  surfaceScope: string | null;
  /**
   * True when this node serves more than one workspace, which makes a room
   * filed under none ambiguous rather than legacy.
   */
  strictScope: boolean;
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

  const target = new URL(
    `${options.nodeOrigin.replace(/\/+$/, "")}${RUNTIME_GATEWAY_CONTROL_PATH}${runtimePath}`,
  );
  target.search = url.search;
  const headers = new Headers(req.headers);
  // Replace the peer token with the host capability. This is the only place the
  // swap happens, and it happens after the caller was verified as the hub.
  headers.set("authorization", `Bearer ${NODE_CONTROL_TOKEN}`);
  // Set after the caller was verified, and set unconditionally so a forged
  // inbound header can never survive into the loopback call.
  headers.set(SURFACE_SCOPE_HEADER, options.surfaceScope ?? "");
  headers.set(SURFACE_SCOPE_STRICT_HEADER, options.strictScope ? "1" : "0");
  // The relay hop streams bodies, so Bun would otherwise send both chunked
  // framing and a length once we buffer — same fix as the sidecar proxy.
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  headers.delete("host");
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
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
