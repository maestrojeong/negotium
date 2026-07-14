import { afterEach, describe, expect, test } from "bun:test";
import { configureOtiumCentral } from "@/central";
import { otiumPeerRuntimeBridge } from "@/runtime-bridge";
import { HUB_CELL_ID, MINTED_TOKEN, startFakeCentral } from "./helpers";

const running: Array<{ stop: () => void }> = [];

afterEach(() => {
  configureOtiumCentral(null);
  while (running.length > 0) running.pop()?.stop();
});

describe("otium runtime peer bridge", () => {
  test("spawn_subagent posts the canonical turn and input to the hub", async () => {
    let received: { auth: string | null; body: Record<string, unknown> } | undefined;
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/api/v1/peer/bridge/spawn") {
          return Response.json({ ok: false }, { status: 404 });
        }
        received = {
          auth: req.headers.get("authorization"),
          body: (await req.json()) as Record<string, unknown>,
        };
        return Response.json({
          ok: true,
          result: { content: [{ type: "text", text: "spawned on hub" }] },
        });
      },
    });
    running.push(hub);

    const central = startFakeCentral();
    running.push(central);
    central.setHubBaseUrl(`http://127.0.0.1:${hub.port}`);
    configureOtiumCentral(central.join);

    const result = await otiumPeerRuntimeBridge.spawnSubagent({
      bridge: {
        hubCellId: HUB_CELL_ID,
        hostTopicId: "host-parent",
        hostQueryId: "host-query",
        canSpawnSubagents: true,
      },
      userId: "central-user",
      agent: "claude",
      model: "sonnet",
      input: { task: "inspect the worker", name: "inspector" },
    });

    expect(result).toEqual({ content: [{ type: "text", text: "spawned on hub" }] });
    expect(received?.auth).toBe(`Bearer ${MINTED_TOKEN}`);
    expect(received?.body).toEqual({
      hostQueryId: "host-query",
      userId: "central-user",
      agent: "claude",
      model: "sonnet",
      input: { task: "inspect the worker", name: "inspector" },
    });
  });
});
