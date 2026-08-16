import { db } from "#storage/forum-db";

/**
 * Empty the durable user-turn queue.
 *
 * `claimNextRuntimeUserTurnRequest` claims the oldest pending row in the whole
 * table, by design — a worker takes whatever work is waiting. Every test that
 * asserts on what it gets back is therefore asserting about global state, and
 * bun runs every test file in one process against one database. So a request
 * another file enqueued and never completed gets claimed instead of the one
 * under test, and the failure reads as a wrong `topicId` in a test that never
 * mentions that topic.
 *
 * Cleaning up one's own topics afterwards cannot fix this, because the
 * pollution arrives from outside. Claiming tests have to start from an empty
 * queue instead.
 *
 * Deliberately only a `DELETE`. Calling `ensureRuntimeUserTurnRequestsSchema`
 * here looks tidier and is a trap: it performs an `ALTER TABLE ... RENAME` and
 * table rebuild when it detects the legacy primary key, so running it between
 * tests corrupts the fixture it was meant to prepare.
 */
export function resetRuntimeTurnQueue(): void {
  try {
    db.query("DELETE FROM runtime_user_turn_requests").run();
  } catch {
    // No table yet: nothing has ensured the schema in this process, which means
    // there is also nothing queued to interfere with.
  }
}
