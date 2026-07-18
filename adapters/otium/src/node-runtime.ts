import {
  NODE_CONTROL_TOKEN,
  registerNodeRequestHandler,
  unregisterNodeRequestHandler,
} from "@negotium/core";
import { OTIUM_ADAPTER_CONTROL_HEADER, OTIUM_ADAPTER_CONTROL_PREFIX } from "@/control-protocol";
import { type OtiumNodeRuntimeHandle, startOtiumNodeRuntime } from "@/index";
import { loadJoin } from "@/join";
import { handleOtiumPeerRequest } from "@/peer-server";

export { OTIUM_ADAPTER_CONTROL_HEADER, OTIUM_ADAPTER_CONTROL_PREFIX } from "@/control-protocol";
export { MAX_PEER_INPUT_REQUEST_BYTES } from "@/protocol";

/** Authenticated loopback bridge from the Otium sidecar into its Node-owned runtime. */
export async function handleOtiumAdapterControlRequest(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith(`${OTIUM_ADAPTER_CONTROL_PREFIX}/`)) return null;
  if (req.headers.get(OTIUM_ADAPTER_CONTROL_HEADER) !== NODE_CONTROL_TOKEN) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const peerPath = url.pathname.slice(OTIUM_ADAPTER_CONTROL_PREFIX.length) || "/";
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

/** Mount Otium runtime services in the canonical Node process when joined. */
export function mountConfiguredOtiumNodeRuntime(): OtiumNodeRuntimeHandle | null {
  const join = loadJoin();
  if (!join) return null;
  const runtime = startOtiumNodeRuntime({ join });
  registerNodeRequestHandler("otium-adapter-control", handleOtiumAdapterControlRequest);
  let stopped = false;
  return {
    ...runtime,
    stop() {
      if (stopped) return;
      stopped = true;
      unregisterNodeRequestHandler("otium-adapter-control");
      runtime.stop();
    },
  };
}
