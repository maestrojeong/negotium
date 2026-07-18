/**
 * TunnelClient — the node side of the relay tunnel.
 *
 * Runs inside (or beside) a runtime-api process. Dials the relay with an
 * outbound WebSocket, registers, then services multiplexed HTTP requests and
 * bridged client WebSockets by replaying them against the local runtime-api
 * over loopback. The runtime-api itself needs zero changes: the tunnel is a
 * pure reverse proxy, so auth (JWT), routes, and streaming all work as-is.
 *
 * Reliability model: everything on the tunnel is request-scoped. If the relay
 * connection drops, every proxied request/socket is dead by definition, so
 * there is no outbound queue to maintain — abort local work, reconnect with
 * exponential backoff, and let clients retry.
 */

import {
  chunkBytes,
  decodeRelayFrame,
  encodeFrame,
  fromB64,
  type HeaderPairs,
  type NodeToRelayFrame,
  PROTOCOL_VERSION,
  type RelayToNodeFrame,
  sanitizeCloseCode,
  toB64,
} from "./relay-protocol";
import { assertSecureRelayUrl } from "./secure-transport";

type LogFn = (obj: Record<string, unknown>, msg: string) => void;

export interface TunnelLogger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export interface TunnelClientOptions {
  /** Relay origin — http(s):// or ws(s)://, with or without trailing slash. */
  relayUrl: string;
  /** Node credential — the runtime-cell secret (rcs_…) or a static dev token. */
  token: string;
  /** Local runtime-api origin, e.g. http://127.0.0.1:4000 */
  targetOrigin: string;
  nodeVersion?: string;
  logger?: TunnelLogger;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Test/embedding hook. Defaults to Bun's WebSocket constructor. */
  webSocketFactory?: (url: string, options: { headers: Record<string, string> }) => WebSocket;
}

export type TunnelStatus =
  | "idle"
  | "connecting"
  | "registered"
  | "stopped"
  | "unsupported"
  | "superseded";

/** Bun's WebSocket client accepts a non-standard `headers` option; the DOM lib
 *  typing doesn't know it. */
type BunWebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket;

const MAX_WS_UPGRADE_HEADER_BYTES = 32 * 1024;
const WS_PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function localWebSocketOptions(headers: HeaderPairs): {
  headers: Record<string, string>;
} | null {
  const forwarded: Record<string, string> = {};
  let totalBytes = 0;
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [rawName, value] = pair;
    if (typeof rawName !== "string" || typeof value !== "string" || /[\0\r\n]/.test(value)) {
      return null;
    }
    const name = rawName.toLowerCase();
    if (name !== "cookie" && name !== "authorization" && name !== "sec-websocket-protocol") {
      return null;
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes > MAX_WS_UPGRADE_HEADER_BYTES || name in forwarded) {
      return null;
    }
    if (name === "sec-websocket-protocol") {
      if (!WS_PROTOCOL_TOKEN.test(value)) return null;
    }
    forwarded[name] = value;
  }
  return { headers: forwarded };
}

const DEFAULT_MIN_RECONNECT_MS = 1_000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;
/** Liveness: relay pings every pingIntervalMs; absent ANY frame for this many
 *  intervals the socket is considered half-open and torn down for reconnect. */
const LIVENESS_INTERVALS = 3;

interface PendingHttp {
  abort: AbortController;
  /** Set while a chunked request body is being replayed into local fetch. */
  bodyController: ReadableStreamDefaultController<Uint8Array> | null;
  body: ReadableStream<Uint8Array> | undefined;
  method: string;
  path: string;
  headers: Headers;
  started: boolean;
}

interface BridgedSocket {
  ws: WebSocket;
  opened: boolean;
  /** relay→local data frames buffered until the local socket opens. */
  buffer: Array<Extract<RelayToNodeFrame, { type: "ws_data" }>>;
}

const noop: LogFn = () => {};
const silentLogger: TunnelLogger = { info: noop, warn: noop, error: noop };

export class TunnelClient {
  private readonly opts: Required<
    Pick<TunnelClientOptions, "relayUrl" | "token" | "targetOrigin">
  > &
    TunnelClientOptions;
  private readonly log: TunnelLogger;
  private ws: WebSocket | null = null;
  private connectionGeneration = 0;
  private statusValue: TunnelStatus = "idle";
  private reconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private pingIntervalMs = 30_000;
  private readonly pendingHttp = new Map<string, PendingHttp>();
  private readonly bridgedSockets = new Map<string, BridgedSocket>();

