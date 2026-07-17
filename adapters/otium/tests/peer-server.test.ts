import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  registerTopic,
  resolveAttachmentByFileId,
  resolveUploadedFilePathByFileId,
} from "@negotium/core";
import { configureOtiumCentral, resetPeerCentralCaches } from "@/central";
import { installPeerFileHooks } from "@/peer-files";
import { handleOtiumPeerRequest } from "@/peer-server";
import { PEER_PROTOCOL_VERSION } from "@/protocol";
import { getPeerSession } from "@/store";
import { type FakeCentral, HUB_TOKEN, startFakeCentral, WORKER_PEER_TOKEN } from "./helpers";

const BASE = "http://worker.local";
const USER = "central-user-1";

let central: FakeCentral;

beforeAll(() => {
  central = startFakeCentral();
  configureOtiumCentral(central.join);
});

afterAll(() => {
  configureOtiumCentral(null);
  central.stop();
});

function request(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Request {
  const method = opts.method ?? "POST";
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      "content-type": "application/json",
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function call(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleOtiumPeerRequest(request(path, opts));
  if (!response) throw new Error(`expected a peer response for ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function callForm(path: string, form: FormData) {
  const response = await handleOtiumPeerRequest(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
      body: form,
    }),
  );
  if (!response) throw new Error(`expected a peer response for ${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("routing", () => {
  test("returns null for non-peer paths so the host can chain handlers", async () => {
    expect(await handleOtiumPeerRequest(request("/mcp", { method: "GET" }))).toBeNull();
    expect(await handleOtiumPeerRequest(request("/health", { method: "GET" }))).toBeNull();
  });

  test("GET /ready answers ok without auth when joined", async () => {
    const { status, body } = await call("/ready", { method: "GET" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  test("everything peer is 403 when the node has not joined (fail-closed)", async () => {
    configureOtiumCentral(null);
    try {
      expect(await handleOtiumPeerRequest(request("/ready", { method: "GET" }))).toBeNull();
      const { status, body } = await call("/api/v1/peer/capabilities", {
        method: "GET",
        token: HUB_TOKEN,
      });
      expect(status).toBe(403);
      expect(body.error).toBe("multi-node is disabled");
    } finally {
      configureOtiumCentral(central.join);
    }
  });
});

describe("peer auth", () => {
  test("missing bearer → 401 missing peer token", async () => {
    const { status, body } = await call("/api/v1/peer/capabilities", { method: "GET" });
    expect(status).toBe(401);
    expect(body.error).toBe("missing peer token");
  });

  test("token central rejects → 401 invalid peer token", async () => {
    const { status, body } = await call("/api/v1/peer/capabilities", {
      method: "GET",
      token: "ptk_forged",
    });
    expect(status).toBe(401);
    expect(body.error).toBe("invalid peer token");
  });

  test("verify results are cached (30s positive cache)", async () => {
    resetPeerCentralCaches();
    const before = central.verifyRequests.length;
    await call("/api/v1/peer/capabilities", { method: "GET", token: HUB_TOKEN });
    await call("/api/v1/peer/health", { method: "GET", token: HUB_TOKEN });
    const verifies = central.verifyRequests.slice(before).filter((t) => t === HUB_TOKEN);
    expect(verifies.length).toBe(1);
  });

  test("non-primary caller on a hub-only endpoint → 403", async () => {
    const { status, body } = await call("/api/v1/peer/provision", {
      token: WORKER_PEER_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION },
    });
    expect(status).toBe(403);
    expect(body.error).toBe("only the workspace hub may call this endpoint");
  });

  test("non-primary peers cannot invoke worker user/session endpoints", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["/api/v1/peer/tell", { v: PEER_PROTOCOL_VERSION }],
      ["/api/v1/peer/ask", { v: PEER_PROTOCOL_VERSION }],
      ["/api/v1/peer/abort", { v: PEER_PROTOCOL_VERSION }],
      ["/api/v1/peer/sessions", { v: PEER_PROTOCOL_VERSION }],
      ["/api/v1/peer/reply", { v: PEER_PROTOCOL_VERSION }],
      ["/api/v1/peer/device-vault", { v: PEER_PROTOCOL_VERSION }],
    ];
    for (const [path, body] of cases) {
      const response = await call(path, { token: WORKER_PEER_TOKEN, body });
      expect(response.status).toBe(403);
      expect(response.body.error).toBe("only the workspace hub may call this endpoint");
    }
  });

  test("newer protocol version → 400", async () => {
    const { status, body } = await call("/api/v1/peer/sessions", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION + 1, userId: USER },
    });
    expect(status).toBe(400);
    expect(body.error).toBe(`unsupported peer protocol version (mine: ${PEER_PROTOCOL_VERSION})`);
  });
});

describe("capabilities / health", () => {
  test("capabilities reports agents, efforts and the negotium MCP catalog", async () => {
    const { status, body } = await call("/api/v1/peer/capabilities", {
      method: "GET",
      token: HUB_TOKEN,
    });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(1);
    expect(body.runtimeVersion).toBe("0.1.11");
    expect(body.features).toEqual({
      remoteAsk: true,
      inputFiles: true,
      outputFiles: true,
      visualBridge: true,
      askUserBridge: true,
      selfConfigBridge: true,
    });
    const agents = body.agents as Array<Record<string, unknown>>;
    expect(agents.map((a) => a.kind).sort()).toEqual(["claude", "codex", "maestro"]);
    for (const agent of agents) {
      expect(typeof agent.available).toBe("boolean");
      expect(typeof agent.defaultModel).toBe("string");
      expect(Array.isArray(agent.validEfforts)).toBe(true);
    }
    expect(Array.isArray(body.optionalMcp)).toBe(true);
  });

  test("health reports cpu/memory/uptime", async () => {
    const { status, body } = await call("/api/v1/peer/health", {
      method: "GET",
      token: HUB_TOKEN,
    });
    expect(status).toBe(200);
    const cpu = body.cpu as Record<string, unknown>;
    const memory = body.memory as Record<string, unknown>;
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(typeof cpu.cores).toBe("number");
    expect(typeof memory.totalBytes).toBe("number");
    expect(typeof memory.processRssBytes).toBe("number");
  });
});

describe("device-local vault bridge", () => {
  test("primary hub can list/set/delete without any secret value in responses", async () => {
    const key = `DEVICE_TEST_${Date.now()}`;
    const set = await call("/api/v1/peer/device-vault", {
      token: HUB_TOKEN,
      body: {
        v: PEER_PROTOCOL_VERSION,
        operation: "set",
        userId: USER,
        key,
        value: "super-secret-device-only",
        description: "worker credential",
      },
    });
    expect(set.status).toBe(200);
    expect(JSON.stringify(set.body)).not.toContain("super-secret-device-only");

    const listed = await call("/api/v1/peer/device-vault", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION, operation: "list", userId: USER },
    });
    expect(listed.status).toBe(200);
    expect(listed.body.entries).toContainEqual({ key, description: "worker credential" });
    expect(JSON.stringify(listed.body)).not.toContain("super-secret-device-only");

    const removed = await call("/api/v1/peer/device-vault", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION, operation: "delete", userId: USER, key },
    });
    expect(removed).toEqual({ status: 200, body: { ok: true, deleted: key } });
  });
});

