/**
 * The gap this file closes.
 *
 * `runtime-multiprocess.test.ts` proves exactly one process wins the
 * session-inbox lease. It says nothing about whether the elected leader ever
 * *runs*, which is precisely how b919a2e shipped: leadership was acquired, the
 * boot flush drained the backlog, and then the trigger starved itself so every
 * subsequent tell_session/ask_session sat in SQLite forever.
 *
 * So: start the real worker, enqueue through the real public API, and require
 * the row to be drained within a latency budget.
 */

import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_INBOX_DIR } from "#platform/config";
import { sessionInboxPath } from "#query/session-inbox-path";
import {
  notifyCallerTopic,
  SESSION_INBOX_COALESCE_MS,
  SESSION_INBOX_POLL_MS,
  startSessionInboxWorker,
} from "#runtime/inbox";
import { deleteMessagesForTopic, getApiMessage } from "#storage/api-messages";
import "#storage/api-topics";
import { db } from "#storage/forum-db";
import { enqueueSessionInbox } from "#storage/session-inbox";
import { SESSION_INBOX_WAKE_FILE } from "#storage/session-inbox-signal";

const userId = `inbox-delivery-${randomUUID()}`;
const stoppers: Array<() => void> = [];
const topicIds = new Set<string>();

/**
 * A topic id that resolves to no topic. The worker then drops the entry — which
 * is all this test needs: the row leaving `session_inbox` proves the trigger
 * fired, claimed and completed the batch, with no agent in the loop.
 */
function newTopicId(): string {
  const id = `delivery-${randomUUID()}`;
  topicIds.add(id);
  return id;
}

function pendingCount(topicId: string): number {
  return Number(
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM session_inbox WHERE topic_id = ?")
      .get(topicId)?.n ?? 0,
  );
}

function tell(message: string) {
  return {
    type: "tell" as const,
    from: "sender-topic",
    message,
    depth: 0,
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

/** Wait until the topic's queue is empty; returns the elapsed ms, or null on timeout. */
async function waitForDrain(topicId: string, timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pendingCount(topicId) === 0) return Date.now() - start;
    await Bun.sleep(5);
  }
  return null;
}

afterEach(() => {
  while (stoppers.length > 0) stoppers.pop()?.();
  for (const id of topicIds) {
    db.run("DELETE FROM session_inbox WHERE topic_id = ?", [id]);
    deleteMessagesForTopic(id);
  }
  topicIds.clear();
});

test("ask_session replies persist explicit TellCard metadata", () => {
  const topicId = newTopicId();
  notifyCallerTopic(topicId, "target-room", "reference result");

  const row = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM api_messages WHERE topic_id = ? ORDER BY rowid DESC LIMIT 1",
    )
    .get(topicId);
  expect(row).toBeDefined();
  expect(getApiMessage(topicId, row?.id ?? "")).toMatchObject({
    authorId: "system",
    kind: "tell",
    tellCard: {
      fromLabel: "target-room",
      label: "Reply from target-room",
      message: "reference result",
    },
  });
});

function startWorker(): void {
  const stop = startSessionInboxWorker();
  stoppers.push(stop);
}

test("a message enqueued while the worker is idle is drained promptly", async () => {
  startWorker();
  // Let leadership settle and the boot drain finish, so the delivery below is
  // driven purely by the steady-state trigger path.
  await Bun.sleep(200);

  const topicId = newTopicId();
  enqueueSessionInbox({ userId, topicId, entry: tell("hello") });
  expect(pendingCount(topicId)).toBe(1);

  const elapsed = await waitForDrain(topicId, 5_000);
  expect(elapsed).not.toBeNull();
  // The wake signal must beat the fallback poll by a wide margin — otherwise
  // the poll is silently carrying delivery again, which is what regressed.
  expect(elapsed ?? Number.POSITIVE_INFINITY).toBeLessThan(SESSION_INBOX_COALESCE_MS * 3);
  expect(SESSION_INBOX_COALESCE_MS * 3).toBeLessThan(SESSION_INBOX_POLL_MS);
});

test("a burst of enqueues is drained without starving on its own trigger storm", async () => {
  startWorker();
  await Bun.sleep(200);

  const topicId = newTopicId();
  for (let i = 0; i < 25; i++) {
    enqueueSessionInbox({ userId, topicId, entry: tell(`burst-${i}`) });
    await Bun.sleep(10); // faster than the coalescing window, like a chatty room
  }

  expect(await waitForDrain(topicId, 5_000)).not.toBeNull();
});

test("delivery keeps working across a worker stop/start cycle", async () => {
  startWorker();
  await Bun.sleep(150);
  stoppers.pop()?.();

  // Nothing is listening now: the row must survive the gap...
  const parked = newTopicId();
  enqueueSessionInbox({ userId, topicId: parked, entry: tell("parked") });
  await Bun.sleep(150);
  expect(pendingCount(parked)).toBe(1);

  // ...and the boot drain of the next term must pick it up.
  startWorker();
  expect(await waitForDrain(parked, 5_000)).not.toBeNull();

  // A second term must also keep its steady-state trigger alive, not just its
  // boot drain (the exact distinction the regression hid behind).
  await Bun.sleep(200);
  const live = newTopicId();
  enqueueSessionInbox({ userId, topicId: live, entry: tell("live") });
  expect(await waitForDrain(live, 5_000)).not.toBeNull();
});

test("a legacy JSONL write still reaches the worker through fs.watch", async () => {
  startWorker();
  await Bun.sleep(200);

  const topicId = newTopicId();
  const filePath = sessionInboxPath(userId, topicId);
  mkdirSync(join(SESSION_INBOX_DIR, userId), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(tell("legacy"))}\n`);

  const start = Date.now();
  while (Date.now() - start < 5_000 && existsSync(filePath)) await Bun.sleep(5);
  expect(existsSync(filePath)).toBe(false);
});

test("the cross-process wake sentinel does not break the inbox scan", async () => {
  // Written by non-leader processes into the watched dir; the scans must ignore
  // it instead of treating it as a user directory.
  writeFileSync(SESSION_INBOX_WAKE_FILE, `${Date.now()}\n`);
  startWorker();
  await Bun.sleep(200);

  const topicId = newTopicId();
  enqueueSessionInbox({ userId, topicId, entry: tell("after-sentinel") });
  expect(await waitForDrain(topicId, 5_000)).not.toBeNull();
});
