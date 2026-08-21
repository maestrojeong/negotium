import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db } from "@negotium/core";
import { claimPeerInboxRequestWithDelivery, peerInboxPayloadHash } from "@/store";

const topicIds = new Set<string>();

function request(overrides: Partial<Parameters<typeof claimPeerInboxRequestWithDelivery>[0]> = {}) {
  const topicId = overrides.topicId ?? `peer-delivery-topic-${randomUUID()}`;
  topicIds.add(topicId);
  const requestId = overrides.requestId ?? `peer-delivery-request-${randomUUID()}`;
  const payload = { message: requestId };
  return {
    fromCellId: "hub-cell",
    requestId,
    kind: "tell" as const,
    topicId,
    payloadHash: peerInboxPayloadHash(payload),
    userId: "owner",
    entry: { type: "tell", requestId, from: "hub/source", message: requestId, depth: 0 },
    ...overrides,
  };
}

afterEach(() => {
  for (const topicId of topicIds) {
    db.run("DELETE FROM otium_peer_inbox_requests WHERE topic_id = ?", [topicId]);
    db.run("DELETE FROM session_inbox WHERE topic_id = ?", [topicId]);
  }
  topicIds.clear();
});

describe("peer inbox transactional delivery", () => {
  test("commits the network claim and core delivery row as one unit", () => {
    const args = request();
    expect(claimPeerInboxRequestWithDelivery(args).outcome).toBe("claimed");
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM otium_peer_inbox_requests WHERE topic_id = ?",
        )
        .get(args.topicId)?.count,
    ).toBe(1);
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM session_inbox WHERE topic_id = ?",
        )
        .get(args.topicId)?.count,
    ).toBe(1);
    expect(claimPeerInboxRequestWithDelivery(args).outcome).toBe("replay");
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM session_inbox WHERE topic_id = ?",
        )
        .get(args.topicId)?.count,
    ).toBe(1);
  });

  test("rolls back the claim when delivery serialization fails, allowing retry", () => {
    const base = request();
    expect(() => claimPeerInboxRequestWithDelivery({ ...base, entry: { value: 1n } })).toThrow();
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM otium_peer_inbox_requests WHERE topic_id = ?",
        )
        .get(base.topicId)?.count,
    ).toBe(0);
    expect(claimPeerInboxRequestWithDelivery(base).outcome).toBe("claimed");
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM session_inbox WHERE topic_id = ?",
        )
        .get(base.topicId)?.count,
    ).toBe(1);
  });

  test("different request ids are claimed without conflict", async () => {
    const topicId = `peer-delivery-topic-${randomUUID()}`;
    topicIds.add(topicId);
    const fixture = `${import.meta.dir}/fixtures/peer-inbox-claim-worker.ts`;
    const children = ["concurrent-1", "concurrent-2"].map((requestId) =>
      Bun.spawn([process.execPath, fixture, requestId, topicId], {
        cwd: `${import.meta.dir}/..`,
        env: process.env,
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outcomes = await Promise.all(
      children.map(async (child) => {
        const output = await new Response(child.stdout).text();
        const error = await new Response(child.stderr).text();
        expect(await child.exited, error).toBe(0);
        return output;
      }),
    );
    expect(outcomes).toEqual(["claimed", "claimed"]);
    expect(
      db
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM session_inbox WHERE topic_id = ?",
        )
        .get(topicId)?.count,
    ).toBe(2);
  });
});
