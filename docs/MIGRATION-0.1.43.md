# Migration to 0.1.43

Version 0.1.43 preserves consecutive user messages that arrive while a user turn is
running or waiting to start. It also restarts the provider session from the state that
existed before the interrupted turn, clarifies subagent delegation topology, and resolves
Wiki topic titles through their canonical topic ids. No manual data conversion is required.

## Ordered consecutive user messages

When a newer user message supersedes an active user turn, Negotium keeps every accepted
user message in arrival order. The provider receives one ordered batch, while the
conversation log records each original user message as its own `user_message` event.
Each message retains its own attachment list. Attachment order and repeated attachment
ids are preserved instead of being flattened into a deduplicated batch.

The same ordering is retained when messages cross the remote runtime handoff. Pending
requests store the original texts separately from the rendered provider prompt so a
restart or delayed claim cannot collapse the batch into one message.

Remote replacement runs in one SQLite `BEGIN IMMEDIATE` transaction. Concurrent runtime
processes therefore serialize the read/merge/replace operation instead of allowing the last
writer to delete another process's newly accepted message. Existing FIFO requests for the
topic are folded into the replacement in creation order.

If a locally preempted batch loses the topic-lease race and falls back to durable handoff,
it carries the ids of durable rows already represented by its in-memory envelopes. The
transaction removes only that verified envelope prefix from the incoming copy before
appending its new suffix. This prevents provider input duplication without deduplicating
legitimate repeated messages, and retains intervening FIFO requests in arrival order.

Conversation events retain each original message and its materialized attachment prompt.
Events belonging to one preempting provider turn carry the total batch size and each
message's zero-based batch index. Synthetic rollout reconstruction uses both values as an
explicit boundary, so separate interrupted batches cannot be joined merely because their
events are adjacent. Unrelated prompts following an explicitly stopped or failed turn
remain separate.

Durable requests persist the count of user messages successfully appended to the
conversation log. Claim or lease state alone is not treated as proof of an append: the
count advances only after the synchronous log write succeeds. A crash between dispatch
and append therefore leaves the message eligible for replay instead of silently dropping
it from reconstructed history.

## Interrupted-turn provider session

For a superseding user turn, the provider session id is reset to the session that existed
before the interrupted turn. This prevents provider-side partial output from becoming the
base state for the replacement batch. The replacement turn therefore starts from the
last known pre-turn session and receives all consecutive user messages in order.

Runtime-gateway ingress snapshots this session base when it durably accepts the request,
including an explicit `null` for a topic that has not created its first provider session.

## Storage migration

The `runtime_user_turn_requests` table gains the additive nullable column
`user_messages_json`. Existing databases are upgraded with:

```sql
ALTER TABLE runtime_user_turn_requests ADD COLUMN user_messages_json TEXT;
```

The column contains an ordered JSON array of `{ prompt, attachments? }` envelopes.
`NULL`, invalid JSON, or an empty value falls back to one envelope built from the existing
`prompt` and `attachments_json` columns, so existing pending and running requests remain
claimable. The legacy topic-primary-key table copy also initializes this column as `NULL`.

## Subagent delegation guidance

Generated runtime instructions now distinguish ownership/reporting topology from execution
and data flow. They preserve independent parallelism, keep simple sequential work inline,
and reserve nested subagents for actual ownership. They also state that `create_subagent`
fixes `task` and `report_mode`, while `start_subagent` only starts the prepared room.

Non-parent `tell_session` routes should be granted only after both rooms exist and when
direct communication is useful. The route can remain open for the collaboration window and
should be revoked when that collaboration ends. Result modes are explicit: `auto` returns
the final body to the direct parent, `tell` requires the child to send its result directly,
and `status-only` returns lifecycle without result content.

## Canonical Wiki topic briefs

`wiki_topic_brief` now resolves an exact topic id or a normalized topic title against the
caller's accessible topics before reading the brief. Hidden topics, topics where the caller
is not a participant, and ambiguous duplicate titles fail closed. A successful title match
reads the canonical UUID-keyed brief first, with the accessible legacy title retained only
as a storage fallback. This prevents title lookup from returning a stale brief while direct
UUID lookup returns the current one.

An exact accessible topic id takes precedence over title matching. A different topic whose
title happens to equal that id therefore cannot make the exact-id lookup ambiguous.

## Compatibility and rollback

Older Negotium versions ignore the new nullable column and continue reading `prompt`, so
mixed-version startup and rollback are schema-compatible. If a queued batch is processed
by an older version, it may be presented as the rendered single prompt and the individual
message boundaries cannot be reconstructed by that version. New writes made after rollback
therefore do not provide the 0.1.43 preservation behavior.

No destructive migration is performed. Rollback does not require removing
`user_messages_json`; leaving the nullable column in place is the supported rollback path.
Upgrade direct Negotium packages lockstep to `0.1.43`, then restart the runtime process
that owns the affected topics.
