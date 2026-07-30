# Migration to 0.1.43

Version 0.1.43 preserves consecutive user messages that arrive while a user turn is
running or waiting to start. It also restarts the provider session from the state that
existed before the interrupted turn. No manual data conversion is required.

## Ordered consecutive user messages

When a newer user message supersedes an active user turn, Negotium keeps every accepted
user message in arrival order. The provider receives one ordered batch, while the
conversation log records each original user message as its own `user_message` event.
Attachments are carried forward and deduplicated in first-seen order.

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
`user_prompts_json`. Existing databases are upgraded with:

```sql
ALTER TABLE runtime_user_turn_requests ADD COLUMN user_prompts_json TEXT;
```

The column contains a JSON string array when a request has multiple or explicitly tracked
user messages. `NULL`, invalid JSON, or an empty value falls back to the existing `prompt`
column, so existing queued requests remain claimable. The legacy topic-primary-key table
copy also initializes this column as `NULL`.

## Compatibility and rollback

Older Negotium versions ignore the new nullable column and continue reading `prompt`, so
mixed-version startup and rollback are schema-compatible. If a queued batch is processed
by an older version, it may be presented as the rendered single prompt and the individual
message boundaries cannot be reconstructed by that version. New writes made after rollback
therefore do not provide the 0.1.43 preservation behavior.

No destructive migration is performed. Rollback does not require removing
`user_prompts_json`; leaving the nullable column in place is the supported rollback path.
Upgrade direct Negotium packages lockstep to `0.1.43`, then restart the runtime process
that owns the affected topics.
