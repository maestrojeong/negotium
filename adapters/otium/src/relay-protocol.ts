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
 * Both ends of this protocol live in this monorepo, but the tunnel is still a
 * network trust boundary. Decoders validate every field before dispatch so a
 * malformed or version-confused peer cannot throw inside a WebSocket callback.
 */

export const PROTOCOL_VERSION = 2;

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
  | {
      type: "ws_open";
      id: string;
      path: string;
      /** Authentication context from the public upgrade. Only cookie,
       * authorization, and the relay-selected subprotocol are permitted. */
      headers: HeaderPairs;
    }
  | { type: "ws_data"; id: string; text?: string; dataB64?: string }
  | { type: "ws_close"; id: string; code?: number; reason?: string };

// ── Codec ─────────────────────────────────────────────────────────

export function encodeFrame(frame: NodeToRelayFrame | RelayToNodeFrame): string {
  const encoded = JSON.stringify(frame);
  if (
    encoded.length > MAX_FRAME_CHARS ||
    (!decodeNodeFrame(encoded) && !decodeRelayFrame(encoded))
  ) {
    throw new TypeError("relay frame exceeds protocol limits or is invalid");
  }
  return encoded;
}

type FrameRecord = Record<string, unknown> & { type: string };

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const MAX_FRAME_CHARS = 512 * 1024;
export const MAX_CHUNK_BYTES = 256 * 1024;
export const MAX_ENCODED_CHUNK_CHARS = Math.ceil(MAX_CHUNK_BYTES / 3) * 4;
export const MAX_HEADER_PAIRS = 128;
export const MAX_HEADER_BYTES = 64 * 1024;
export const MAX_ID_BYTES = 256;
export const MAX_PATH_BYTES = 16 * 1024;
export const MAX_MESSAGE_BYTES = 4 * 1024;
export const MAX_REASON_BYTES = 123;
const MAX_METHOD_BYTES = 32;
const MAX_NODE_ID_BYTES = 256;
const MAX_NODE_VERSION_BYTES = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function hasMaxBytes(value: string, maxBytes: number): boolean {
  return value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return isString(value) && hasMaxBytes(value, maxBytes);
}

function isNonEmptyBoundedString(value: unknown, maxBytes: number): value is string {
  return isBoundedString(value, maxBytes) && value.length > 0;
}

function isOptionalBoundedString(value: unknown, maxBytes: number): value is string | undefined {
  return value === undefined || isBoundedString(value, maxBytes);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

function isHeaders(value: unknown): value is HeaderPairs {
  if (!Array.isArray(value) || value.length > MAX_HEADER_PAIRS) return false;
  let totalBytes = 0;
  for (const pair of value) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      !isString(pair[0]) ||
      !HEADER_NAME.test(pair[0]) ||
      !isString(pair[1]) ||
      /[\0\r\n]/.test(pair[1])
    ) {
      return false;
    }
    totalBytes += Buffer.byteLength(pair[0]) + Buffer.byteLength(pair[1]);
    if (totalBytes > MAX_HEADER_BYTES) return false;
  }
  return true;
}

function isBase64(value: unknown): value is string {
  if (
    !isString(value) ||
    value.length > MAX_ENCODED_CHUNK_CHARS ||
    value.length % 4 !== 0 ||
    !BASE64.test(value)
  )
    return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding <= MAX_CHUNK_BYTES;
}

function isWsData(frame: FrameRecord): boolean {
  return (
    (isBoundedString(frame.text, MAX_CHUNK_BYTES) && frame.dataB64 === undefined) ||
    (frame.text === undefined && isBase64(frame.dataB64))
  );
}

function isWsClose(frame: FrameRecord): boolean {
  return (
    isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) &&
    (frame.code === undefined ||
      (isInteger(frame.code) && frame.code >= 0 && frame.code <= 65_535)) &&
    isOptionalBoundedString(frame.reason, MAX_REASON_BYTES)
  );
}

function decodeFrame(raw: unknown): FrameRecord | null {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) return null;
  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.type === "string") return parsed as FrameRecord;
    return null;
  } catch {
    return null;
  }
}

