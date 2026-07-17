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

let target: Server<object>;
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

beforeAll(async () => {
  target = serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/echo") {
        return new Response(`echo:${await req.text()}`, {
          status: 201,
          headers: { "x-target": "yes" },
        });
      }
      return Response.json({ ok: true });
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
  test("replays a chunked HTTP request and returns chunked response frames", async () => {
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
});
