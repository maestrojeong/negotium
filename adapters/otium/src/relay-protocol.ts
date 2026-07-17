/**
 * Relay tunnel wire protocol — JSON text frames over a single outbound
 * WebSocket from a runtime node to the central relay.
 *
 * Topology: the NODE always dials the relay (never the reverse), so nodes work
 * behind NAT/firewalls with no inbound connectivity. The node authenticates at
 * the WebSocket upgrade with its runtime-cell secret (Bearer), then sends
 * `register` as its first frame. The relay answers `registered` or
 * `register_error` — version compatibility is negotiated there, not per-frame.
 *
 * Two multiplexed streams ride the tunnel, correlated by `id`:
 *  - HTTP: relay→node `http_req_head/chunk/end/abort`, node→relay
 *    `http_res_head/chunk/end/error`. Bodies are chunked and base64-encoded.
 *  - WebSocket bridging: relay→node `ws_open`, then `ws_data`/`ws_close`
 *    flow in both directions.
 *
 * Both ends of this protocol live in this monorepo. Frames are therefore
 * decoded with a shape check only (`type` discriminant), not full schema
 * validation — the version handshake is the compatibility gate.
 */

export const PROTOCOL_VERSION = 1;
/** Oldest node protocol version the relay still accepts. */
export const MIN_PROTOCOL_VERSION = 1;

/** Header list as ordered pairs — preserves duplicates (e.g. set-cookie). */
export type HeaderPairs = Array<[string, string]>;

// ── Node → Relay ──────────────────────────────────────────────────

export type NodeToRelayFrame =
  | { type: "register"; protocolVersion: number; nodeVersion?: string }
  | { type: "pong"; ts: number }
  | { type: "http_res_head"; id: string; status: number; headers: HeaderPairs }
  | { type: "http_res_chunk"; id: string; dataB64: string }
  | { type: "http_res_end"; id: string }
  | { type: "http_res_error"; id: string; message: string }
  | { type: "ws_open_ok"; id: string }
  | { type: "ws_open_error"; id: string; message: string }
  | { type: "ws_data"; id: string; text?: string; dataB64?: string }
  | { type: "ws_close"; id: string; code?: number; reason?: string };

// ── Relay → Node ──────────────────────────────────────────────────

export type RegisterErrorCode = "upgrade_required" | "unauthorized" | "replaced";

export type RelayToNodeFrame =
  | { type: "registered"; nodeId: string; protocolVersion: number; pingIntervalMs: number }
  | { type: "register_error"; code: RegisterErrorCode; message: string }
  | { type: "ping"; ts: number }
  | {
      type: "http_req_head";
      id: string;
      method: string;
      /** Pathname + query, already stripped of the relay's /n/:nodeId prefix. */
      path: string;
      headers: HeaderPairs;
      hasBody: boolean;
    }
  | { type: "http_req_chunk"; id: string; dataB64: string }
  | { type: "http_req_end"; id: string }
  | { type: "http_req_abort"; id: string }
  | { type: "ws_open"; id: string; path: string }
  | { type: "ws_data"; id: string; text?: string; dataB64?: string }
  | { type: "ws_close"; id: string; code?: number; reason?: string };

// ── Codec ─────────────────────────────────────────────────────────

export function encodeFrame(frame: NodeToRelayFrame | RelayToNodeFrame): string {
  return JSON.stringify(frame);
}

function decodeFrame(raw: unknown): { type: string } | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.type === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function decodeNodeFrame(raw: unknown): NodeToRelayFrame | null {
  return decodeFrame(raw) as NodeToRelayFrame | null;
}

export function decodeRelayFrame(raw: unknown): RelayToNodeFrame | null {
  return decodeFrame(raw) as RelayToNodeFrame | null;
}

// ── Payload helpers ───────────────────────────────────────────────

/** Per-frame body chunk cap. Base64 inflates ~4/3, so frames stay well under
 *  the tunnel socket's payload limit. */
export const MAX_CHUNK_BYTES = 256 * 1024;

export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function fromB64(dataB64: string): Uint8Array {
  return new Uint8Array(Buffer.from(dataB64, "base64"));
}

/** Re-split an arbitrary chunk into frame-sized slices. */
export function* chunkBytes(bytes: Uint8Array): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
    yield bytes.subarray(offset, offset + MAX_CHUNK_BYTES);
  }
}

/** `close(code)` only accepts 1000 or 3000-4999; anything else (1001, 1006, …)
 *  throws. Bridged closes map other codes to a plain 1000. */
export function sanitizeCloseCode(code: number | undefined): number | undefined {
  if (code === undefined) return undefined;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}

/** Hop-by-hop headers never forwarded in either direction. `content-length`
 *  and `content-encoding` are dropped too: fetch() transparently decompresses
 *  bodies and re-chunks streams, so both would lie after transit. */
const DROPPED_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "accept-encoding",
  "content-length",
  "content-encoding",
]);

export function forwardableHeaders(headers: Headers): HeaderPairs {
  const pairs: HeaderPairs = [];
  headers.forEach((value, name) => {
    if (!DROPPED_HEADERS.has(name.toLowerCase())) pairs.push([name, value]);
  });
  return pairs;
}
