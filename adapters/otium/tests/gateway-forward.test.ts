import { expect, test } from "bun:test";
import { NODE_CONTROL_TOKEN } from "@negotium/core";
import { forwardGatewayRequest, OTIUM_GATEWAY_FORWARD_PREFIX } from "../src/gateway-forward";

const NODE_ORIGIN = "http://127.0.0.1:41999";

function forwardRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://relay.example/${OTIUM_GATEWAY_FORWARD_PREFIX.slice(1)}${path}`, {
    ...init,
    headers: {
      // What the hub actually presents: a short-lived Central-minted peer token.
      authorization: "Bearer peer-token-from-central",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
}

/** Capture the loopback request the forwarder would make. */
function captureFetch(): { calls: Request[]; fetch: typeof fetch } {
  const calls: Request[] = [];
  const stub = (async (input: Request | string | URL) => {
    const request = input instanceof Request ? input : new Request(String(input));
    calls.push(request);
    return Response.json({ ok: true, v: 1 });
  }) as typeof fetch;
  return { calls, fetch: stub };
}

test("returns null for paths outside the gateway forward prefix", async () => {
  const { fetch: stub, calls } = captureFetch();
  const response = await forwardGatewayRequest(
    new Request("https://relay.example/api/v1/peer/turn", { method: "POST", body: "{}" }),
    { nodeOrigin: NODE_ORIGIN, fetch: stub },
  );
  expect(response).toBeNull();
  expect(calls).toHaveLength(0);
});

test("rewrites onto the runtime contract path and swaps in the node control token", async () => {
  const { fetch: stub, calls } = captureFetch();
  const response = await forwardGatewayRequest(forwardRequest("/health"), {
    nodeOrigin: NODE_ORIGIN,
    fetch: stub,
  });

  expect(response?.status).toBe(200);
  expect(calls).toHaveLength(1);
  const forwarded = calls[0];
  expect(forwarded.url).toBe(`${NODE_ORIGIN}/api/v1/control/runtime/v1/health`);
  // The peer token must not survive the hop; the node only accepts its own.
  expect(forwarded.headers.get("authorization")).toBe(`Bearer ${NODE_CONTROL_TOKEN}`);
});

test("preserves the query string so SSE resume cursors survive the relay", async () => {
  const { fetch: stub, calls } = captureFetch();
  await forwardGatewayRequest(forwardRequest("/events?after=42&topicId=abc"), {
    nodeOrigin: NODE_ORIGIN,
    fetch: stub,
  });
  const url = new URL(calls[0].url);
  expect(url.pathname).toBe("/api/v1/control/runtime/v1/events");
  expect(url.searchParams.get("after")).toBe("42");
  expect(url.searchParams.get("topicId")).toBe("abc");
});

test("forwards the whole read/turn contract the gateway client speaks", async () => {
  for (const [method, path] of [
    ["GET", "/health"],
    ["GET", "/events"],
    ["GET", "/topics"],
    ["GET", "/topics/abc"],
    ["GET", "/topics/abc/messages"],
    ["POST", "/turns"],
  ] as const) {
    const { fetch: stub, calls } = captureFetch();
    const response = await forwardGatewayRequest(
      forwardRequest(path, { method, ...(method === "POST" ? { body: "{}" } : {}) }),
      { nodeOrigin: NODE_ORIGIN, fetch: stub },
    );
    expect(response?.status, `${method} ${path}`).toBe(200);
    expect(calls, `${method} ${path}`).toHaveLength(1);
  }
});

test("refuses control routes that are not part of the gateway contract", async () => {
  // These exist on the node but are loopback-only: reaching them with a peer
  // token would let the hub delete topics or read the vault on the worker.
  for (const [method, path] of [
    ["POST", "/topics/abc/access-mode"],
    ["DELETE", "/topics/abc"],
    ["POST", "/topics/abc/session/reset"],
    ["GET", "/vault"],
    ["POST", "/shutdown"],
    ["GET", "/status"],
    ["POST", "/topics"],
  ] as const) {
    const { fetch: stub, calls } = captureFetch();
    const response = await forwardGatewayRequest(
      forwardRequest(path, { method, ...(method === "GET" ? {} : { body: "{}" }) }),
      { nodeOrigin: NODE_ORIGIN, fetch: stub },
    );
    expect(response?.status, `${method} ${path}`).toBe(404);
    // Nothing may reach the node, so the token swap never happens either.
    expect(calls, `${method} ${path}`).toHaveLength(0);
  }
});

test("refuses a write method on an otherwise allowed read path", async () => {
  const { fetch: stub, calls } = captureFetch();
  const response = await forwardGatewayRequest(
    forwardRequest("/topics/abc", { method: "DELETE" }),
    { nodeOrigin: NODE_ORIGIN, fetch: stub },
  );
  expect(response?.status).toBe(404);
  expect(calls).toHaveLength(0);
});

test("does not let a nested path escape the allowed topic shape", async () => {
  for (const path of ["/topics/abc/vault", "/topics/abc/messages/extra", "/topics/abc/abort"]) {
    const { fetch: stub, calls } = captureFetch();
    const response = await forwardGatewayRequest(forwardRequest(path), {
      nodeOrigin: NODE_ORIGIN,
      fetch: stub,
    });
    expect(response?.status, path).toBe(404);
    expect(calls, path).toHaveLength(0);
  }
});

test("dot-segment traversal cannot reach the node with a peer token", async () => {
  // `new URL` normalizes `..` away, so a traversal attempt lands outside the
  // forward prefix and is declined here (null → the peer router 404s it).
  // Crucially it never reaches the token swap, so even if a later handler saw
  // the path it would still carry only the peer token, which the node rejects.
  for (const path of ["/../status", "/../../control/runtime/v1/health", "/../shutdown"]) {
    const { fetch: stub, calls } = captureFetch();
    const response = await forwardGatewayRequest(forwardRequest(path), {
      nodeOrigin: NODE_ORIGIN,
      fetch: stub,
    });
    expect(response, path).toBeNull();
    expect(calls, path).toHaveLength(0);
  }
});
