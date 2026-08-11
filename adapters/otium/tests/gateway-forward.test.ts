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

test("forwards the whole read/turn/room-mutation contract the gateway client speaks", async () => {
  for (const [method, path] of [
    ["GET", "/health"],
    ["GET", "/events"],
    ["GET", "/topics"],
    ["GET", "/topics/abc"],
    ["GET", "/topics/abc/messages"],
    ["POST", "/turns"],
    // Creating a room on the worker the hub already drives: the same hub that
    // may start turns on, reconfigure and delete this worker's rooms may also
    // bring one into existence, and without it the Otium worker picker has no
    // way to place a room at all.
    ["POST", "/topics"],
    // A hub deleting a topic it mirrored from this worker must reach the
    // worker's own copy, or the next sync pass just re-mirrors it (D-1/D-8).
    ["DELETE", "/topics/abc"],
    // Same for reconfiguring it: the turn runner reads the worker's own
    // agent/model/effort, so a hub-side picker is cosmetic without this.
    ["PATCH", "/topics/abc"],
    // Stopping and re-seating the session of a room the hub already runs turns
    // on. Abort is narrower than the POST /turns already allowed above.
    ["POST", "/topics/abc/abort"],
    ["POST", "/topics/abc/session/reset"],
    ["POST", "/topics/abc/session/compact"],
  ] as const) {
    const { fetch: stub, calls } = captureFetch();
    const response = await forwardGatewayRequest(
      forwardRequest(path, {
        method,
        ...(method === "POST" || method === "PATCH" ? { body: "{}" } : {}),
      }),
      { nodeOrigin: NODE_ORIGIN, fetch: stub },
    );
    expect(response?.status, `${method} ${path}`).toBe(200);
    expect(calls, `${method} ${path}`).toHaveLength(1);
  }
});

test("refuses control routes that are not part of the gateway contract", async () => {
  // These exist on the node but are loopback-only: reaching them with a peer
  // token would let the hub fork a worker's room, seed a transcript it did not
  // witness, or read the vault. The room operations the hub does own — creating,
  // deleting, reconfiguring — are asserted as allowed above.
  for (const [method, path] of [
    ["POST", "/topics/abc/access-mode"],
    ["POST", "/topics/abc/derive"],
    ["POST", "/topics/abc/model"],
    ["GET", "/vault"],
    ["POST", "/shutdown"],
    ["GET", "/status"],
    ["POST", "/topics/abc/import"],
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

test("refuses a write method that is not part of the contract", async () => {
  // DELETE and PATCH on `/topics/:id` are allowed; nothing else is, so a method
  // the contract never names cannot ride in on an allowed path.
  for (const method of ["PUT", "POST"] as const) {
    const { fetch: stub, calls } = captureFetch();
    const response = await forwardGatewayRequest(
      forwardRequest("/topics/abc", { method, body: "{}" }),
      { nodeOrigin: NODE_ORIGIN, fetch: stub },
    );
    expect(response?.status, method).toBe(404);
    expect(calls, method).toHaveLength(0);
  }
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

test("the room mutations stay pinned to a single topic segment", async () => {
  // `/topics/abc/messages` is a legitimate GET, so the mutation regex must not
  // simply inherit the read shape — a DELETE or PATCH there would be a
  // different, unreviewed operation on the worker.
  for (const [method, path] of [
    ["DELETE", "/topics"],
    ["DELETE", "/topics/abc/messages"],
    ["DELETE", "/topics/abc/session/reset"],
    ["PATCH", "/topics"],
    ["PATCH", "/topics/abc/messages"],
    ["PATCH", "/turns"],
  ] as const) {
    const { fetch: stub, calls } = captureFetch();
    const response = await forwardGatewayRequest(forwardRequest(path, { method, body: "{}" }), {
      nodeOrigin: NODE_ORIGIN,
      fetch: stub,
    });
    expect(response?.status, `${method} ${path}`).toBe(404);
    expect(calls, `${method} ${path}`).toHaveLength(0);
  }
});

test("the forwarded POST sub-paths are exact, not a /topics/:id/* wildcard", async () => {
  // The turn/session operations are the only POSTs under a topic that the hub
  // owns. Anything else the node grows under the same prefix — forking a room,
  // seeding history, switching models — must stay loopback-only until it is
  // reviewed on its own terms.
  for (const path of [
    "/topics/abc/session",
    "/topics/abc/session/reset/extra",
    "/topics/abc/abort/extra",
    "/topics/abc/def/abort",
    "/topics/abc/import",
    "/topics/abc/derive",
    // Creation is an exact path, so it must not read as a prefix that drags in
    // whatever the node later mounts beneath it.
    "/topics/",
    "/topics//",
    "/topics/abc/anything",
  ]) {
    const { fetch: stub, calls } = captureFetch();
    const response = await forwardGatewayRequest(
      forwardRequest(path, { method: "POST", body: "{}" }),
      { nodeOrigin: NODE_ORIGIN, fetch: stub },
    );
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
