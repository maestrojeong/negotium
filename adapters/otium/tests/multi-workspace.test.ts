/**
 * M-5 / M-8 — two workspaces attached at once.
 *
 * The whole point of multi-join is that the workspaces cannot see each other,
 * so these tests are the security argument for the feature, not a convenience
 * check: they assert that a peer authenticated by one workspace's Central is
 * refused by every room belonging to the other.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { registerTopic, setDefaultSurfaceScope, setSurfaceScopeRequired } from "@negotium/core";
import {
  attachedOtiumCells,
  attachOtiumCentralCell,
  configureOtiumCentral,
  detachOtiumCentralCell,
  resetPeerCentralCaches,
} from "@/central";
import { handleOtiumPeerRequest } from "@/peer-server";
import { PEER_PROTOCOL_VERSION } from "@/protocol";
import { otiumPeerSessionBridge } from "@/session-bridge";
import { resolveSurfaceScope, surfaceScopeForCell } from "@/workspace-scope";
import { type FakeCentral, startFakeCentral } from "./helpers";

const BASE = "http://worker.local";
const USER = `multi-ws-user-${randomUUID().slice(0, 8)}`;
const ALPHA_HUB_TOKEN = "ptk_alpha_hub";
const BETA_HUB_TOKEN = "ptk_beta_hub";

let alpha: FakeCentral;
let beta: FakeCentral;
let alphaScope: string | null = null;
let betaScope: string | null = null;
const createdTopicIds: string[] = [];

beforeAll(async () => {
  alpha = startFakeCentral({
    workspaceId: "ws_alpha",
    workerCellId: "cell_worker_alpha",
    hubCellId: "cell_hub_alpha",
    hubToken: ALPHA_HUB_TOKEN,
  });
  beta = startFakeCentral({
    workspaceId: "ws_beta",
    workerCellId: "cell_worker_beta",
    hubCellId: "cell_hub_beta",
    hubToken: BETA_HUB_TOKEN,
  });
  configureOtiumCentral(null);
  attachOtiumCentralCell(alpha.join);
  attachOtiumCentralCell(beta.join);
  alphaScope = await resolveSurfaceScope(alpha.join);
  betaScope = await resolveSurfaceScope(beta.join);
});

afterAll(() => {
  // The suite runs against a throwaway store (tests/setup.ts), so the rooms go
  // with it; cascading deletes here would only race the runtime's topic locks.
  createdTopicIds.length = 0;
  setDefaultSurfaceScope(null);
  setSurfaceScopeRequired(false);
  configureOtiumCentral(null);
  alpha.stop();
  beta.stop();
});

function makeRoom(scope: string | null): { id: string; title: string } {
  const previous = setDefaultSurfaceScope(scope);
  try {
    const topic = registerTopic({
      title: `multi-ws-${randomUUID().slice(0, 8)}`,
      userId: USER,
      kind: "agent",
      agent: "claude",
      surface: "otium",
    });
    createdTopicIds.push(topic.id);
    return { id: topic.id, title: topic.title };
  } finally {
    setDefaultSurfaceScope(previous);
  }
}

function makeNamedRoom(title: string, scope: string | null) {
  const previous = setDefaultSurfaceScope(scope);
  try {
    const topic = registerTopic({
      title,
      userId: USER,
      kind: "agent",
      agent: "claude",
      surface: "otium",
    });
    createdTopicIds.push(topic.id);
    return topic;
  } finally {
    setDefaultSurfaceScope(previous);
  }
}

async function tell(token: string, toTopic: string) {
  const response = await handleOtiumPeerRequest(
    new Request(`${BASE}/api/v1/peer/tell`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        v: PEER_PROTOCOL_VERSION,
        requestId: randomUUID(),
        userId: USER,
        toTopic,
        fromLabel: "hub/peer",
        message: "cross-workspace probe",
        depth: 0,
      }),
    }),
  );
  if (!response) throw new Error("expected a peer response");
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("two attached workspaces", () => {
  test("each cell keeps its own credentials and resolves its own workspace", () => {
    expect(
      attachedOtiumCells()
        .map((join) => join.cellId)
        .sort(),
    ).toEqual(["cell_worker_alpha", "cell_worker_beta"]);
    expect(alphaScope).not.toBeNull();
    expect(betaScope).not.toBeNull();
    // Two workspaces are two namespaces; sharing a scope would merge them.
    expect(alphaScope).not.toBe(betaScope);
    expect(surfaceScopeForCell("cell_worker_alpha")).toBe(alphaScope);
    expect(surfaceScopeForCell("cell_worker_beta")).toBe(betaScope);
  });

  test("the same room name may exist in both workspaces", () => {
    const first = makeRoom(alphaScope);
    const previous = setDefaultSurfaceScope(betaScope);
    try {
      const second = registerTopic({
        title: first.title,
        userId: USER,
        kind: "agent",
        agent: "claude",
        surface: "otium",
      });
      createdTopicIds.push(second.id);
      expect(second.id).not.toBe(first.id);
      expect(second.surfaceScope).toBe(betaScope);
    } finally {
      setDefaultSurfaceScope(previous);
    }
  });

  test("a peer verified for one workspace cannot address the other's room", async () => {
    const room = makeRoom(alphaScope);
    resetPeerCentralCaches();

    const refused = await tell(BETA_HUB_TOKEN, room.title);
    expect(refused.status).toBe(404);

    const accepted = await tell(ALPHA_HUB_TOKEN, room.title);
    expect(accepted.status).toBe(200);
  });

  test("an unscoped room is nobody's while two workspaces are attached", async () => {
    // With one attachment an unscoped room is legacy and must stay reachable.
    // With two it is genuinely ambiguous, and handing it to both hubs would
    // quietly undo the isolation the feature exists for, so it is reachable
    // from neither until it is filed.
    const room = makeRoom(null);
    expect((await tell(BETA_HUB_TOKEN, room.title)).status).toBe(404);
    expect((await tell(ALPHA_HUB_TOKEN, room.title)).status).toBe(404);

    detachOtiumCentralCell("cell_worker_beta");
    try {
      expect((await tell(ALPHA_HUB_TOKEN, room.title)).status).toBe(200);
    } finally {
      attachOtiumCentralCell(beta.join);
    }
  });

  test("a title used in both workspaces resolves to the caller's own", async () => {
    const title = `dup-${randomUUID().slice(0, 8)}`;
    const inAlpha = makeNamedRoom(title, alphaScope);
    const inBeta = makeNamedRoom(title, betaScope);
    expect(inAlpha.id).not.toBe(inBeta.id);
    resetPeerCentralCaches();

    // The doc's headline promise: `paper` may exist in each workspace. An
    // unscoped lookup matched twice and the ambiguity guard returned nothing,
    // so the name was unaddressable from *both* sides.
    expect((await tell(ALPHA_HUB_TOKEN, title)).status).toBe(200);
    expect((await tell(BETA_HUB_TOKEN, title)).status).toBe(200);
  });

  test("peer session listing answers inside the asking room's workspace", async () => {
    alpha.addPeerNode({
      cellId: "cell_peer_alpha",
      nodeName: "hub",
      isPrimary: true,
      baseUrl: "http://127.0.0.1:1",
      self: false,
    });
    beta.addPeerNode({
      cellId: "cell_peer_beta",
      nodeName: "hub",
      isPrimary: true,
      baseUrl: "http://127.0.0.1:1",
      self: false,
    });
    resetPeerCentralCaches();

    // Both workspaces run a node called "hub", so an unscoped answer is the
    // union and tells a workspace A room which nodes workspace B runs.
    const unscopedAnswer = await otiumPeerSessionBridge.sessions(USER);
    expect((unscopedAnswer.nodes ?? []).length).toBe(2);

    const inAlpha = makeNamedRoom(`sessions-${randomUUID().slice(0, 8)}`, alphaScope);
    const answered = await otiumPeerSessionBridge.sessions(USER, undefined, inAlpha.id);
    expect((answered.nodes ?? []).length).toBe(1);
  });

  test("a room must name a workspace while several are attached", () => {
    setSurfaceScopeRequired(true);
    try {
      // Creating it unscoped would file it where no workspace can see it
      // (M-10), so refuse where the caller can still be told.
      expect(() =>
        registerTopic({
          title: `needs-scope-${randomUUID().slice(0, 8)}`,
          userId: USER,
          kind: "agent",
          agent: "claude",
          surface: "otium",
        }),
      ).toThrow("several Otium workspaces");

      // Naming one is fine, and so is a terminal room, which has no workspaces.
      const scoped = makeNamedRoom(`scoped-${randomUUID().slice(0, 8)}`, alphaScope);
      expect(scoped.surfaceScope).toBe(alphaScope);
      const local = registerTopic({
        title: `local-${randomUUID().slice(0, 8)}`,
        userId: USER,
        kind: "agent",
        agent: "claude",
        surface: "terminal",
      });
      createdTopicIds.push(local.id);
    } finally {
      setSurfaceScopeRequired(false);
    }
  });

  test("detaching one workspace leaves the other authenticated", async () => {
    const room = makeRoom(alphaScope);
    expect(detachOtiumCentralCell("cell_worker_beta")).toBe(true);
    try {
      expect((await tell(BETA_HUB_TOKEN, room.title)).status).toBe(401);
      expect((await tell(ALPHA_HUB_TOKEN, room.title)).status).toBe(200);
    } finally {
      attachOtiumCentralCell(beta.join);
    }
  });
});
