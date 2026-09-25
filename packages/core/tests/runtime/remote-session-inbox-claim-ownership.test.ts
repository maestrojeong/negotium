/**
 * PR9 review (claim-ownership race, cross-process): `withRequestLock` is
 * process-local, and a claim's only identity used to be its payload digest.
 * Process A takes an ask-reply claim (digest H) and stalls; its lease runs out
 * and process B (a hub retry, or recovery after a restart / during a rolling
 * overlap) takes the SAME claim over — same digest H, only the lease moved.
 * Then:
 *   - A's late failure released "the claim with digest H" and deleted B's
 *     fresh `processing` row, so B's completion silently failed and the hub's
 *     next retry got 404 although the answer landed;
 *   - A's late success completed "the processing claim" without any owner
 *     check (B's), and recorded the answer a second time.
 * Startup recovery also forced a takeover of every live lease, including one
 * a still-running previous process held.
 *
 * Now every claim / takeover mints an opaque owner token; release and
 * complete are compare-and-set on (requestId, state, token); completion runs
 * first inside the recording transaction and a lost claim rolls the record
 * back; startup only forces a takeover when the holder is provably dead.
 *
 * Process A is a real second Bun process on the same SQLite file
 * (`tests/fixtures/remote-session-claim-worker.ts`); this process is B.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as inbox from "#runtime/remote-session-inbox";
import { listApiMessages } from "#storage/api-messages";
import { db } from "#storage/forum-db";
import {
  getRemoteSessionAsk,
  getRemoteSessionInboxClaim,
  REMOTE_SESSION_INBOX_CLAIM_LEASE_MS,
  recordRemoteSessionAsk,
} from "#storage/remote-session";
import { registerTopic } from "#topics/create";

const { deliverRemoteSessionInbox, recoverRemoteSessionInbox, setRemoteSessionAskReplyDeliverer } =
  inbox;

const WORKER = resolve(import.meta.dir, "../fixtures/remote-session-claim-worker.ts");
const ASKER = "local";
const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];

function callerRoom(): { id: string; title: string } {
  const topic = registerTopic({
    title: `claim-owner-caller-${randomUUID()}`,
    userId: ASKER,
    surface: "otium",
    surfaceScope: `ws-${randomUUID()}`,
  });
  db.run(
    "UPDATE api_topics SET kind = 'channel', response_policy = 'off', agent = NULL WHERE id = ?",
    [topic.id],
  );
  return { id: topic.id, title: topic.title };
}

function replyDelivery(requestId: string) {
  return {
    kind: "ask-reply" as const,
    requestId,
    fromLabel: "worker/Target",
    replyKind: "reply" as const,
    replyText: `answer ${requestId}`,
  };
}

function replies(topicId: string): number {
  return listApiMessages(topicId).page.filter((m) => m.kind === "tell").length;
}

/** Process A: runs the live ask-reply path and stalls inside the injection. */
function spawnA(after: "real" | "fail", topic: { id: string; title: string }, requestId: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      WORKER,
      after,
      JSON.stringify({ topic, userId: ASKER, delivery: replyDelivery(requestId) }),
    ],
    {
      cwd: resolve(import.meta.dir, "../../../.."),
      env: { ...process.env, LOG_LEVEL: "silent" } as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(child);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (timeoutMs = 10_000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return line;
      }
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, deadline - Date.now()))),
      ]);
      if (!chunk || chunk.done) {
        const stderr = await new Response(child.stderr).text().catch(() => "");
        throw new Error(`process A produced no line (exit ${child.exitCode}): ${stderr}`);
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
  return {
    child,
    next,
    go: () => {
      child.stdin.write("GO\n");
      child.stdin.flush();
    },
    result: async () => {
      const line = await next();
      expect(line.startsWith("RESULT ")).toBe(true);
      return JSON.parse(line.slice("RESULT ".length)) as { ok: boolean; status?: number };
    },
  };
}

/** A's live lease is over from B's point of view (B's clock is ahead). */
const AFTER_A_LEASE = () => Date.now() + REMOTE_SESSION_INBOX_CLAIM_LEASE_MS + 5_000;

afterEach(async () => {
  setRemoteSessionAskReplyDeliverer(null);
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
});