describe("tell", () => {
  test("accepts, replays idempotently, and 409s a payload conflict", async () => {
    const topic = registerTopic({
      title: "peer-tell-target",
      userId: USER,
      kind: "channel",
      agent: "none",
      accessMode: "shared",
    });
    expect(topic.agent).toBeUndefined();

    const tell = (message: string) => ({
      v: PEER_PROTOCOL_VERSION,
      requestId: "tell-req-1",
      userId: USER,
      toTopic: "peer-tell-target",
      fromLabel: "hub-mac/회의록",
      message,
      depth: 1,
    });

    const first = await call("/api/v1/peer/tell", { token: HUB_TOKEN, body: tell("hello") });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });

    const replay = await call("/api/v1/peer/tell", { token: HUB_TOKEN, body: tell("hello") });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ok: true, replayed: true });

    const conflict = await call("/api/v1/peer/tell", { token: HUB_TOKEN, body: tell("DIFFERENT") });
    expect(conflict.status).toBe(409);
  });

  test("unknown topic → 404, over-depth → 400, oversized message → 400", async () => {
    const base = {
      v: PEER_PROTOCOL_VERSION,
      requestId: "tell-req-2",
      userId: USER,
      fromLabel: "hub/x",
      depth: 1,
    };
    const missing = await call("/api/v1/peer/tell", {
      token: HUB_TOKEN,
      body: { ...base, toTopic: "no-such-room", message: "hi" },
    });
    expect(missing.status).toBe(404);

    const deep = await call("/api/v1/peer/tell", {
      token: HUB_TOKEN,
      body: { ...base, toTopic: "peer-tell-target", message: "hi", depth: 99 },
    });
    expect(deep.status).toBe(400);

    const long = await call("/api/v1/peer/tell", {
      token: HUB_TOKEN,
      body: { ...base, toTopic: "peer-tell-target", message: "x".repeat(10_001) },
    });
    expect(long.status).toBe(400);
    expect(long.body.error).toBe("message too long");
  });
});

