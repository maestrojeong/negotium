# Migration 0.8.0 - Telegram multi-group namespaces

`0.8.0` lets one Telegram adapter connect to several forum groups without sharing topic names,
manager sessions, or routing state between them. It also begins a typed identifier vocabulary and
removes unused query/runtime compatibility types.

## Telegram groups are independent namespaces

Each connected forum now owns a canonical surface namespace:

```text
surface = telegram
surfaceScope = tg:<chatId>
```

Topics with the same title may exist in different groups. Each group gets its own `General`
manager topic and provider session. `/topics`, `/load`, `/new`, `/del`, topic materialization, and
message routing stay inside the caller's group scope. A cross-group mapping is rejected even when
the raw topic id is known.

The adapter database gains a `telegram_groups` table. On first start, the previous single
`forum_chat_id` setting is promoted automatically. Existing mapped topics are filed into a group
only when the mapping identifies exactly one group and the topic owner, surface, existing scope,
and title are all safe. Ambiguous fan-out and mismatched mappings are quarantined rather than
silently moved or deleted. The migration is idempotent and requires no manual SQL for a normal
single-group installation.

Unscoped Telegram topics are no longer adopted merely because one forum happens to be connected.
Callers creating a forum-owned topic must provide the group's `surfaceScope`; derived topics and
subagents inherit it from their parent.

## `surfaceScope` is now surface-neutral

The canonical topic store now preserves an explicit scope for any surface. Otium keeps its existing
workspace scope and wire protocol unchanged; Terminal remains unscoped by default. There is no
Otium database migration in this release.

## Public API cleanup

The unused `HandleAgentQueryParams`, `HandleAgentQueryOutcome`, and numeric `SessionContext` exports
are removed. The pre-canonical forum and topic-name settings stores are no longer re-exported as
top-level functions from `negotium/storage`; temporary compatibility access remains under the
deprecated `forum` and `topicSettings` namespaces.

Embedding hosts that still import the removed top-level forum aliases or `SessionContext` must
remove those imports before upgrading. The Runtime Gateway contract, SSE payloads, and the wire
field named `queryId` are unchanged.

## Identifier vocabulary

`negotium` now exports branded `UserId`, `TopicId`, `MessageId`, `RequestId`, `TurnId`,
`ProviderSessionId`, `TurnSlotKey`, and `FileId` types. Storage and wire representations remain
strings. Adoption is intentionally incremental: existing public DTO field names and serialized
formats do not change in `0.8.0`.

## Upgrade checklist

1. Upgrade Negotium and restart the Telegram adapter once to run its automatic group migration.
2. Check logs for `legacy topic spans multiple groups` or `quarantined mapping` warnings. Those
   indicate pre-existing ambiguous fan-out that needs an operator-chosen destination.
3. Update embedding-host imports that used the removed compatibility types or top-level forum
   functions.
4. No manual SQLite migration, topic recreation, or Otium workspace migration is required for the
   normal case.
