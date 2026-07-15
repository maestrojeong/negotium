import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "@negotium/core";
import { configureOtiumCentral } from "@/central";
import { createTurnForwarder, registerTurnForwarder } from "@/event-backflow";
import { otiumPeerRuntimeBridge } from "@/runtime-bridge";
import { HUB_CELL_ID, MINTED_TOKEN, startFakeCentral } from "./helpers";

const running: Array<{ stop: () => void }> = [];

afterEach(() => {
  configureOtiumCentral(null);
  while (running.length > 0) running.pop()?.stop();
});

describe("otium runtime peer bridge", () => {
  test("flushEvents waits for the ordered peer event chain", async () => {
    const delivered: number[] = [];
    const forwarder = createTurnForwarder({
      hostNodeId: HUB_CELL_ID,
      requestId: `barrier-${crypto.randomUUID()}`,
      localTopicId: "local-barrier-topic",
      sendEvent: async ({ seq }) => {
        await Bun.sleep(10);
        delivered.push(seq);
        return { ok: true };
      },
    });
    forwarder.queryId = "query-barrier";
    registerTurnForwarder("local-barrier-topic", forwarder);
    forwarder.tap({ type: "tool_call", queryId: "query-barrier" });

    expect(await otiumPeerRuntimeBridge.flushEvents("local-barrier-topic")).toBe(true);
    expect(delivered).toEqual([1]);
    forwarder.finish({ type: "ai_aborted", queryId: "query-barrier" });
    await forwarder.chain;
  });

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

  test("show_html returns the hub-owned visual URL", async () => {
    let received: Record<string, unknown> | undefined;
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        received = (await req.json()) as Record<string, unknown>;
        return Response.json({ ok: true, id: 42, url: "/api/v1/topics/host/visual/42/html" });
      },
    });
    running.push(hub);
    const central = startFakeCentral();
    running.push(central);
    central.setHubBaseUrl(`http://127.0.0.1:${hub.port}`);
    configureOtiumCentral(central.join);

    const result = await otiumPeerRuntimeBridge.showVisual({
      bridge: {
        hubCellId: HUB_CELL_ID,
        hostTopicId: "host-parent",
        hostQueryId: "host-query",
        canSpawnSubagents: true,
      },
      userId: "central-user",
      agent: "claude",
      kind: "html",
      html: "<p>hello</p>",
      title: "Card",
    });

    expect(result).toEqual({
      ok: true,
      id: 42,
      url: "/api/v1/topics/host/visual/42/html",
      title: null,
    });
    expect(received).toEqual({
      hostQueryId: "host-query",
      userId: "central-user",
      kind: "html",
      title: "Card",
      html: "<p>hello</p>",
    });
  });

  test("output files are uploaded to the hub as announced attachments", async () => {
    let received: { announce?: unknown; text?: string } = {};
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const form = await req.formData();
        const file = form.get("file");
        received = {
          announce: form.get("announce"),
          text: file instanceof File ? await file.text() : undefined,
        };
        return Response.json({ ok: true, attachment: { id: "hub-file" } });
      },
    });
    running.push(hub);
    const central = startFakeCentral();
    running.push(central);
    central.setHubBaseUrl(`http://127.0.0.1:${hub.port}`);
    configureOtiumCentral(central.join);
    const dir = join(DATA_DIR, "otium-runtime-bridge-test");
    const path = join(dir, "result.txt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "result bytes");

    try {
      const result = await otiumPeerRuntimeBridge.sendFile({
        bridge: {
          hubCellId: HUB_CELL_ID,
          hostTopicId: "host-parent",
          hostQueryId: "host-query",
          canSpawnSubagents: true,
        },
        userId: "central-user",
        agent: "claude",
        path,
        source: "tool",
      });
      expect(result).toEqual({ ok: true });
      expect(received).toEqual({ announce: "true", text: "result bytes" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
