/**
 * Shared test doubles: a fake otium central-api (verify/token/nodes) and a
 * fake hub runtime-api event sink — both real Bun.serve servers on port 0, so
 * the adapter's HTTP client paths are exercised end-to-end without otium.
 */

import type { OtiumJoin } from "@/join";

const WORKSPACE_ID = "ws_test";
export const HUB_CELL_ID = "cell_hub";
const WORKER_CELL_ID = "cell_worker";

/** Tokens the fake central recognizes. */
export const HUB_TOKEN = "ptk_from_hub";
export const WORKER_PEER_TOKEN = "ptk_from_other_worker";
export const MINTED_TOKEN = "ptk_minted_by_worker";

export interface FakeCentral {
  url: string;
  join: OtiumJoin;
  /** Every /peer/verify token central was asked about. */
  verifyRequests: string[];
  hubBaseUrl: string;
  setHubBaseUrl: (baseUrl: string) => void;
  setWorkerAttached: (attached: boolean) => void;
  addPeerNode: (node: {
    cellId: string;
    nodeName: string | null;
    isPrimary: boolean;
    baseUrl: string;
    self: boolean;
  }) => void;
  stop: () => void;
}

export function startFakeCentral(): FakeCentral {
  const verifyRequests: string[] = [];
  const state = {
    hubBaseUrl: "http://127.0.0.1:1",
    workerAttached: true,
    additionalNodes: [] as Array<{
      cellId: string;
      nodeName: string | null;
      isPrimary: boolean;
      baseUrl: string;
      self: boolean;
    }>,
  };
  const expiresAt = () => new Date(Date.now() + 300_000).toISOString();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer ")) return Response.json({ ok: false }, { status: 401 });
      if (url.pathname === "/peer/verify" && req.method === "POST") {
        const body = (await req.json()) as { token?: string };
        verifyRequests.push(body.token ?? "");
        if (body.token === HUB_TOKEN) {
          return Response.json({
            ok: true,
            workspaceId: WORKSPACE_ID,
            fromCellId: HUB_CELL_ID,
            fromNodeName: null,
            fromIsPrimary: true,
            expiresAt: expiresAt(),
          });
        }
        if (body.token === WORKER_PEER_TOKEN) {
          return Response.json({
            ok: true,
            workspaceId: WORKSPACE_ID,
            fromCellId: "cell_other",
            fromNodeName: "other",
            fromIsPrimary: false,
            expiresAt: expiresAt(),
          });
        }
        return Response.json({ ok: false, error: "peer token unknown" }, { status: 401 });
      }
      if (url.pathname === "/peer/token" && req.method === "POST") {
        return Response.json({
          ok: true,
          token: MINTED_TOKEN,
          expiresAt: expiresAt(),
          workspaceId: WORKSPACE_ID,
        });
      }
      if (url.pathname === "/peer/nodes" && req.method === "GET") {
        return Response.json({
          ok: true,
          workspaceId: WORKSPACE_ID,
          nodes: [
            {
              cellId: HUB_CELL_ID,
              nodeName: null,
              isPrimary: true,
              baseUrl: state.hubBaseUrl,
              self: false,
            },
            ...(state.workerAttached
              ? [
                  {
                    cellId: WORKER_CELL_ID,
                    nodeName: "nego",
                    isPrimary: false,
                    baseUrl: "http://127.0.0.1:7777",
                    self: true,
                  },
                ]
              : []),
            ...state.additionalNodes,
          ],
        });
      }
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    join: { v: 1, central: url, cellId: WORKER_CELL_ID, secret: "rcs_test_secret" },
    verifyRequests,
    get hubBaseUrl() {
      return state.hubBaseUrl;
    },
    setHubBaseUrl: (baseUrl: string) => {
      state.hubBaseUrl = baseUrl;
    },
    setWorkerAttached: (attached: boolean) => {
      state.workerAttached = attached;
    },
    addPeerNode: (node) => {
      state.additionalNodes.push(node);
    },
    stop: () => server.stop(true),
  };
}

interface ReceivedPeerEvent {
  auth: string | null;
  body: { v: number; requestId: string; seq: number; event: Record<string, unknown> };
}

export interface FakeHub {
  url: string;
  events: ReceivedPeerEvent[];
  /** Force the next N event POSTs to fail with this status (0 = network-ish 500). */
  failNext: (count: number, status?: number) => void;
  stop: () => void;
}

export function startFakeHub(): FakeHub {
  const events: ReceivedPeerEvent[] = [];
  const failures = { remaining: 0, status: 500 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/peer/event" && req.method === "POST") {
        if (failures.remaining > 0) {
          failures.remaining--;
          return Response.json(
            { ok: false, error: "injected failure" },
            { status: failures.status },
          );
        }
        const body = (await req.json()) as ReceivedPeerEvent["body"];
        events.push({ auth: req.headers.get("authorization"), body });
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not found" }, { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    events,
    failNext: (count, status = 500) => {
      failures.remaining = count;
      failures.status = status;
    },
    stop: () => server.stop(true),
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) throw new Error("waitFor: condition not met in time");
}