export function decodeNodeFrame(raw: unknown): NodeToRelayFrame | null {
  const frame = decodeFrame(raw);
  if (!frame) return null;
  switch (frame.type) {
    case "register":
      return isInteger(frame.protocolVersion) &&
        frame.protocolVersion > 0 &&
        isOptionalBoundedString(frame.nodeVersion, MAX_NODE_VERSION_BYTES)
        ? (frame as NodeToRelayFrame)
        : null;
    case "pong":
      return isFiniteNumber(frame.ts) && frame.ts >= 0 ? (frame as NodeToRelayFrame) : null;
    case "http_res_head":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) &&
        isInteger(frame.status) &&
        frame.status >= 200 &&
        frame.status <= 599 &&
        isHeaders(frame.headers)
        ? (frame as NodeToRelayFrame)
        : null;
    case "http_res_chunk":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) && isBase64(frame.dataB64)
        ? (frame as NodeToRelayFrame)
        : null;
    case "http_res_end":
    case "ws_open_ok":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) ? (frame as NodeToRelayFrame) : null;
    case "http_res_error":
    case "ws_open_error":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) &&
        isBoundedString(frame.message, MAX_MESSAGE_BYTES)
        ? (frame as NodeToRelayFrame)
        : null;
    case "ws_data":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) && isWsData(frame)
        ? (frame as NodeToRelayFrame)
        : null;
    case "ws_close":
      return isWsClose(frame) ? (frame as NodeToRelayFrame) : null;
    default:
      return null;
  }
}

export function decodeRelayFrame(raw: unknown): RelayToNodeFrame | null {
  const frame = decodeFrame(raw);
  if (!frame) return null;
  switch (frame.type) {
    case "registered":
      return isNonEmptyBoundedString(frame.nodeId, MAX_NODE_ID_BYTES) &&
        isInteger(frame.protocolVersion) &&
        frame.protocolVersion > 0 &&
        isInteger(frame.pingIntervalMs) &&
        frame.pingIntervalMs > 0
        ? (frame as RelayToNodeFrame)
        : null;
    case "register_error":
      return (frame.code === "upgrade_required" ||
        frame.code === "unauthorized" ||
        frame.code === "replaced") &&
        isBoundedString(frame.message, MAX_MESSAGE_BYTES)
        ? (frame as RelayToNodeFrame)
        : null;
    case "ping":
      return isFiniteNumber(frame.ts) && frame.ts >= 0 ? (frame as RelayToNodeFrame) : null;
    case "http_req_head":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) &&
        isNonEmptyBoundedString(frame.method, MAX_METHOD_BYTES) &&
        isBoundedString(frame.path, MAX_PATH_BYTES) &&
        frame.path.startsWith("/") &&
        isHeaders(frame.headers) &&
        typeof frame.hasBody === "boolean"
        ? (frame as RelayToNodeFrame)
        : null;
    case "http_req_chunk":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) && isBase64(frame.dataB64)
        ? (frame as RelayToNodeFrame)
        : null;
    case "http_req_end":
    case "http_req_abort":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) ? (frame as RelayToNodeFrame) : null;
    case "ws_open":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) &&
        isBoundedString(frame.path, MAX_PATH_BYTES) &&
        frame.path.startsWith("/") &&
        isHeaders(frame.headers)
        ? (frame as RelayToNodeFrame)
        : null;
    case "ws_data":
      return isNonEmptyBoundedString(frame.id, MAX_ID_BYTES) && isWsData(frame)
        ? (frame as RelayToNodeFrame)
        : null;
    case "ws_close":
      return isWsClose(frame) ? (frame as RelayToNodeFrame) : null;
    default:
      return null;
  }
}

// ── Payload helpers ───────────────────────────────────────────────

export function toB64(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new RangeError(`relay chunk exceeds ${MAX_CHUNK_BYTES} bytes`);
  }
  return Buffer.from(bytes).toString("base64");
}

export function fromB64(dataB64: string): Uint8Array {
  if (!isBase64(dataB64)) {
    throw new RangeError(`invalid relay chunk or chunk exceeds ${MAX_CHUNK_BYTES} bytes`);
  }
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