describe("sessions / abort / stubs", () => {
  test("sessions lists shared topics but excludes this user's private topics", async () => {
    const privateTopic = registerTopic({
      title: `peer-private-${Date.now()}`,
      userId: USER,
      kind: "channel",
      agent: "none",
    });
    const { status, body } = await call("/api/v1/peer/sessions", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION, userId: USER },
    });
    expect(status).toBe(200);
    const sessions = body.sessions as Array<{ name: string; hasSession: boolean }>;
    expect(sessions.some((s) => s.name === "peer-tell-target")).toBe(true);
    expect(sessions.some((s) => s.name === privateTopic.title)).toBe(false);
  });

  test("Otium tell and topic-scoped abort cannot address private topics", async () => {
    const privateTopic = registerTopic({
      title: `peer-private-route-${Date.now()}`,
      userId: USER,
      kind: "channel",
      agent: "none",
    });
    const tell = await call("/api/v1/peer/tell", {
      token: HUB_TOKEN,
      body: {
        v: PEER_PROTOCOL_VERSION,
        requestId: `private-${privateTopic.id}`,
        userId: USER,
        toTopic: privateTopic.title,
        fromLabel: "hub/private-test",
        message: "must not arrive",
        depth: 0,
      },
    });
    expect(tell.status).toBe(404);

    const abort = await call("/api/v1/peer/abort", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION, userId: USER, toTopic: privateTopic.title },
    });
    expect(abort.status).toBe(404);
  });

  test("topic-scoped abort appends to the session inbox", async () => {
    const { status } = await call("/api/v1/peer/abort", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION, userId: USER, toTopic: "peer-tell-target" },
    });
    expect(status).toBe(200);
  });

  test("exact-requestId abort for an unknown turn → 404", async () => {
    const { status, body } = await call("/api/v1/peer/abort", {
      token: HUB_TOKEN,
      body: {
        v: PEER_PROTOCOL_VERSION,
        userId: USER,
        toTopic: "peer-tell-target",
        requestId: "pt-nope",
      },
    });
    expect(status).toBe(404);
    expect(body.error).toBe("turn not found or already completed");
  });

  test("ask, reply, and input-file validate their contracts", async () => {
    const ask = await call("/api/v1/peer/ask", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION },
    });
    expect(ask.status).toBe(400);

    for (const [index, fromDepth] of [-1, 0.5, "1"].entries()) {
      const invalidDepth = await call("/api/v1/peer/ask", {
        token: HUB_TOKEN,
        body: {
          v: PEER_PROTOCOL_VERSION,
          requestId: `depth-${index}`,
          userId: USER,
          toTopic: "unused",
          fromLabel: "hub/source",
          message: "?",
          fromDepth,
          replyTo: { topicId: "host-source" },
        },
      });
      expect(invalidDepth.status).toBe(400);
    }

    const reply = await call("/api/v1/peer/reply", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION, requestId: "r1" },
    });
    expect(reply.status).toBe(400);

    const inputFile = await call("/api/v1/peer/input-file", { token: HUB_TOKEN, body: {} });
    expect(inputFile.status).toBe(400);
  });

  test("input-file stores multipart bytes for a provisioned mirror", async () => {
    const hostTopicId = `host-file-${Date.now()}`;
    const provisioned = await call("/api/v1/peer/provision", {
      token: HUB_TOKEN,
      body: {
        v: PEER_PROTOCOL_VERSION,
        userId: USER,
        hostTopicId,
        topicTitle: "peer-file-target",
        execution: {
          agent: "codex",
          model: "gpt-5.6-luna",
          effort: "medium",
          mcp: [],
          canSpawnSubagents: true,
        },
      },
    });
    expect(provisioned.status).toBe(200);
    const uninstall = installPeerFileHooks();
    try {
      const form = new FormData();
      form.set("hostTopicId", hostTopicId);
      form.set("userId", USER);
      form.set("file", new File(["peer bytes"], "notes.txt", { type: "text/plain" }));
      const uploaded = await callForm("/api/v1/peer/input-file", form);
      expect(uploaded.status).toBe(200);
      const fileId = uploaded.body.fileId as string;
      expect(resolveAttachmentByFileId(fileId)).toEqual(
        expect.objectContaining({ id: fileId, filename: "notes.txt", sizeBytes: 10 }),
      );
      expect(await Bun.file(resolveUploadedFilePathByFileId(fileId) as string).text()).toBe(
        "peer bytes",
      );
    } finally {
      uninstall();
    }
  });
});