  constructor(options: TunnelClientOptions) {
    assertSecureRelayUrl(options.relayUrl);
    this.opts = options;
    this.log = options.logger ?? silentLogger;
    this.reconnectDelayMs = options.minReconnectDelayMs ?? DEFAULT_MIN_RECONNECT_MS;
  }

  get status(): TunnelStatus {
    return this.statusValue;
  }

  start(): void {
    if (this.statusValue !== "idle" && this.statusValue !== "stopped") return;
    this.connect();
  }

  stop(): void {
    this.statusValue = "stopped";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearLiveness();
    this.cleanupInFlight();
    const ws = this.ws;
    this.ws = null;
    this.connectionGeneration += 1;
    ws?.close(1000, "tunnel stopped");
  }

  // ── Connection lifecycle ────────────────────────────────────────

  private tunnelUrl(): string {
    const base = this.opts.relayUrl.replace(/\/+$/, "").replace(/^http/, "ws");
    return `${base}/tunnel`;
  }

  private connect(): void {
    this.statusValue = "connecting";
    const WS = WebSocket as unknown as BunWebSocketCtor;
    const options = { headers: { authorization: `Bearer ${this.opts.token}` } };
    const ws = this.opts.webSocketFactory
      ? this.opts.webSocketFactory(this.tunnelUrl(), options)
      : new WS(this.tunnelUrl(), options);
    const generation = ++this.connectionGeneration;
    this.ws = ws;

    ws.onopen = () => {
      if (!this.isActiveConnection(ws, generation)) return;
      this.send({
        type: "register",
        protocolVersion: PROTOCOL_VERSION,
        nodeVersion: this.opts.nodeVersion,
      });
      this.resetLiveness();
    };

    ws.onmessage = (event) => {
      if (!this.isActiveConnection(ws, generation)) return;
      try {
        const frame = decodeRelayFrame(event.data);
        if (!frame) {
          this.rejectProtocolFrame(ws, generation, "invalid relay frame");
          return;
        }
        this.resetLiveness(ws, generation);
        this.handleFrame(frame);
      } catch (err) {
        this.log.error(
          { error: err instanceof Error ? err.message : String(err) },
          "relay frame dispatch failed",
        );
        this.rejectProtocolFrame(ws, generation, "relay frame dispatch failed");
      }
    };

    ws.onclose = (event) => {
      this.disconnectActiveConnection(ws, generation, {
        code: event.code,
        reason: event.reason,
      });
    };

    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
  }

  private isActiveConnection(ws: WebSocket, generation: number): boolean {
    return this.ws === ws && this.connectionGeneration === generation;
  }

  private rejectProtocolFrame(ws: WebSocket, generation: number, reason: string): void {
    this.log.warn({ reason }, "closing relay tunnel after protocol error");
    this.disconnectActiveConnection(ws, generation, { reason });
    try {
      ws.close(1002, reason);
    } catch {
      // The active connection was already invalidated and reconnect is scheduled.
    }
  }

  /** Invalidate before closing: a half-open socket may never emit `close`. */
  private disconnectActiveConnection(
    ws: WebSocket,
    generation: number,
    details: Record<string, unknown>,
    close = false,
  ): void {
    if (!this.isActiveConnection(ws, generation)) return;
    this.ws = null;
    this.connectionGeneration += 1;
    this.clearLiveness();
    this.cleanupInFlight();
    if (
      this.statusValue !== "stopped" &&
      this.statusValue !== "unsupported" &&
      this.statusValue !== "superseded"
    ) {
      this.statusValue = "connecting";
      this.log.warn(details, "relay tunnel disconnected");
      this.scheduleReconnect();
    }
    if (close) {
      try {
        ws.close();
      } catch {
        // The connection is already invalidated and reconnect is scheduled.
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    // Spread reconnects after relay/edge restarts so every cell does not hit
    // the verifier and Docker DNS in the same millisecond.
    const jitter = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER_RATIO;
    const delay = Math.max(1, Math.round(this.reconnectDelayMs * jitter));
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      this.opts.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (
        this.statusValue === "stopped" ||
        this.statusValue === "unsupported" ||
        this.statusValue === "superseded"
      )
        return;
      this.connect();
    }, delay);
  }

  private resetLiveness(ws = this.ws, generation = this.connectionGeneration): void {
    this.clearLiveness();
    if (!ws) return;
    this.livenessTimer = setTimeout(() => {
      this.log.warn({}, "relay tunnel silent past liveness window — reconnecting");
      this.disconnectActiveConnection(ws, generation, { reason: "liveness timeout" }, true);
    }, this.pingIntervalMs * LIVENESS_INTERVALS);
  }

