import { describe, expect, test } from "bun:test";
import { getApiMessage, getTopic, listApiMessages, updateTopic, upsertTopic } from "@negotium/core";
import { configureOtiumCentral } from "@/central";
import { createTurnForwarder, registerTurnForwarder } from "@/event-backflow";
import { handleOtiumPeerRequest } from "@/peer-server";
import {
  acceptSharedTopicMessages,
  checkPeerAttachment,
  disconnectSharedTopics,
  forwardSharedTopicMessage,
  startSharedTopicSync,
} from "@/shared-topic-sync";
import { getPeerSession, getSharedTopicState, setSharedTopicState } from "@/store";
import { provisionMirrorTopic } from "@/turn-bridge";
import { HUB_TOKEN, startFakeCentral, waitFor } from "./helpers";

function topic(id: string) {
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: id,
    kind: "agent",
    agent: "maestro",
    aiMode: "always",
    defaultModel: "",
    defaultEffort: "medium",
    participants: [{ userId: "hub-user", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
    visibility: "visible",
    accessMode: "shared",
  });
  return getTopic(id)!;
}

describe("shared topic transcript sync", () => {
  test("publishes with the Hub contract and fully deletes the Hub copy on private", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const hub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        const body = req.method === "DELETE" ? null : await req.json().catch(() => null);
        requests.push({ method: req.method, path: url.pathname, body });
        if (req.method === "POST" && url.pathname === "/api/v1/peer/shared-topic") {
          const localTopicId = (body as { localTopicId: string }).localTopicId;
          return Response.json({ ok: true, hostTopicId: `hub-${localTopicId}`, created: true });
        }
        return Response.json({ ok: true, inserted: 0, duplicates: 0 });
      },
    });
    const central = startFakeCentral();
    central.setHubBaseUrl(`http://127.0.0.1:${hub.port}`);
    configureOtiumCentral(central.join);
    const localTopicId = `contract-${crypto.randomUUID()}`;
    topic(localTopicId);
    const stop = startSharedTopicSync(central.join);
    await waitFor(() => getSharedTopicState(localTopicId)?.status === "published");

    const publish = requests.find(
      (request) =>
        request.method === "POST" &&
        request.path === "/api/v1/peer/shared-topic" &&
        (request.body as { localTopicId?: string })?.localTopicId === localTopicId,
    );
    expect(publish?.body).toMatchObject({
      v: 1,
      localTopicId,
      title: localTopicId,
      agent: "maestro",
      effort: "medium",
    });
    expect((publish?.body as { model?: string }).model).toBeTruthy();

    updateTopic(localTopicId, { accessMode: "private" });
    await waitFor(() =>
      requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path === `/api/v1/peer/shared-topic/${encodeURIComponent(localTopicId)}` &&
          request.body === null,
      ),
    );
    expect(getSharedTopicState(localTopicId)).toBeNull();
    stop();
    central.stop();
    hub.stop(true);
    configureOtiumCentral(null);
  });

  test("deduplicates an echoed message by source node and source message id", () => {
    const localTopicId = `sync-${crypto.randomUUID()}`;
    topic(localTopicId);
    const message = {
      sourceMessageId: "hub-msg-1",
      author: "user" as const,
      text: "hello from hub",
      createdAt: new Date().toISOString(),
    };
    expect(acceptSharedTopicMessages([message], localTopicId, "hub-cell")).toBe(1);
    expect(acceptSharedTopicMessages([message], localTopicId, "hub-cell")).toBe(0);
    expect(listApiMessages(localTopicId, { limit: 10 }).page).toHaveLength(1);
    expect(getApiMessage(localTopicId, "hub-msg-1")).toMatchObject({
      sourceNode: "hub-cell",
      sourceMessageId: "hub-msg-1",
    });
  });

  test("disconnect downgrades locally even when Hub is unreachable", async () => {
    const localTopicId = `disconnect-${crypto.randomUUID()}`;
    topic(localTopicId);
    setSharedTopicState({ localTopicId, hostTopicId: "hub-copy", status: "published" });
    await disconnectSharedTopics({
      central: "http://127.0.0.1:1",
      cellId: "cell-worker",
      secret: "secret",
    });
    expect(getTopic(localTopicId)?.accessMode).toBe("private");
    expect(getSharedTopicState(localTopicId)).toBeNull();
  });

  test("Hub revoke downgrades all local shared topics and reconnect does not republish", async () => {
    const central = startFakeCentral();
    configureOtiumCentral(central.join);
    const localTopicId = `revoked-${crypto.randomUUID()}`;
    topic(localTopicId);
    setSharedTopicState({ localTopicId, hostTopicId: "hub-copy", status: "published" });
    central.setWorkerAttached(false);
    expect(await checkPeerAttachment(central.join)).toBe(false);
    expect(getTopic(localTopicId)?.accessMode).toBe("private");
    central.setWorkerAttached(true);
    expect(getSharedTopicState(localTopicId)).toBeNull();
    central.stop();
    configureOtiumCentral(null);
  });

  test("Hub-removal endpoint downgrades locally without a Hub delete call", async () => {
    const central = startFakeCentral();
    configureOtiumCentral(central.join);
    const localTopicId = `endpoint-${crypto.randomUUID()}`;
    topic(localTopicId);
    setSharedTopicState({ localTopicId, hostTopicId: "hub-copy", status: "published" });
    const response = await handleOtiumPeerRequest(
      new Request("http://worker/api/v1/peer/shared-topics/private", {
        method: "POST",
        headers: { authorization: `Bearer ${HUB_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ v: 1, reason: "hub-removal" }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(getTopic(localTopicId)?.accessMode).toBe("private");
    central.stop();
    configureOtiumCentral(null);
  });

  test("Hub removal also privatizes visible execution mirrors and removes their binding", async () => {
    const central = startFakeCentral();
    configureOtiumCentral(central.join);
    const hostTopicId = `host-${crypto.randomUUID()}`;
    const result = provisionMirrorTopic("cell_hub", {
      userId: "hub-user",
      hostTopicId,
      topicTitle: "placed room",
      execution: {
        agent: "maestro",
        model: "",
        effort: "medium",
        mcp: [],
        canSpawnSubagents: true,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(getTopic(result.localTopicId)?.isSubagent).toBeUndefined();
    expect(getPeerSession("cell_hub", hostTopicId)).not.toBeNull();

    const response = await handleOtiumPeerRequest(
      new Request("http://worker/api/v1/peer/shared-topics/private", {
        method: "POST",
        headers: { authorization: `Bearer ${HUB_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ v: 1, reason: "hub-removal" }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(getTopic(result.localTopicId)?.accessMode).toBe("private");
    expect(getPeerSession("cell_hub", hostTopicId)).toBeNull();
    central.stop();
    configureOtiumCentral(null);
  });

  test("placed-turn messages are excluded from generic transcript forwarding", async () => {
    const central = startFakeCentral();
    configureOtiumCentral(central.join);
    const localTopicId = `placed-sync-${crypto.randomUUID()}`;
    topic(localTopicId);
    setSharedTopicState({ localTopicId, hostTopicId: "hub-copy", status: "published" });
    const forwarder = createTurnForwarder({
      hostNodeId: "cell_hub",
      requestId: "placed-request",
      localTopicId,
      sendEvent: async () => ({ ok: true }),
    });
    registerTurnForwarder(localTopicId, forwarder);
    await forwardSharedTopicMessage(central.join, {
      id: "placed-user",
      topicId: localTopicId,
      authorId: "hub-user",
      text: "from Hub",
      createdAt: new Date().toISOString(),
    });
    await forwardSharedTopicMessage(central.join, {
      id: "placed-ai",
      topicId: localTopicId,
      authorId: "ai",
      agentType: "maestro",
      text: "Hub response",
      createdAt: new Date().toISOString(),
    });
    expect(forwarder.seq).toBe(0);
    forwarder.finish({ type: "ai_done", topicId: localTopicId, queryId: "placed-request" });
    central.stop();
    configureOtiumCentral(null);
  });

  test("hub-origin mirrors are visible in Terminal but are not auto-publish candidates", () => {
    const result = provisionMirrorTopic(`hub-${crypto.randomUUID()}`, {
      userId: "hub-user",
      hostTopicId: `room-${crypto.randomUUID()}`,
      topicTitle: "placed room",
      execution: {
        agent: "maestro",
        model: "",
        effort: "medium",
        mcp: [],
        canSpawnSubagents: false,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(getTopic(result.localTopicId)).toMatchObject({
        visibility: "visible",
        accessMode: "shared",
      });
  });
});
