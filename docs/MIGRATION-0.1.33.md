# Migration to 0.1.33

Version 0.1.33 makes blocking user questions durable, keeps large Terminal pastes compact, improves
Terminal deletion shortcuts, and upgrades the bundled Maestro Agent SDK. The Ask User gate table is
created automatically in the shared SQLite database. No manual topic, conversation, Vault, Wiki, or
browser-profile migration is required.

## Durable user questions

- Pending questions are recorded as durable SQLite gates and reconciled when the node starts.
- Gates owned by a healthy runtime remain active; gates left by a dead process are quarantined and
  may be reminted with a new gate ID.
- An optional `idempotency_key` replays the same pending or answered question. Reusing the key with
  different question content fails with `idempotency_conflict`.
- Terminal, web, and Telegram answers share one atomic claim. The first valid answer wins and later
  attempts fail closed.
- A runtime-event publication failure quarantines the new gate instead of leaving future retries
  blocked on an unreachable in-memory promise.
- Crash-left process leases are swept without removing a live process whose heartbeat is delayed.

## Terminal input

- Pasting at least 500 characters or 8 lines into the normal composer displays a compact
  `‹[Pasted 1,234 chars]›` label while retaining the original text for submission.
- Editing or deleting a paste label discards its hidden original. Multiple pastes remain independent.
- Topic-name and Vault forms keep pasted text visible and do not use collapsed labels.
- Alt/Option-Backspace deletes the previous word. Cmd-Backspace clears before the cursor when the
  terminal forwards a supported key sequence; `Ctrl-W` and `Ctrl-U` remain reliable aliases.

## Maestro runtime

- `maestro-agent-sdk` is upgraded to `0.1.50`.
- Bash output accounting now uses raw UTF-8 byte counts, preserves multibyte characters at
  truncation boundaries, releases oversized backing buffers, supports validated per-call
  environment overrides, and reports retained and omitted byte statistics.

## Upgrade checklist

1. Upgrade `negotium` and `@negotium/adapter-sdk` together to `0.1.33`.
2. Restart Negotium and any long-running Terminal, Telegram, or Otium adapter processes.
3. Confirm an Ask User card accepts only one answer when multiple clients respond.
4. Confirm a large Terminal paste appears as a compact label and submits its original content.
