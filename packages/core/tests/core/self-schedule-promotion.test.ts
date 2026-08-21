import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FROM_SELF_SCHEDULE } from "#platform/constants";
import { readJsonlLines } from "#platform/jsonl";
import { scheduledSessionInboxPath } from "#query/session-inbox-path";
import { sweepScheduledSessionInbox } from "#runtime/inbox";
import { db } from "#storage/forum-db";

const userId = `self-sched-${randomUUID()}`;
const topicId = randomUUID();
const schedulePath = scheduledSessionInboxPath(userId, topicId);
const processingPath = `${schedulePath}.processing`;

function entry(message: string, deliverAt: string) {
  return {
    type: "tell" as const,
    from: FROM_SELF_SCHEDULE,
    message,
    depth: 0,
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
    deliverAt,
  };
}

function messages(path: string): string[] {
  if (!existsSync(path)) return [];
  return readJsonlLines(path)
    .map((line) => (JSON.parse(line) as { message: string }).message)
    .sort();
}

function queuedMessages(): string[] {
  return db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM session_inbox WHERE topic_id = ? ORDER BY sequence",
    )
    .all(topicId)
    .map((row) => (JSON.parse(row.payload) as { message: string }).message)
    .sort();
}

function seed(entries: ReturnType<typeof entry>[]): void {
  mkdirSync(dirname(schedulePath), { recursive: true });
  writeFileSync(schedulePath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 3_600_000).toISOString();

afterEach(() => {
  rmSync(dirname(schedulePath), { recursive: true, force: true });
  db.run("DELETE FROM session_inbox WHERE topic_id = ?", [topicId]);
});

test("a clean promotion delivers each due entry once and keeps the future one", () => {
  seed([entry("due-A", past()), entry("due-B", past()), entry("not-yet", future())]);

  sweepScheduledSessionInbox(Date.now());

  expect(queuedMessages()).toEqual(["due-A", "due-B"]);
  expect(messages(schedulePath)).toEqual(["not-yet"]);
  expect(existsSync(processingPath)).toBeFalse();

  // Recovery sweeps must be idempotent.
  sweepScheduledSessionInbox(Date.now());
  expect(queuedMessages()).toEqual(["due-A", "due-B"]);
});

test("an interrupted promotion retains only what it had not delivered", async () => {
  // Shrink the lock window so the contended append fails in ~2s instead of
  // blocking this thread for ~6.5s and starving every other test file.
  const previousStale = process.env.NEGOTIUM_JSONL_LOCK_STALE_MS;
  process.env.NEGOTIUM_JSONL_LOCK_STALE_MS = "500";

  seed([entry("due-A", past()), entry("due-B", past()), entry("not-yet", future())]);

  // Promotion appends the due entries to the live inbox, then rewrites the
  // future ones back to the schedule. Hold the *schedule* lock with a live
  // external holder so only that last step fails. The holder must be another
  // process: the append blocks this thread on `Atomics.wait`.
  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { writeFileSync, utimesSync, mkdirSync } = require("node:fs");
       const { dirname } = require("node:path");
       const lock = process.env.LOCK;
       mkdirSync(dirname(lock), { recursive: true });
       writeFileSync(lock, "");
       setInterval(() => {
         const now = Date.now() / 1000;
         try { utimesSync(lock, now, now); } catch { process.exit(0); }
       }, 250);`,
    ],
    { env: { ...process.env, LOCK: `${schedulePath}.lock` }, stdout: "ignore", stderr: "pipe" },
  );

  try {
    while (!existsSync(`${schedulePath}.lock`)) await Bun.sleep(10);
    sweepScheduledSessionInbox(Date.now());
  } finally {
    holder.kill();
    await holder.exited;
    rmSync(`${schedulePath}.lock`, { force: true });
    if (previousStale === undefined) delete process.env.NEGOTIUM_JSONL_LOCK_STALE_MS;
    else process.env.NEGOTIUM_JSONL_LOCK_STALE_MS = previousStale;
  }

  // The due entries went out.
  expect(queuedMessages()).toEqual(["due-A", "due-B"]);

  // The claim survives for recovery, but holding the WHOLE batch would make the
  // next sweep re-deliver due-A and due-B. Only the undelivered entry remains.
  expect(existsSync(processingPath)).toBeTrue();
  expect(messages(processingPath)).toEqual(["not-yet"]);

  // Recovery therefore adds nothing to the inbox and reschedules the future one.
  sweepScheduledSessionInbox(Date.now());
  expect(queuedMessages()).toEqual(["due-A", "due-B"]);
  expect(messages(schedulePath)).toEqual(["not-yet"]);
}, 30_000);
