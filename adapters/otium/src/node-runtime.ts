import {
  logger,
  NODE_CONTROL_TOKEN,
  registerNodeRequestHandler,
  unregisterNodeRequestHandler,
} from "@negotium/core";
import {
  OTIUM_ADAPTER_CONTROL_HEADER,
  OTIUM_ADAPTER_CONTROL_PREFIX,
  OTIUM_RELAYED_HEADER,
  OTIUM_WORKSPACES_CONTROL_PATH,
} from "@/control-protocol";
import { type OtiumNodeRuntimeHandle, startOtiumNodeRuntime } from "@/index";
import { loadJoins, type OtiumJoin } from "@/join";
import { handleOtiumPeerRequest } from "@/peer-server";

export { OTIUM_ADAPTER_CONTROL_HEADER, OTIUM_ADAPTER_CONTROL_PREFIX } from "@/control-protocol";
export { MAX_PEER_REQUEST_BODY_BYTES } from "@/protocol";

/**
 * Every workspace this process currently serves, one runtime instance each
 * (M-6). Keyed by cell id because that is what a leave names, and because the
 * same workspace re-joined with a fresh invite is a genuinely new seat.
 */
const mounted = new Map<string, OtiumNodeRuntimeHandle>();

function sameCredentials(left: OtiumJoin, right: OtiumJoin): boolean {
  return (
    left.central === right.central && left.relay === right.relay && left.secret === right.secret
  );
}

/**
 * Attach a workspace to the running node.
 *
 * Idempotent for an unchanged join, but a *re-issued* credential for a cell
 * this node already holds is a change, not a no-op: `--replace` writes a new
 * secret precisely because the old one was revoked, and keeping the old
 * instance would sign every Central call with a dead secret until restart.
 */
export function attachOtiumWorkspace(join: OtiumJoin): boolean {
  const current = mounted.get(join.cellId);
  if (current) {
    if (sameCredentials(current.join, join)) return false;
    detachOtiumWorkspace(join.cellId);
  }
  mounted.set(join.cellId, startOtiumNodeRuntime({ join }));
  return true;
}

/**
 * Detach one workspace, leaving every other one running.
 *
 * Its rooms are deliberately untouched: they keep their workspace, their
 * transcript and their local execution (M-4). Only reachability *through that
 * workspace* goes away, and re-joining restores it with no repair step.
 */
export function detachOtiumWorkspace(cellId: string): boolean {
  const runtime = mounted.get(cellId);
  if (!runtime) return false;
  mounted.delete(cellId);
  runtime.stop();
  return true;
}

export function mountedOtiumWorkspaces(): OtiumJoin[] {
  return [...mounted.values()].map((runtime) => runtime.join);
}

/**
 * Apply the persisted join set to the running node without a restart (M-7).
 *
 * Join and leave both write the credential file and then ask the node to
 * reconcile, so there is one mount path rather than a startup path plus a hot
 * path — the case that only runs on `join` is the case that is never tested.
 */
export function reconcileOtiumWorkspaces(joins = loadJoins()): {
  attached: string[];
  detached: string[];
} {
  const wanted = new Map(joins.map((join) => [join.cellId, join]));
  const detached: string[] = [];
  for (const cellId of [...mounted.keys()]) {
    if (wanted.has(cellId)) continue;
    detachOtiumWorkspace(cellId);
    detached.push(cellId);
  }
  const attached: string[] = [];
  for (const [cellId, join] of wanted) {
    if (attachOtiumWorkspace(join)) attached.push(cellId);
  }
  if (attached.length > 0 || detached.length > 0) {
    logger.info({ attached, detached }, "otium: workspace attachments reconciled");
  }
  return { attached, detached };
}

/** Authenticated loopback bridge from the Otium sidecar into its Node-owned runtime. */
export async function handleOtiumAdapterControlRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(`${OTIUM_ADAPTER_CONTROL_PREFIX}/`)) return null;
  if (req.headers.get(OTIUM_ADAPTER_CONTROL_HEADER) !== NODE_CONTROL_TOKEN) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const peerPath = url.pathname.slice(OTIUM_ADAPTER_CONTROL_PREFIX.length) || "/";

  // Local administration, not a peer call: reload the credential file so a
  // `join` or `leave` in another process takes effect here immediately.
  if (peerPath === OTIUM_WORKSPACES_CONTROL_PATH) {
    // Which workspaces this node serves is local administration. The sidecar
    // stamps every relayed request, so this refuses the public path even though
    // the control token it carries is genuine.
    if (req.headers.get(OTIUM_RELAYED_HEADER)) {
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    }
    if (req.method === "GET") {
      return Response.json({
        ok: true,
        workspaces: mountedOtiumWorkspaces().map((join) => ({
          cellId: join.cellId,
          central: join.central,
        })),
      });
    }
    if (req.method === "POST") {
      const result = reconcileOtiumWorkspaces();
      return Response.json({ ok: true, ...result });
    }
    return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
  }

  const peerUrl = new URL(req.url);
  peerUrl.pathname = peerPath;
  const headers = new Headers(req.headers);
  headers.delete(OTIUM_ADAPTER_CONTROL_HEADER);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  return (
    (await handleOtiumPeerRequest(
      new Request(peerUrl.toString(), { method: req.method, headers, body, signal: req.signal }),
    )) ?? Response.json({ ok: false, error: "Otium route not found" }, { status: 404 })
  );
}

/**
 * Mount Otium runtime services in the canonical Node process for every joined
 * workspace. Returns null when the node has joined none.
 *
 * The handle names the first workspace for the callers that still assume one,
 * and stopping it stops them all.
 */
export function mountConfiguredOtiumNodeRuntime(): OtiumNodeRuntimeHandle | null {
  const joins = loadJoins();
  if (joins.length === 0) return null;
  for (const join of joins) attachOtiumWorkspace(join);
  registerNodeRequestHandler("otium-adapter-control", handleOtiumAdapterControlRequest);
  let stopped = false;
  return {
    name: "otium",
    join: joins[0]!,
    stop() {
      if (stopped) return;
      stopped = true;
      unregisterNodeRequestHandler("otium-adapter-control");
      for (const cellId of [...mounted.keys()]) detachOtiumWorkspace(cellId);
    },
  };
}
