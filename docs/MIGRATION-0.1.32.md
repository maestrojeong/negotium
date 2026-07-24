# Migration to 0.1.32

Version 0.1.32 improves topic-state isolation, task-panel accuracy, streaming lifecycle handling, and
Telegram input ordering. No SQLite schema, stored topic, conversation, Vault, Wiki, or
browser-profile migration is required.

## Topic and task state

- Runtime state is keyed by the canonical topic ID so topics with the same title remain isolated.
- Wiki prompt resolution continues to prefer collision-safe mirrors and no longer lets a renamed or
  same-title topic select another topic's state.
- Task panels discard stale snapshots after the corresponding live query becomes idle.
- Recently completed tasks remain visible as designed; stale active state is not revived by an older
  snapshot.

## Streaming lifecycle

- Node polling SSE endpoints clean up timers and abort listeners through one idempotent lifecycle.
- Requests that are already aborted do not start polling or heartbeat timers.
- Synchronous and asynchronous polling failures close the stream cleanly, and asynchronous polls do
  not overlap.
- Provider errors and expired sessions discard incomplete assistant segments without emitting a
  successful completion event.
- Session-expiry retries retain their fork rollout and deferred work until the retry owns them.

## Telegram input ordering

- The media intake component owns each chat/thread queue together with album timers and shutdown
  cleanup.
- Photos, documents, voice messages, normal text, and mapping-changing commands retain arrival
  order within a chat or forum thread.
- `/abort` remains an out-of-band control, so it can stop a turn without waiting for a slow file
  download.
- A failed media task no longer prevents later queued input from running.
- Stopping the adapter releases pending albums without downloading files or starting new turns.

## Runtime maintenance

- Turn event consumption and session resolution now have explicit module boundaries while preserving
  the existing public runtime API.
- Telegram commands, Terminal commands, and browser process management were separated from their
  large adapter and manager modules.
- The bundled `maestro-agent-sdk` is upgraded to 0.1.49 for stronger path, process, network, and
  atomic-write safeguards. Negotium already uses its external Background Bash and user-question
  MCPs, so no configuration change is required.
- These refactors keep the existing CLI and adapter behavior while reducing shared mutable state and
  making lifecycle contracts directly testable.

## Upgrade checklist

1. Upgrade `negotium` and `@negotium/adapter-sdk` together to `0.1.32`.
2. Restart Negotium and any long-running Terminal or Telegram adapter processes.
3. Confirm two same-title topics keep independent task and memory state.
4. Confirm `/abort` responds while a Telegram attachment is still downloading.
