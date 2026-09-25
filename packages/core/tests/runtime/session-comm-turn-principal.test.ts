/**
 * PR9 security regression (confused deputy): end to end from the hosted
 * session-comm tools through the real session-inbox consumer to the identity
 * a target turn is started with.
 *
 * A local tell is filed under a principal and `runtime/inbox.ts` starts the
 * target's turn as that principal (`triggerTopicAiTurn(topicId, userId)`; the
 * turn's vault namespace falls back to the same principal in `startAiTurn`).
 * So the principal on the inbox row *is* whose credentials, browser profile
 * and tool grants the prompt runs with. This pins that a caller can only ever
 * start turns as itself, in rooms it is a participant of — in a `local`+human
 * two-owner room that is the caller's own principal — and that no path starts
 * a turn as another principal.
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { SessionCommContext } from "#mcp/session-comm/context";
import { createDefaultSessionCommMcpHost } from "#mcp/session-comm/default-host";
import { deleteTopic, upsertTopic } from "#storage/api-topics";
import { db } from "#storage/forum-db";
import { enqueueSessionInbox } from "#storage/session-inbox";
import type { TopicDto } from "#types/api";

interface StartedTurn {
  topicId: string;
  userId: string;
  vaultUserId: string;
}

const started: StartedTurn[] = [];

// bun's mock.module is process-global: snapshot the real module and restore it.
const realTurnRunner = { ...(await import("#runtime/turn-runner")) };
mock.module("#runtime/turn-runner", () => ({
  ...realTurnRunner,
  // Fake turn runner: records the identity the consumer starts the turn with.
  // `vaultUserId` mirrors `startAiTurn` (`params.vaultUserId ?? userId`);
  // `triggerTopicAiTurn` passes no separate vault principal.
  triggerTopicAiTurn: (
    topicId: string,
    userId: string,
    _prompt: string,
    _agent?: unknown,
    opts?: { vaultUserId?: string },
  ) => {
    started.push({ topicId, userId, vaultUserId: opts?.vaultUserId ?? userId });
    return `fake-query-${randomUUID()}`;
  },
}));
const { flushSessionInbox } = await import("#runtime/inbox");

afterAll(() => {
  mock.module("#runtime/turn-runner", () => realTurnRunner);
});

const local = `e2e-local-${randomUUID()}`;
const human = `e2e-human-${randomUUID()}`;
const created: string[] = [];

function room(scope: string, participants: TopicDto["participants"]): TopicDto {
  const now = new Date().toISOString();
  const topic: TopicDto = {
    id: `e2e-room-${randomUUID()}`,
    title: `E2E ${randomUUID().slice(0, 8)}`,
    kind: "agent",
    agent: "codex",
    defaultModel: "gpt-5.6-luna",
    defaultEffort: "medium",
    aiMode: "always",
    aiMention: false,
    participants,
    createdAt: now,
    lastMessageAt: now,
    surface: "otium",
    surfaceScope: scope,
  };
  created.push(topic.id);
  upsertTopic(topic);
  return topic;
}

function pending(topicId: string): number {
  return Number(
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM session_inbox WHERE topic_id = ?")
      .get(topicId)?.n ?? 0,
  );
}

async function drain(topicIds: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  await flushSessionInbox();
  while (Date.now() < deadline) {
    if (topicIds.every((id) => pending(id) === 0)) {
      await Bun.sleep(20); // let the handler finish after the batch completes
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("session inbox did not drain");
}

afterEach(() => {
  started.length = 0;
  for (const id of created.splice(0)) {
    db.run("DELETE FROM session_inbox WHERE topic_id = ?", [id]);
    db.run("DELETE FROM api_messages WHERE topic_id = ?", [id]);
    deleteTopic(id);
  }
});

describe("session-comm tell -> inbox -> turn identity (two-owner rooms)", () => {
  test("a turn only ever starts as the caller's own principal", async () => {
    const scope = `e2e-ws-${randomUUID()}`;
    const localRoom = room(scope, [{ userId: local, role: "owner" }]);
    const dualRoom = room(scope, [
      { userId: local, role: "owner" },
      { userId: human, role: "owner" },
    ]);
    const humanRoom = room(scope, [{ userId: human, role: "owner" }]);
    const all = [localRoom.id, dualRoom.id, humanRoom.id];
    const assertion = {
      visibleNodeTopicIds: all,
      ownedNodeTopicIds: all,
      issuedAt: Date.now(),
    };
    const host = createDefaultSessionCommMcpHost();
    const asLocal: SessionCommContext = {
      userId: local,
      actorUserId: human,
      actorTopicScope: assertion,
      currentTopic: localRoom.title,
      currentTopicId: localRoom.id,
      depth: 0,
      replyOnly: false,
      agent: "codex",
    };
    const asHuman: SessionCommContext = {
      ...asLocal,
      userId: human,
      currentTopic: dualRoom.title,
      currentTopicId: dualRoom.id,
    };

    // `local` is in the two-owner room: its turn there runs as `local`.
    const toDual = await host.tellSession(asLocal, { to: dualRoom.title, message: "one" });
    expect("isError" in toDual && toDual.isError).toBeFalsy();
    // `local` is not in the human's room: refused, nothing is queued, so the
    // human's principal can never be borrowed for `local`'s prompt.
    const toHuman = await host.tellSession(asLocal, { to: humanRoom.title, message: "two" });
    expect("isError" in toHuman && toHuman.isError).toBe(true);
    expect(JSON.stringify(toHuman)).toContain("different execution principal");
    // Same the other way round.
    const toLocal = await host.tellSession(asHuman, { to: localRoom.title, message: "three" });
    expect("isError" in toLocal && toLocal.isError).toBe(true);
    // A human-principal turn reaching its own principal's room runs as itself.
    const humanToHuman = await host.tellSession(asHuman, { to: humanRoom.title, message: "4" });
    expect("isError" in humanToHuman && humanToHuman.isError).toBeFalsy();

    expect(pending(humanRoom.id)).toBe(1);
    expect(pending(localRoom.id)).toBe(0);

    // Even a hand-written inbox row filed under a principal that is not in
    // the room is dropped by the consumer — never run under the room owner.
    enqueueSessionInbox({
      userId: local,
      topicId: humanRoom.id,
      entry: {
        type: "tell",
        requestId: randomUUID(),
        from: `agent:${localRoom.title}`,
        message: "forged",
        depth: 1,
        timestamp: new Date().toISOString(),
      },
    });

    await drain(all);

    const ours = started
      .filter((turn) => all.includes(turn.topicId))
      .map((turn) => `${turn.topicId}|${turn.userId}|${turn.vaultUserId}`)
      .sort();
    expect(ours).toEqual(
      [`${dualRoom.id}|${local}|${local}`, `${humanRoom.id}|${human}|${human}`].sort(),
    );
    // No turn anywhere ran as a principal other than the caller's.
    expect(started.some((turn) => turn.topicId === humanRoom.id && turn.userId === local)).toBe(
      false,
    );
    expect(started.some((turn) => turn.topicId === localRoom.id)).toBe(false);
  });
});
