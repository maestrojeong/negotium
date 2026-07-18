import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import { serve } from "bun";
import {
  decodeNodeFrame,
  encodeFrame,
  type NodeToRelayFrame,
  PROTOCOL_VERSION,
} from "@/relay-protocol";
import { TunnelClient } from "@/tunnel-client";

interface FakeRelay {
  server: Server<object>;
  socket: ServerWebSocket<object> | null;
  connectionCount: number;
  frames: NodeToRelayFrame[];
  stop(): void;
}

interface TargetSocketData {
  cookie: string | null;
  authorization: string | null;
  protocol: string | null;
}

let target: Server<TargetSocketData>;
let relay: FakeRelay;
let client: TunnelClient;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("waitFor timed out");
}

class HalfOpenWebSocket {
  readonly readyState = WebSocket.OPEN;
  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  closeCalls = 0;
  closeCode: number | undefined;
  closeReason: string | undefined;

  send(): void {}

  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    this.closeCode = code;
    this.closeReason = reason;
    // Deliberately never emit close: model a half-open kernel/proxy socket.
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  receive(data: string): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  emitLateClose(): void {
    this.onclose?.(new CloseEvent("close", { code: 1006, reason: "late" }));
  }
}

beforeAll(async () => {
  target = serve<TargetSocketData>({
    port: 0,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocol = req.headers.get("sec-websocket-protocol");
        return server.upgrade(req, {
          data: {
            cookie: req.headers.get("cookie"),
            authorization: req.headers.get("authorization"),
            protocol,
          },
        })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/echo") {
        return new Response(`echo:${await req.text()}`, {
          status: 201,
          headers: { "x-target": "yes" },
        });
      }
      return Response.json({ ok: true });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify(ws.data));
      },
      message() {},
    },
  });

  const sockets = new Set<ServerWebSocket<object>>();
  relay = {
    server: serve<object>({
      port: 0,
      fetch(req, server) {
        if (new URL(req.url).pathname !== "/tunnel")
          return new Response("not found", { status: 404 });
        return server.upgrade(req, { data: {} })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          relay.socket = ws;
          relay.connectionCount += 1;
        },
        message(ws, raw) {
          const frame = decodeNodeFrame(typeof raw === "string" ? raw : raw.toString());
          if (frame) relay.frames.push(frame);
          if (frame?.type === "register") {
            ws.send(
              encodeFrame({
                type: "registered",
                nodeId: "cell_fake",
                protocolVersion: PROTOCOL_VERSION,
                pingIntervalMs: 100,
              }),
            );
          }
        },
        close(ws) {
          sockets.delete(ws);
          if (relay.socket === ws) relay.socket = null;
        },
      },
    }),
    socket: null,
    connectionCount: 0,
    frames: [],
    stop() {
      for (const socket of sockets) socket.close();
      this.server.stop(true);
    },
  };
  client = new TunnelClient({
    relayUrl: `http://127.0.0.1:${relay.server.port}`,
    token: "rcs_fake",
    targetOrigin: `http://127.0.0.1:${target.port}`,
    minReconnectDelayMs: 10,
    maxReconnectDelayMs: 50,
  });
  client.start();
  await waitFor(() => client.status === "registered");
});

afterAll(() => {
  client.stop();
  relay.stop();
  target.stop(true);
});