describe("inbox claim ownership across processes", () => {
  test("B takes A's claim over (same digest); A's late success records nothing: exactly one reply, B completes, the retry replays", async () => {
    const topic = callerRoom();
    const requestId = `own-dup-${randomUUID()}`;
    recordRemoteSessionAsk({
      requestId,
      callerTopicId: topic.id,
      userId: ASKER,
      fromKey: "agent:Caller",
      toKey: "worker/Target",
    });
    const a = spawnA("real", topic, requestId);
    expect(await a.next()).toBe("STALLED");
    const heldByA = getRemoteSessionInboxClaim(requestId);
    expect(heldByA?.state).toBe("processing");

    // B: recovery after A's lease — same digest, real injection.
    expect(await recoverRemoteSessionInbox(AFTER_A_LEASE())).toBe(1);
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");

    // A wakes up and tries to record the same answer.
    a.go();
    const late = await a.result();
    expect(late.ok).toBe(false);
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");

    // The hub's retry after a lost response is a replay, not a 404.
    expect(
      await deliverRemoteSessionInbox({
        topic: { ...topic, agent: undefined },
        userId: ASKER,
        actorUserId: ASKER,
        delivery: replyDelivery(requestId),
      }),
    ).toEqual({ ok: true, replayed: true });
    expect(replies(topic.id)).toBe(1);
  }, 30_000);

  test("A's late release (after its failed injection) never deletes B's fresh processing claim; B completes and the retry replays", async () => {
    const topic = callerRoom();
    const requestId = `own-rel-${randomUUID()}`;
    recordRemoteSessionAsk({
      requestId,
      callerTopicId: topic.id,
      userId: ASKER,
      fromKey: "agent:Caller",
      toKey: "worker/Target",
    });
    const a = spawnA("fail", topic, requestId);
    expect(await a.next()).toBe("STALLED");
    const ownerA = getRemoteSessionInboxClaim(requestId)?.owner ?? null;

    // B takes the claim over and parks inside its own injection.
    const real = (await import("#runtime/turn-runner")).deliverAskCallbackToCaller;
    let entered!: () => void;
    const bInside = new Promise<void>((r) => {
      entered = r;
    });
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    setRemoteSessionAskReplyDeliverer(async (pending, ...rest) => {
      entered();
      await gate;
      return real(pending, ...rest);
    });
    const recovery = recoverRemoteSessionInbox(AFTER_A_LEASE());
    await bInside;
    const heldByB = getRemoteSessionInboxClaim(requestId);
    expect(heldByB?.state).toBe("processing");

    // A fails late and releases "its" claim.
    a.go();
    expect((await a.result()).ok).toBe(false);
    const after = getRemoteSessionInboxClaim(requestId);
    expect(after?.state).toBe("processing");
    expect(after?.owner).toBe(heldByB?.owner ?? "missing");
    expect(after?.owner).not.toBe(ownerA);

    open();
    expect(await recovery).toBe(1);
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
    expect(getRemoteSessionAsk(requestId)).toBeNull();
    setRemoteSessionAskReplyDeliverer(null);
    expect(
      await deliverRemoteSessionInbox({
        topic: { ...topic, agent: undefined },
        userId: ASKER,
        actorUserId: ASKER,
        delivery: replyDelivery(requestId),
      }),
    ).toEqual({ ok: true, replayed: true });
    expect(replies(topic.id)).toBe(1);
  }, 30_000);

  test("startup recovery (includeLive) leaves a live process's lease alone and takes it over only once that process is dead", async () => {
    const topic = callerRoom();
    const requestId = `own-boot-${randomUUID()}`;
    recordRemoteSessionAsk({
      requestId,
      callerTopicId: topic.id,
      userId: ASKER,
      fromKey: "agent:Caller",
      toKey: "worker/Target",
    });
    const a = spawnA("real", topic, requestId);
    expect(await a.next()).toBe("STALLED");
    const ownerA = getRemoteSessionInboxClaim(requestId)?.owner ?? null;

    // Rolling overlap: A is alive and still delivering.
    expect(await recoverRemoteSessionInbox(Date.now(), { includeLive: true })).toBe(0);
    expect(replies(topic.id)).toBe(0);
    expect(getRemoteSessionInboxClaim(requestId)?.owner).toBe(ownerA);

    // A dies mid-delivery: now the startup pass may take its live lease over.
    a.child.kill("SIGKILL");
    await a.child.exited;
    expect(await recoverRemoteSessionInbox(Date.now(), { includeLive: true })).toBe(1);
    expect(replies(topic.id)).toBe(1);
    expect(getRemoteSessionInboxClaim(requestId)?.state).toBe("completed");
  }, 30_000);
});