  private clearLiveness(): void {
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.livenessTimer = null;
  }

  private cleanupInFlight(): void {
    for (const pending of this.pendingHttp.values()) {
      pending.abort.abort();
      try {
        pending.bodyController?.error(new Error("relay tunnel disconnected"));
      } catch {
        // already closed
      }
    }
    this.pendingHttp.clear();
    for (const bridged of this.bridgedSockets.values()) {
      try {
        bridged.ws.close(1000, "relay tunnel disconnected");
      } catch {
        // already closed
      }
    }
    this.bridgedSockets.clear();
  }

  private send(frame: NodeToRelayFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame));
  }

  // ── Frame dispatch ──────────────────────────────────────────────

  private handleFrame(frame: RelayToNodeFrame): void {
    switch (frame.type) {
      case "registered":
        this.statusValue = "registered";
        this.pingIntervalMs = frame.pingIntervalMs;
        this.reconnectDelayMs = this.opts.minReconnectDelayMs ?? DEFAULT_MIN_RECONNECT_MS;
        this.resetLiveness(this.ws, this.connectionGeneration);
        this.log.info({ nodeId: frame.nodeId }, "relay tunnel registered");
        break;
      case "register_error":
        if (frame.code === "upgrade_required") {
          // Version mismatch is not recoverable by retrying — stop and demand
          // operator attention instead of hammering the relay forever.
          this.statusValue = "unsupported";
          this.log.error(
            { message: frame.message },
            "relay rejected protocol version — update this node",
          );
        } else if (frame.code === "unauthorized") {
          // Token may be fixed out-of-band; keep retrying, but only at the cap.
          this.reconnectDelayMs = this.opts.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_MS;
          this.log.error({ message: frame.message }, "relay rejected node credentials");
        } else {
          // A newer process owns this credential. Retrying would displace it and
          // create an endless replacement storm, so this instance is terminal
          // until an operator explicitly stop/starts it.
          this.statusValue = "superseded";
          this.log.info({ message: frame.message }, "relay tunnel superseded by newer connection");
          const ws = this.ws;
          if (ws) {
            this.disconnectActiveConnection(
              ws,
              this.connectionGeneration,
              { reason: "tunnel superseded" },
              true,
            );
          }
        }
        break;
      case "ping":
        this.send({ type: "pong", ts: frame.ts });
        break;
      case "http_req_head":
        this.startHttpRequest(frame);
        break;
      case "http_req_chunk": {
        const pending = this.pendingHttp.get(frame.id);
        try {
          pending?.bodyController?.enqueue(fromB64(frame.dataB64));
          if (pending) this.startPendingHttp(frame.id, pending);
        } catch {
          // request already settled locally
        }
        break;
      }
      case "http_req_end": {
        const pending = this.pendingHttp.get(frame.id);
        try {
          pending?.bodyController?.close();
          if (pending) this.startPendingHttp(frame.id, pending);
        } catch {
          // request already settled locally
        }
        break;
      }
      case "http_req_abort": {
        const pending = this.pendingHttp.get(frame.id);
        if (pending) {
          this.pendingHttp.delete(frame.id);
          pending.abort.abort();
          try {
            pending.bodyController?.error(new Error("aborted by relay"));
          } catch {
            // already closed
          }
        }
        break;
      }
      case "ws_open":
        this.openBridgedSocket(frame.id, frame.path, frame.headers);
        break;
      case "ws_data": {
        const bridged = this.bridgedSockets.get(frame.id);
        if (!bridged) break;
        if (!bridged.opened) {
          bridged.buffer.push(frame);
          break;
        }
        this.deliverToLocal(bridged.ws, frame);
        break;
      }
      case "ws_close": {
        const bridged = this.bridgedSockets.get(frame.id);
        if (!bridged) break;
        this.bridgedSockets.delete(frame.id);
        try {
          bridged.ws.close(sanitizeCloseCode(frame.code), frame.reason);
        } catch {
          // already closed
        }
        break;
      }
    }
  }

  // ── HTTP replay ─────────────────────────────────────────────────

  private startHttpRequest(frame: Extract<RelayToNodeFrame, { type: "http_req_head" }>): void {
    const abort = new AbortController();
    const headers = new Headers();
    for (const [name, value] of frame.headers) headers.append(name, value);
    const pending: PendingHttp = {
      abort,
      bodyController: null,
      body: undefined,
      method: frame.method,
      path: frame.path,
      headers,
      started: false,
    };
    if (frame.hasBody) {
      pending.body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          pending.bodyController = controller;
        },
      });
    }
    this.pendingHttp.set(frame.id, pending);

    // Bun can reject a fetch whose streaming request body has not produced its
    // first chunk yet. Body-bearing requests therefore start on the first
    // chunk (or on end for an empty body); bodyless requests start immediately.
    if (!frame.hasBody) this.startPendingHttp(frame.id, pending);
  }

  private startPendingHttp(id: string, pending: PendingHttp): void {
    if (pending.started || pending.abort.signal.aborted) return;
    pending.started = true;
    void this.replayHttp(
      id,
      pending.method,
      pending.path,
      pending.headers,
      pending.body,
      pending.abort,
    ).finally(() => {
      this.pendingHttp.delete(id);
    });
  }

  private async replayHttp(
    id: string,
    method: string,
    path: string,
    headers: Headers,
    body: ReadableStream<Uint8Array> | undefined,
    abort: AbortController,
  ): Promise<void> {
    try {
      const res = await fetch(`${this.opts.targetOrigin}${path}`, {
        method,
        headers,
        body,
        signal: abort.signal,
        // Pass redirects through verbatim — the browser client owns redirect
        // behavior, not the tunnel.
        redirect: "manual",
      });
      const pairs: Array<[string, string]> = [];
      res.headers.forEach((value, name) => {
        const lower = name.toLowerCase();
        // fetch already decompressed the body and the relay re-chunks it, so
        // these would be wrong on the other side. The relay's server adds its
        // own date header — forwarding the node's would duplicate it.
        if (
          lower === "content-encoding" ||
          lower === "content-length" ||
          lower === "transfer-encoding" ||
          lower === "date"
        )
          return;
        pairs.push([name, value]);
      });
      this.send({ type: "http_res_head", id, status: res.status, headers: pairs });
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const chunk of chunkBytes(value)) {
            this.send({ type: "http_res_chunk", id, dataB64: toB64(chunk) });
          }
        }
      }
      this.send({ type: "http_res_end", id });
    } catch (err) {
      if (!abort.signal.aborted) {
        this.send({
          type: "http_res_error",
          id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── WebSocket bridging ──────────────────────────────────────────

  private openBridgedSocket(id: string, path: string, headers: HeaderPairs): void {
    const wsOrigin = this.opts.targetOrigin.replace(/^http/, "ws");
    let local: WebSocket;
    try {
      const upgrade = localWebSocketOptions(headers);
      if (!upgrade) throw new Error("invalid websocket upgrade headers");
      const WS = WebSocket as unknown as BunWebSocketCtor;
      local = new WS(`${wsOrigin}${path}`, { headers: upgrade.headers });
    } catch (err) {
      this.send({
        type: "ws_open_error",
        id,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const bridged: BridgedSocket = { ws: local, opened: false, buffer: [] };
    this.bridgedSockets.set(id, bridged);

    local.onopen = () => {
      bridged.opened = true;
      this.send({ type: "ws_open_ok", id });
      for (const frame of bridged.buffer) this.deliverToLocal(local, frame);
      bridged.buffer = [];
    };

    local.onmessage = (event) => {
      if (typeof event.data === "string") {
        this.send({ type: "ws_data", id, text: event.data });
      } else {
        const bytes =
          event.data instanceof ArrayBuffer
            ? new Uint8Array(event.data)
            : new Uint8Array(event.data as Uint8Array);
        this.send({ type: "ws_data", id, dataB64: toB64(bytes) });
      }
    };

    local.onclose = (event) => {
      if (this.bridgedSockets.get(id) !== bridged) return;
      this.bridgedSockets.delete(id);
      this.send({ type: "ws_close", id, code: event.code, reason: event.reason });
    };

    local.onerror = () => {
      if (!bridged.opened) {
        this.bridgedSockets.delete(id);
        this.send({ type: "ws_open_error", id, message: "local websocket failed" });
      }
      // Post-open errors surface through onclose.
    };
  }

  private deliverToLocal(
    local: WebSocket,
    frame: Extract<RelayToNodeFrame, { type: "ws_data" }>,
  ): void {
    if (local.readyState !== WebSocket.OPEN) return;
    if (frame.text !== undefined) local.send(frame.text);
    else if (frame.dataB64 !== undefined) local.send(fromB64(frame.dataB64));
  }
}
