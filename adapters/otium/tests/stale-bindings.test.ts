import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { db, getTopic, upsertTopic } from "@negotium/core";
import { getPeerSession, listPeerSessions, sweepStalePeerBindings } from "@/store";

/**
 * Regression cover for peer bindings outliving their local topic.
 *
 * Deletion normally arrives as a `topic-deleted` bus event, which is enough for
 * a node that is running. A node that is offline at that moment never sees it,
 * and nothing else reconciled — so the row survived indefinitely. The headless
 * worker is shut down between jobs to save cost, which makes the offline case
 * the normal one there rather than an edge case.
 */

const createdTopicIds: string[] = [];
const boundKeys: Array<[string, string]> = [];

function localTopic(): string {
  const id = `sweep-${randomUUID()}`;
  const now = new Date().toISOString();
  upsertTopic({
    id,
    title: `sweep-${id.slice(-6)}`,
    kind: "agent",
    agent: "maestro",
    aiMode: "always",
    defaultModel: "",
    defaultEffort: "medium",
    participants: [{ userId: "owner-user", role: "owner" }],
    createdAt: now,
    lastMessageAt: now,
  });
  createdTopicIds.push(id);
  return id;
}

/**
 * Seeded with raw SQL on purpose: `shared`-mode rows are legacy leftovers of the
 * retired copy path, so no production helper writes one any more — but the sweep
 * still has to clean them up, which is what this file covers.
 */
function bind(localTopicId: string, mode: "shared" | "mirror"): [string, string] {
  const key: [string, string] = [`cell-${randomUUID()}`, `room-${randomUUID()}`];
  db.run(
    `INSERT INTO otium_peer_sessions
       (host_node_id, host_topic_id, local_topic_id, binding_mode, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [key[0], key[1], localTopicId, mode, new Date().toISOString()],
  );
  boundKeys.push(key);
  return key;
}

afterEach(() => {
  for (const [node, room] of boundKeys.splice(0)) {
    db.run("DELETE FROM otium_peer_sessions WHERE host_node_id = ? AND host_topic_id = ?", [
      node,
      room,
    ]);
  }
  createdTopicIds.splice(0);
});

const exists = (id: string) => getTopic(id) !== null;

describe("sweepStalePeerBindings", () => {
  test("removes a binding whose local topic is gone", () => {
    const missing = `sweep-missing-${randomUUID()}`;
    const [node, room] = bind(missing, "mirror");
    expect(getPeerSession(node, room)).not.toBeNull();

    const result = sweepStalePeerBindings(exists);

    expect(result.topicIds).toContain(missing);
    expect(getPeerSession(node, room)).toBeNull();
  });

  test("keeps a binding whose local topic still exists", () => {
    // The sweep runs at startup against every binding, so a false positive
    // would unbind live rooms rather than merely leaving dead ones behind.
    const live = localTopic();
    const [node, room] = bind(live, "shared");

    const result = sweepStalePeerBindings(exists);

    expect(result.topicIds).not.toContain(live);
    expect(getPeerSession(node, room)).not.toBeNull();
  });

  test("clears the shared binding that would otherwise 404 every turn forever", () => {
    // A mirror binding recovers on its own — `provisionMirrorTopic` recreates
    // the topic under the recorded id. A shared one does not: the turn bridge
    // answers "bound local topic no longer exists" and nothing removes the row
    // that causes it.
    const missing = `sweep-shared-${randomUUID()}`;
    const [node, room] = bind(missing, "shared");

    sweepStalePeerBindings(exists);

    expect(getPeerSession(node, room)).toBeNull();
  });

  test("reports nothing and changes nothing when every binding is live", () => {
    const live = localTopic();
    bind(live, "mirror");
    const before = listPeerSessions().length;

    const result = sweepStalePeerBindings(exists);

    expect(result.topicIds).toEqual([]);
    expect(result.removed.sessions).toBe(0);
    expect(listPeerSessions()).toHaveLength(before);
  });
});
