# Migration to 0.1.44

Version 0.1.44 changes Wiki memory from room-id-scoped mirrors to one accumulated
memory namespace per normalized topic title. Recreated rooms and subagents that select
the same title now continue the same durable topic experience.

## Title-scoped accumulated memory

The canonical topic brief is:

```text
wiki/topic/<title>.md
```

The Wiki archiver reads the existing title brief, merges durable facts, decisions,
preferences, patterns, current state, and query hints, then writes one compact replacement.
UUID and room-id suffixes are no longer added to new topic brief filenames.

This namespace is intentionally shared by every accessible room with the same normalized
title in the node's shared Wiki. Topic ids remain accepted as selectors and as read-only
fallbacks for older SQLite rows and filesystem mirrors.

## Immutable source summaries

Every archive turn writes a separate source summary:

```text
wiki/summaries/<date>-<title>.md
wiki/summaries/<date>-<title>~2.md
wiki/summaries/<date>-<title>~3.md
```

Summary creation uses exclusive filesystem creation and retries the numeric suffix, so
concurrent writers cannot overwrite a prior source summary. The reserved `~N` separator cannot
occur in a normalized title, so titles such as `Roadmap` and `Roadmap-2` remain distinct.
`save_wiki_entry` no longer replaces the accumulated topic brief with the latest session summary.

The runtime selects the newest matching title summary by modification time. The deleted-topic
digest also filters candidates by date and topic title, preventing another topic's newly
written summary from being attributed to the deleted topic.

## SQLite and filesystem recovery

SQLite Wiki rows are now written under the normalized title key. Existing room-id and legacy
raw-title rows remain readable as migration fallbacks.

Filesystem topic briefs and summaries remain canonical recovery sources. A missing or failed
SQLite cache write no longer suppresses an existing `wiki/topic/<title>.md` or latest title
summary from turn prompt injection.

## Concurrent archive and index updates

Archive turns with the same normalized title are serialized in the runtime. This prevents
two archivers from reading the same prior brief and then losing one merge through
last-writer-wins replacement.

Wiki index updates acquire a cross-process lock around the complete read-modify-write
operation and publish the result through an atomic temporary-file rename. Historical
duplicate canonical targets are collapsed during the upsert.

## Existing Wiki files

Older UUID-suffixed briefs and summaries remain readable as compatibility fallbacks. Operators
may consolidate them into the title file after taking a Wiki backup. Preserve their durable
facts in the accumulated title brief and retain immutable source summaries; do not discard
legacy content without merging it.

No SQLite schema change is required. Rollback to 0.1.43 leaves title files and title-keyed
rows intact, but 0.1.43 may prefer its older room-id namespace and will not provide the
0.1.44 concurrency guarantees.

Upgrade direct Negotium packages lockstep to `0.1.44`, then restart the runtime process that
owns the affected topics.
