# Migration to 0.1.43

Version 0.1.43 preserves consecutive user messages that arrive while a user turn is
running or waiting to start. It also restarts the provider session from the state that
existed before the interrupted turn. No manual data conversion is required.

## Ordered consecutive user messages

When a newer user message supersedes an active user turn, Negotium keeps every accepted
user message in arrival order. The provider receives one ordered batch, while the
conversation log records each original user message as its own `user_message` event.
Each message retains its own attachment list. Attachment order and repeated attachment
ids are preserved instead of being flattened into a deduplicated batch.

The same ordering is retained when messages cross the remote runtime handoff. Pending
requests store the original texts separately from the rendered provider prompt so a
restart or delayed claim cannot collapse the batch into one message.

## Interrupted-turn provider session

For a superseding user turn, the provider session id is reset to the session that existed
before the interrupted turn. This prevents provider-side partial output from becoming the
base state for the replacement batch. The replacement turn therefore starts from the
last known pre-turn session and receives all consecutive user messages in order.

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