describe("Otium relay tunnel client", () => {
  test("rejects plaintext remote relay transport before opening a socket", () => {
    let opened = false;
    expect(
      () =>
        new TunnelClient({
          relayUrl: "ws://relay.example",
          token: "rcs_secret",
          targetOrigin: "http://127.0.0.1:4000",
          webSocketFactory: () => {
            opened = true;
            return new HalfOpenWebSocket() as unknown as WebSocket;
          },
        }),
    ).toThrow("Otium relay requires HTTPS/WSS or loopback HTTP/WS");
    expect(opened).toBe(false);
  });

  test("invalidates and reconnects a half-open tunnel without duplicate reconnects", async () => {
    const sockets: HalfOpenWebSocket[] = [];
    const halfOpenClient = new TunnelClient({
      relayUrl: "wss://relay.invalid",
      token: "rcs_half_open",
      targetOrigin: "http://127.0.0.1:1",
      minReconnectDelayMs: 1,
      maxReconnectDelayMs: 1,
      webSocketFactory: () => {
        const socket = new HalfOpenWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      halfOpenClient.start();
      sockets[0]?.open();
      sockets[0]?.receive(
        encodeFrame({
          type: "registered",
          nodeId: "cell_half_open",
          protocolVersion: PROTOCOL_VERSION,
          pingIntervalMs: 5,
        }),
      );
      expect(halfOpenClient.status).toBe("registered");

      await waitFor(() => sockets.length === 2 && halfOpenClient.status === "connecting");
      expect(sockets[0]?.closeCalls).toBe(1);

      sockets[0]?.emitLateClose();
      await Bun.sleep(10);
      expect(sockets).toHaveLength(2);
      expect(halfOpenClient.status).toBe("connecting");
    } finally {
      halfOpenClient.stop();
    }
  });

  test("closes malformed relay frames as protocol errors without throwing", () => {
    const sockets: HalfOpenWebSocket[] = [];
    const malformedClient = new TunnelClient({
      relayUrl: "wss://relay.invalid",
      token: "rcs_malformed",
      targetOrigin: "http://127.0.0.1:1",
      minReconnectDelayMs: 1_000,
      maxReconnectDelayMs: 1_000,
      webSocketFactory: () => {
        const socket = new HalfOpenWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    try {
      malformedClient.start();
      sockets[0]?.open();
      expect(() =>
        sockets[0]?.receive(
          JSON.stringify({
            type: "http_req_head",
            id: "request",
            method: "POST",
            path: "/echo",
            hasBody: true,
          }),
        ),
      ).not.toThrow();
      expect(sockets[0]?.closeCalls).toBe(1);
      expect(sockets[0]?.closeCode).toBe(1002);
      expect(sockets[0]?.closeReason).toBe("invalid relay frame");
      expect(malformedClient.status).toBe("connecting");
    } finally {
      malformedClient.stop();
    }
  });

  test("a superseded same-credential client stops reconnecting until explicitly restarted", async () => {
    let verifierCount = 0;
    let registerCount = 0;
    let active: ServerWebSocket<object> | null = null;
    const sockets = new Set<ServerWebSocket<object>>();
    const replacementRelay = serve<object>({
      port: 0,
      fetch(req, server) {
        if (new URL(req.url).pathname !== "/tunnel")
          return new Response("not found", { status: 404 });
        if (req.headers.get("authorization") !== "Bearer shared-credential") {
          return new Response("unauthorized", { status: 401 });
        }
        verifierCount += 1;
        return server.upgrade(req, { data: {} })
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
        },
        message(ws, raw) {
          const frame = decodeNodeFrame(typeof raw === "string" ? raw : raw.toString());
          if (frame?.type !== "register") return;
          registerCount += 1;
          if (active && active !== ws) {
            active.send(
              encodeFrame({
                type: "register_error",
                code: "replaced",
                message: "a newer connection for this node registered",
              }),
            );
            active.close(4001, "replaced");
          }
          active = ws;
          ws.send(
            encodeFrame({
              type: "registered",
              nodeId: "shared-node",
              protocolVersion: PROTOCOL_VERSION,
              pingIntervalMs: 60_000,
            }),
          );
        },
        close(ws) {
          sockets.delete(ws);
          if (active === ws) active = null;
        },
      },
    });
    const options = {
      relayUrl: `http://127.0.0.1:${replacementRelay.port}`,
      token: "shared-credential",
      targetOrigin: "http://127.0.0.1:1",
      minReconnectDelayMs: 5,
      maxReconnectDelayMs: 5,
    };
    const older = new TunnelClient(options);
    const newer = new TunnelClient(options);

    try {
      older.start();
      await waitFor(() => older.status === "registered");
      newer.start();
      await waitFor(() => older.status === "superseded" && newer.status === "registered");

      await Bun.sleep(100);
      expect(verifierCount).toBe(2);
      expect(registerCount).toBe(2);
      expect(newer.status).toBe("registered");

      older.start();
      await Bun.sleep(25);
      expect(verifierCount).toBe(2);
      expect(registerCount).toBe(2);

      older.stop();
      newer.stop();
      older.start();
      await waitFor(() => older.status === "registered");
      await Bun.sleep(25);
      expect(verifierCount).toBe(3);
      expect(registerCount).toBe(3);
    } finally {
      older.stop();
      newer.stop();
      for (const socket of sockets) socket.close();
      replacementRelay.stop(true);
    }
  });

  test("waits for a delayed first body chunk before replaying the HTTP request", async () => {
    const originalSocket = relay.socket;
    expect(originalSocket).not.toBeNull();
    relay.frames.length = 0;
    const id = "http-1";
    originalSocket?.send(
      encodeFrame({
        type: "http_req_head",
        id,
        method: "POST",
        path: "/echo",
        headers: [["content-type", "text/plain"]],
        hasBody: true,
      }),
    );
    await Bun.sleep(50);
    expect(relay.frames.some((frame) => frame.type.startsWith("http_res_"))).toBe(false);

    originalSocket?.send(encodeFrame({ type: "http_req_chunk", id, dataB64: btoa("hello") }));
    originalSocket?.send(encodeFrame({ type: "http_req_end", id }));
    await waitFor(() => relay.frames.some((frame) => frame.type === "http_res_end"));
    const head = relay.frames.find((frame) => frame.type === "http_res_head");
    const chunks = relay.frames.filter((frame) => frame.type === "http_res_chunk");
    expect(head).toMatchObject({ type: "http_res_head", id, status: 201 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(
      new TextDecoder().decode(
        Buffer.from(
          (chunks[0] as Extract<NodeToRelayFrame, { type: "http_res_chunk" }>).dataB64,
          "base64",
        ),
      ),
    ).toBe("echo:hello");
  });

  test("starts an empty body-bearing request when the end frame arrives", async () => {
    const socket = relay.socket;
    expect(socket).not.toBeNull();
    relay.frames.length = 0;
    const id = "http-empty-body";
    socket?.send(
      encodeFrame({
        type: "http_req_head",
        id,
        method: "POST",
        path: "/echo",
        headers: [["content-type", "text/plain"]],
        hasBody: true,
      }),
    );
    await Bun.sleep(25);
    expect(relay.frames.some((frame) => frame.type.startsWith("http_res_"))).toBe(false);
    socket?.send(encodeFrame({ type: "http_req_end", id }));

    await waitFor(() => relay.frames.some((frame) => frame.type === "http_res_end"));
    expect(relay.frames.find((frame) => frame.type === "http_res_head")).toMatchObject({
      type: "http_res_head",
      id,
      status: 201,
    });
  });

  test("reconnects after the relay closes the tunnel", async () => {
    const oldSocket = relay.socket;
    const oldConnectionCount = relay.connectionCount;
    expect(oldSocket).not.toBeNull();
    oldSocket?.close();
    await waitFor(
      () =>
        relay.connectionCount > oldConnectionCount &&
        relay.socket !== null &&
        relay.socket !== oldSocket &&
        client.status === "registered",
      2_000,
    );
  });

  test("forwards only allowed WebSocket authentication headers and subprotocol", async () => {
    const socket = relay.socket;
    expect(socket).not.toBeNull();
    relay.frames.length = 0;
    socket?.send(
      encodeFrame({
        type: "ws_open",
        id: "ws-auth-1",
        path: "/ws-auth",
        headers: [
          ["cookie", "session=worker-cookie"],
          ["authorization", "Bearer worker-user-token"],
          ["sec-websocket-protocol", "otium.v2"],
        ],
      }),
    );
    await waitFor(() => relay.frames.some((frame) => frame.type === "ws_data"));
    expect(relay.frames.some((frame) => frame.type === "ws_open_ok")).toBe(true);
    const data = relay.frames.find(
      (frame): frame is Extract<NodeToRelayFrame, { type: "ws_data" }> => frame.type === "ws_data",
    );
    expect(JSON.parse(data?.text ?? "{}")).toEqual({
      cookie: "session=worker-cookie",
      authorization: "Bearer worker-user-token",
      protocol: "otium.v2",
    });
  });

  test("rejects unexpected WebSocket headers and closes header-injection frames", async () => {
    const socket = relay.socket;
    expect(socket).not.toBeNull();
    relay.frames.length = 0;
    socket?.send(
      encodeFrame({
        type: "ws_open",
        id: "ws-invalid-1",
        path: "/ws-auth",
        headers: [["x-forwarded-host", "attacker.example"]],
      }),
    );
    await waitFor(() => relay.frames.some((frame) => frame.type === "ws_open_error"));
    expect(relay.frames.find((frame) => frame.type === "ws_open_error")).toMatchObject({
      id: "ws-invalid-1",
      message: "invalid websocket upgrade headers",
    });

    relay.frames.length = 0;
    const connectionCount = relay.connectionCount;
    socket?.send(
      JSON.stringify({
        type: "ws_open",
        id: "ws-injected-1",
        path: "/ws-auth",
        headers: [["authorization", "Bearer safe\r\nx-injected: yes"]],
      }),
    );
    await waitFor(
      () =>
        relay.connectionCount > connectionCount &&
        relay.socket !== null &&
        relay.socket !== socket &&
        client.status === "registered",
    );
    expect(relay.frames.some((frame) => frame.type === "ws_open_error")).toBe(false);
  });
});
