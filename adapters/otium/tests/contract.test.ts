import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertNegotiumAdapterContract } from "@negotium/adapter-sdk/testkit";
import { db, runtimeBus, upsertTopic } from "@negotium/core";
import { otiumAdapter, startOtiumAdapter } from "@/index";
import {
  claimPeerInboxRequest,
  createRemoteAsk,
  getRemoteAsk,
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
        externalPlacedTurn: false,
      },
      createHandle: () => startOtiumAdapter({ join: central.join }),
    });
  } finally {
    central.stop();
  }
});

test("topic-deleted cascades adapter-owned inbox claims and pending remote asks", () => {
  const central = startFakeCentral();
  const handle = startOtiumAdapter({ join: central.join });
  const localTopicId = `local-${randomUUID()}`;
  const hostNodeId = `host-${randomUUID()}`;
  const inboxRequestId = `inbox-${randomUUID()}`;
  const askRequestId = `ask-${randomUUID()}`;
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
    expect(
      claimPeerInboxRequest({
        fromCellId: hostNodeId,
        requestId: inboxRequestId,
        kind: "tell",
        topicId: localTopicId,
        payloadHash,
      }).outcome,
    ).toBe("claimed");
    expect(
      createRemoteAsk({
        requestId: askRequestId,
        expectedCellId: hostNodeId,
        userId: "owner",
        callerTopicId: localTopicId,
        from: "owner/local",
        to: "hub/remote",
      }),
    ).toBe(true);

    runtimeBus().broadcastTopicDeleted(localTopicId);

    // The ask route is the one that never self-heals: nothing else ever revisits
    // the row, so a caller room's deletion has to take it with them.
    expect(getRemoteAsk(askRequestId)).toBeNull();
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
