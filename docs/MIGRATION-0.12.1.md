# Migration 0.12.1

Negotium 0.12.1 answers a cross-topic `ask_session` in the thread it was asked from.

## The gap 0.12.0 left

0.12.0 made a threaded turn legible to the model and stamped the messages that turn raises — its
assistant text, its `ask_user_question` cards, its system notices — with the thread. A reply from
*another topic* was not stamped, because it does not come from that turn: `ask_session` hands the
question to a second room and the answer arrives later as an inject, by which point the thread was
forgotten. The answer still arrived and was still acted on; it appeared in the channel.

## What carries the thread now

The chain the answer travels already had a place for this at every step; only the value was missing.

1. `session-comm` is spawned with `--thread-root-id`. Its MCP config is rebuilt for every turn — the
   same reason `--peer-host-query-id` can carry a query id — so a per-turn value reaches a stdio
   subprocess without a side channel.
2. `ask_session` records it on the session-inbox entry as `fromThreadRootId`, an optional field
   beside the existing `contextId` and `fromDepth`.
3. The in-memory ask registry keeps it as `AskPending.callerThreadRootId`.
4. Delivery stamps the visible "Reply from …" card with it and starts the caller's follow-up turn
   inside the thread.

## Batched replies stop at thread boundaries

Ask replies for a busy room are batched into one turn. A batch mixing a thread's reply with the
channel's would have two possible homes and no correct answer, so `DeferredInject` now joins the
merge predicate on its thread — the same rule `mergeRuntimeUserTurnRequest` already applies to user
turns. Replies from *different topics* answering into the *same* thread still merge, which is the
case batching exists for.

## Unchanged behavior

- No database migration, no schema change, and no new capability: the fix is internal routing.
- Session-inbox entries written by 0.12.0 replay unchanged. They carry no thread and answer in the
  channel, exactly as they did when they were written.
- `tell_session` is unaffected. It is one-way, so it has no reply to place.
- A node-mapped host needs no change; `turn-submit-reply-context` still describes what it must
  detect.

## Upgrade notes

Run `bun install`, rebuild Negotium, and restart the resident Node. In-flight asks queued by the
previous process answer in the channel; asks raised after the restart answer in their thread.
