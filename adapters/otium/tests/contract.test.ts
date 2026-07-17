import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertNegotiumAdapterContract } from "@negotium/adapter-sdk/testkit";
import { db, runtimeBus, upsertTopic } from "@negotium/core";
import { otiumAdapter, startOtiumAdapter } from "@/index";
import {
  claimPeerInboxRequest,
  claimPeerTurnRequest,
  createPeerSession,
  getPeerSession,
  getPeerTurnRequest,
  peerInboxPayloadHash,
} from "@/store";
import { startFakeCentral } from "./helpers";

test("otium worker package has no Otium runtime dependency", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };
  const dependencies = Object.keys(manifest.dependencies ?? {});

  expect(dependencies.length).toBeGreaterThan(0);
  expect(dependencies.every((name) => name.startsWith("@negotium/"))).toBe(true);
});

test("otium implements the shared adapter lifecycle", async () => {
  const central = startFakeCentral();
  try {
    await assertNegotiumAdapterContract({
      name: "otium",
      definition: otiumAdapter,
      capabilities: {
        localUserInput: false,
        topicManagement: false,
        externalPlacedTurn: true,
      },
      createHandle: () => startOtiumAdapter({ join: central.join }),
    });
  } finally {
    central.stop();
  }
});

test("topic-deleted cascades adapter-owned peer sessions, turns, and inbox claims", () => {
  const central = startFakeCentral();
  const handle = startOtiumAdapter({ join: central.join });
  const localTopicId = `local-${randomUUID()}`;
  const hostNodeId = `host-${randomUUID()}`;
  const hostTopicId = `room-${randomUUID()}`;
  const turnRequestId = `turn-${randomUUID()}`;
  const inboxRequestId = `inbox-${randomUUID()}`;
  const payloadHash = peerInboxPayloadHash({ message: "hello" });
  try {
    const now = new Date().toISOString();
    upsertTopic({
      id: localTopicId,
      title: `local-${localTopicId.slice(-6)}`,
      kind: "agent",
      agent: "maestro",
      aiMode: "always",
      defaultModel: "",
      defaultEffort: "medium",
      participants: [{ userId: "owner", role: "owner" }],
      createdAt: now,
      lastMessageAt: now,
    });
    createPeerSession(hostNodeId, hostTopicId, localTopicId);
    claimPeerTurnRequest(hostNodeId, turnRequestId, hostTopicId);
    expect(
      claimPeerInboxRequest({
        fromCellId: hostNodeId,
        requestId: inboxRequestId,
        kind: "tell",
        topicId: localTopicId,
        payloadHash,
      }).outcome,
    ).toBe("claimed");

    runtimeBus().broadcastTopicDeleted(localTopicId);

    expect(getPeerSession(hostNodeId, hostTopicId)).toBeNull();
    expect(getPeerTurnRequest(hostNodeId, turnRequestId)).toBeNull();
    expect(
      claimPeerInboxRequest({
        fromCellId: hostNodeId,
        requestId: inboxRequestId,
        kind: "tell",
        topicId: localTopicId,
        payloadHash,
      }).outcome,
    ).toBe("claimed");
  } finally {
    handle.stop();
    db.run("DELETE FROM otium_peer_inbox_requests WHERE topic_id = ?", [localTopicId]);
    db.run("DELETE FROM api_topics WHERE id = ?", [localTopicId]);
    central.stop();
  }
});