describe("shared topic binding routes", () => {
  test("hub cannot bind a private local topic", async () => {
    const topic = registerTopic({
      title: `peer-private-bind-${Date.now()}`,
      userId: USER,
      kind: "agent",
      agent: "maestro",
    });
    const response = await call("/api/v1/peer/bind", {
      token: HUB_TOKEN,
      body: {
        v: PEER_PROTOCOL_VERSION,
        userId: USER,
        hostTopicId: `host-${topic.id}`,
        localTopicId: topic.id,
      },
    });
    expect(response.status).toBe(409);
    expect(getPeerSession("cell_hub", `host-${topic.id}`)).toBeNull();
  });

  test("hub binds and unbinds an existing local topic without deleting it", async () => {
    const topic = registerTopic({
      title: `peer-bind-${Date.now()}`,
      userId: USER,
      kind: "agent",
      agent: "maestro",
      accessMode: "shared",
    });
    const hostTopicId = `host-${topic.id}`;
    const bound = await call("/api/v1/peer/bind", {
      token: HUB_TOKEN,
      body: {
        v: PEER_PROTOCOL_VERSION,
        userId: USER,
        hostTopicId,
        localTopicId: topic.id,
      },
    });
    expect(bound.status).toBe(200);
    expect(getPeerSession("cell_hub", hostTopicId)).toMatchObject({
      local_topic_id: topic.id,
      binding_mode: "shared",
    });

    const unbound = await call("/api/v1/peer/unbind", {
      token: HUB_TOKEN,
      body: { v: PEER_PROTOCOL_VERSION, hostTopicId },
    });
    expect(unbound.status).toBe(200);
    expect(unbound.body.removed).toBe(true);
    expect(getPeerSession("cell_hub", hostTopicId)).toBeNull();
  });
});
