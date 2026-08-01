# Migration to 0.1.47

Version 0.1.47 is a correctness release. It closes one security hole, three
paths that lost data silently, and one startup crash, and it stops Korean
topics from compacting far earlier than intended. No SQLite schema change is
required.

**One breaking change: the Telegram adapter now refuses to start without an
allowlist.** Read the first section before upgrading a Telegram deployment.

## Breaking: `negotium telegram` requires `TELEGRAM_ALLOWED_USERS`

An absent `TELEGRAM_ALLOWED_USERS` used to become an empty allowlist, and the
adapter reads an empty allowlist as *allow everyone*. A bot started with only
`TELEGRAM_BOT_TOKEN` therefore served any Telegram user who found it, each one
getting an agent session with shell access as the local owner. Rejection is
deliberately silent, so nothing in the logs distinguished an open bot from a
locked one.

Starting with 0.1.47 the CLI resolves authorization before the bot socket
opens and exits if the result would be an open channel.

```bash
# Required from 0.1.47 on: comma-separated numeric Telegram user IDs.
TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USERS=123456789 negotium telegram
```

Find your numeric ID by messaging `@userinfobot` on Telegram. Usernames and
`@handles` are rejected — they can change hands, IDs cannot.

To keep an intentionally open bot, opt in explicitly:

```bash
TELEGRAM_ALLOW_ALL=true negotium telegram   # warns loudly at startup
```

Setting both is a startup error rather than a silent precedence rule, and
`TELEGRAM_ALLOW_ALL` accepts only `true` or `false` so a typo cannot be
misread in either direction.

Embedders calling `startTelegramAdapter` directly are unaffected: the
`allowedUsers` option keeps its permissive contract, where an empty array means
allow-all. Only the environment-driven CLI is gated.

## Startup crash when two processes open the database together

`initializeDatabase` switched the database to WAL before installing
`busy_timeout`. The WAL switch needs a brief exclusive lock, so when two
processes opened the same database at the same moment — the node daemon and an
adapter, or several MCP servers coming up together — one of them hit
SQLITE_BUSY with no retry budget in force and died with `database is locked`.

Measured with four processes racing one fresh file: **60 of 100 opens failed**
in the old order, 0 of 100 with the timeout set first.

Nothing to do on upgrade. If you have been seeing intermittent
`database is locked` failures when starting several Negotium processes at once,
this was the cause.

## Background bash no longer discards the middle of large output

`background_bash_run` kept a head and tail slice of a long command's output and
discarded everything between them, while the tool description claimed the full
output was injected. Two related defects made it worse:

- the 200 KB budget was compared against `String.length`, i.e. UTF-16 code
  units, so Korean and other CJK output — three bytes per unit — was admitted
  at roughly three times the intended size before truncation;
- the slice cut at arbitrary code-unit offsets, splitting characters into
  replacement characters, and each stdout chunk was decoded independently so a
  multi-byte character straddling a chunk boundary was corrupted too.

The complete output is now written to
`~/.negotium/run/bg-bash-output/<bashId>/{stdout,stderr}.log` and the completion
turn carries a bounded preview plus the real totals and that path. When the
spill itself fails, the message says the output is unrecoverable instead of
naming a file that does not hold it.

Spills follow the existing completed-process retention (about an hour), and the
completion message now states that deadline. A job whose completion turn could
not be delivered keeps its spill instead of expiring on the normal schedule,
since that file is then the only copy of output nobody has seen.

The completion message is also **English now** (`finished` / `command` /
`exit code`), matching the tool descriptions it sits beside in the model's
context.

## JSONL appends fail loudly instead of losing entries quietly

`appendJsonlLine` used to fall back to an unlocked append after failing to take
the lock for 1.5s. An unlocked append is exactly the interleaving the lock
exists to prevent and can damage a neighbouring well-formed entry, and the
caller was told it succeeded.

Contended appends now throw `JsonlLockTimeoutError`, which guarantees nothing
was written, and the lock timeout was moved past the staleness threshold. That
ordering matters: a writer killed while holding the lock leaves the file behind
and only the mtime check reclaims it, so with the shorter timeout **every append
in the ~3.5 seconds after such a crash was lost**. Measured before and after:

| Delay after a crash | 0.1.46 | 0.1.47 |
| --- | --- | --- |
| 0 ms | lost | delivered |
| 1000 ms | lost | delivered |
| 3000 ms | lost | delivered |

Call sites were given explicit policy. Telemetry logs and continues; the
self-schedule sweep retains only the entries it had not delivered, so recovery
can no longer re-run a schedule entry that already fired; `abort_topic` reports
that the signal could not be queued instead of claiming it was; and a
background-bash completion that cannot be delivered is tracked as undelivered
rather than marked complete.

`NEGOTIUM_JSONL_LOCK_STALE_MS` can shorten the window; it exists for tests and
should be left unset in production.

## Korean topics no longer compact early

`shouldCompactForkEntries` added its own CJK surcharge on top of the SDK's token
estimate. `maestro-agent-sdk` 0.1.53 made that estimator script-aware, so the
surcharge became double counting. Measured on 1000 identical characters:

| Script | tokens/char (SDK 0.1.53) |
| --- | --- |
| ASCII | 0.29 |
| Korean / Japanese / Chinese | 1.12 |

The surcharge pushed Korean to 1.83 tokens/char — about 1.6× over-charged — so
Korean topics tripped automatic fork compaction at roughly 58% of the real
threshold. The local surcharge is gone and the SDK estimate is used directly.
Long Korean topics will now run noticeably further before compacting.

## Maestro tool results are bounded, with the full text kept

`maestro-agent-sdk` has always been able to cap an oversized tool result, keep
the untruncated bytes on disk, and expose them through its `ReadToolOutput`
tool — but Negotium never passed `toolResultTruncation`, so every tool result
entered the context at full size and the `ReadToolOutput` entry in the
provider's builtin list was dead.

It is on by default now. Full output is saved under
`~/.negotium/run/maestro-tool-outputs`. Pass
`toolResultTruncation: { enabled: false }` on a call whose tool results must
arrive whole, or supply the object to tune `maxBytes`.

Claude and Codex are unaffected; their SDKs do their own truncation.

## Control plane: no more internal detail in responses

Unclassified exceptions were answered with `400` and the raw `error.message`,
so an internal fault was reported as a client mistake with filesystem paths and
pids attached. Those now log at error level and return a fixed
`500 Internal control-plane error`.

Genuine validation still answers `400` with an actionable message. Two cases
were reclassified: a missing `clientMessageId` or `requestId` used to return
`409` because the catch block matched on message text before the typed check,
and a malformed percent-encoded path (`/topics/%/…`) used to reach the `500`
branch. A real idempotency conflict is still `409`.

## Also in this release

- `maestro-agent-sdk` 0.1.52 → 0.1.53. Besides the token estimator, its `Glob`
  tool now respects `.gitignore` by default; pass `no_ignore: true` to include
  dependencies and generated output. Partial `Read` results report their line
  range.
- `packages/core/src/query/control.ts` (313 lines) was deleted. It had no
  importers and no package export path; the live implementation is
  `query/active-rooms.ts`.
