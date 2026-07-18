import { afterEach, describe, expect, test } from "bun:test";
import { NODE_CONTROL_TOKEN } from "@negotium/core";
import { configureOtiumCentral } from "@/central";
import {
  handleOtiumAdapterControlRequest,
  OTIUM_ADAPTER_CONTROL_HEADER,
  OTIUM_ADAPTER_CONTROL_PREFIX,
} from "@/node-runtime";
import { proxyOtiumPeerRequest } from "@/sidecar";

afterEach(() => configureOtiumCentral(null));

describe("Otium node adapter control bridge", () => {
  test("is hidden behind the adapter token and rewrites the public peer path", async () => {
    configureOtiumCentral({
      central: "https://otium.invalid",
      cellId: "cell-test",
      secret: "secret-test",
    });
    const url = `http://127.0.0.1${OTIUM_ADAPTER_CONTROL_PREFIX}/ready`;

    const unauthorized = await handleOtiumAdapterControlRequest(new Request(url));
    expect(unauthorized?.status).toBe(401);

    const authorized = await handleOtiumAdapterControlRequest(
      new Request(url, { headers: { [OTIUM_ADAPTER_CONTROL_HEADER]: NODE_CONTROL_TOKEN } }),
    );
    expect(authorized?.status).toBe(200);
    expect(await authorized?.json()).toEqual({ ok: true });
  });

  test("does not claim unrelated node routes", async () => {
    expect(
      await handleOtiumAdapterControlRequest(new Request("http://127.0.0.1/health")),
    ).toBeNull();
  });
});

describe("Otium sidecar proxy", () => {
  test("buffers and forwards POST payloads to the canonical Node", async () => {
    let forwarded: Request | undefined;
    const response = await proxyOtiumPeerRequest(
      new Request("http://sidecar/api/v1/peer/provision", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
        body: JSON.stringify({ topicId: "topic-1" }),
      }),
      {
        inspectNode: async () => ({
          running: true,
          info: {
            schemaVersion: 1 as const,
            protocolVersion: 1,
            nodeVersion: "test",
            pid: 4000,
            port: 4000,
            stateDir: "/tmp/test",
            startedAt: new Date().toISOString(),
          },
        }),
        fetch: (async (request: Request) => {
          forwarded = request;
          return Response.json({ ok: true });
        }) as typeof fetch,
      },
    );

    expect(response.status).toBe(200);
    expect(forwarded?.url).toBe(
      `http://127.0.0.1:4000${OTIUM_ADAPTER_CONTROL_PREFIX}/api/v1/peer/provision`,
    );
    expect(forwarded?.headers.get("transfer-encoding")).toBeNull();
    expect(forwarded?.headers.get("content-length")).toBe("21");
    expect(await forwarded?.json()).toEqual({ topicId: "topic-1" });
  });

  test("discovers the advertised Node for every request so restarts reconnect", async () => {
    const ports = [41001, 41002];
    const seen: string[] = [];
    const inspectNode = async () => {
      const port = ports.shift() ?? 41002;
      return {
        running: true,
        info: {
          schemaVersion: 1 as const,
          protocolVersion: 1,
          nodeVersion: "test",
          pid: port,
          port,
          stateDir: "/tmp/test",
          startedAt: new Date().toISOString(),
        },
      };
    };
    const fetchRequest = async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input.toString());
      seen.push(request.url);
      expect(request.headers.get(OTIUM_ADAPTER_CONTROL_HEADER)).toBe(NODE_CONTROL_TOKEN);
      return Response.json({ ok: true });
    };

    await proxyOtiumPeerRequest(new Request("http://sidecar/api/v1/peer/health"), {
      inspectNode,
      fetch: fetchRequest as typeof fetch,
    });
    await proxyOtiumPeerRequest(new Request("http://sidecar/api/v1/peer/health"), {
      inspectNode,
      fetch: fetchRequest as typeof fetch,
    });

    expect(seen).toEqual([
      `http://127.0.0.1:41001${OTIUM_ADAPTER_CONTROL_PREFIX}/api/v1/peer/health`,
      `http://127.0.0.1:41002${OTIUM_ADAPTER_CONTROL_PREFIX}/api/v1/peer/health`,
    ]);
  });

  test("returns a clear 503 while the canonical Node is unavailable", async () => {
    const response = await proxyOtiumPeerRequest(new Request("http://sidecar/api/v1/peer/health"), {
      inspectNode: async () => ({ running: false }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("unavailable") });
  });
});
