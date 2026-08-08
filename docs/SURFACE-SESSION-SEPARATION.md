# Surface-Scoped Sessions (S-1 … S-11)

Status: implemented in both repos; host rollout pending an npm publish
Date: 2026-08-08
Supersedes: the `accessMode` (`private`/`shared`) half of
[OTIUM-NODE-ARCHITECTURE.md](./OTIUM-NODE-ARCHITECTURE.md) D-6 and
[OTIUM-ENROLLMENT-AND-SHARING.md](./OTIUM-ENROLLMENT-AND-SHARING.md)

## Problem

Today one node keeps **one flat topic namespace** and all three adapters (terminal, telegram,
otium) read it. Consequences:

| Symptom | Where |
|---|---|
| A topic name may exist only once per node | `findTopicTitleConflict` — `packages/core/src/storage/api-topics.ts:819`, called from `topics/create.ts:65`, `topics/derive.ts:268,446` |
| Whether a topic reaches Otium is a per-topic flag toggled by hand | `access_mode` — `api-topics.ts:222`; `/public`, `/private` — `adapters/terminal/src/command-router.ts:104`; `Ctrl-P` — `adapters/terminal/src/render.ts:1426` |
| `session-comm` can address every topic on the node regardless of where it lives | `createSessionTargetCatalog` — `packages/core/src/mcp/session-comm/topic-catalog.ts:54` |
| Gateway discovery is driven by `accessMode=shared` | `packages/node/src/control.ts:340-388`, `adapters/otium/src/peer-server.ts:120` |

The earlier direction was to *unify* the three surfaces. That was wrong: the three surfaces are
different products with different audiences. What should be shared is **knowledge** (memory, wiki,
skills), not the session list.

## Decisions

**S-1 — `surface` is a first-class topic column.**
`api_topics.surface TEXT NOT NULL CHECK (surface IN ('terminal','telegram','otium'))`.
A topic belongs to **exactly one** surface, for its whole life. There is no "expose this terminal
topic to Otium" operation; you create the topic on the surface you want it on.

**S-2 — the node still owns all three.** One node, one canonical store, one `api_topics` table.
`surface` is a partition key, not a new process, store or daemon.

**S-3 — name uniqueness is per surface.** The conflict key becomes
`(surface, kind, LOWER(TRIM(title)))`. A topic named `otium` may exist once on `terminal`, once on
`telegram` and once on `otium`.

**S-4 — `accessMode` is deleted outright.** Not deprecated: the type `TopicAccessMode`, the
`access_mode` column, `switchTopicAccessMode`, the `/topics/:id/access-mode` control route, the
`?accessMode=` discovery filter, `/public`, `/private`, `Ctrl-P` and the subagent access-mode cascade
all go away. Gateway eligibility becomes `surface = 'otium'`.

**S-5 — the terminal topic picker loses its Public/Private grouping.** `render.ts:1488-1497`
currently groups `Manager / Private / Public`. The `Private` heading becomes **`Topics`** and the
`Public` group disappears (a terminal client only ever sees `surface='terminal'`).

**S-6 — each adapter sees only its own surface.** Terminal lists `terminal`, the telegram adapter
lists `telegram`, the Otium gateway lists `otium`. Filtering happens in the store query, not in the
adapter, so a missed call site cannot leak a topic across surfaces.

**S-7 — `session-comm` is surface-scoped.** `list_sessions` / `peek_session` / `tell_session` /
`ask_session` / `abort_session` only resolve targets whose surface equals the caller's surface.
Cross-surface addressing is not a supported feature and is not exposed with an override flag.
Cross-*node* addressing (`"<node>/<topic>"`, D-7) is unaffected and stays within a surface.

**S-8 — memory, wiki and skills stay global.** They are keyed by memory key / skill name, never by
topic id or surface, so `terminal:otium` and `otium:otium` share one brief. This is already true
structurally (`api_topics.memory_key` is independent of the topic id) and must not regress.
Workspaces stay **per topic id** — files are session state, not knowledge.

**S-9 — migration is evidence-driven with a host default.**
1. Core schema migration `api_topics_surface_20260808` adds the column and backfills every existing
   topic with `NEGOTIUM_DEFAULT_SURFACE ?? 'terminal'`.
2. `ssh otium` and `ssh otium-worker` set `NEGOTIUM_DEFAULT_SURFACE=otium` in the host env **and**
   re-save the pm2 dump — an absent or unquoted value in the saved dump wins over the dotenv file
   (see [[pm2-dump-env-shadows-dotenv]]). Every topic on those hosts is an Otium room.
3. The telegram adapter owns its own backfill: on startup, once, it flips every topic that has a
   mapping row in the telegram adapter's own store to `surface='telegram'`. Core cannot do this —
   that mapping lives in a separate database file under the state dir, not in the canonical store.
4. The local Mac therefore ends up **split**: telegram-mapped topics → `telegram`, everything else →
   `terminal`.

**S-10 — migration renames collisions automatically.** After backfill, any `(surface, kind, title)`
duplicate keeps the oldest `created_at` and the others become `"<title> (2)"`, `"<title> (3)"`, … .
The rename is logged at `warn` with the topic id and both names, and recorded in
`api_schema_migrations` so it runs exactly once.

**S-11 — an Otium channel thread `@`-mention answers *in that thread*.** Today
`POST /api/v1/topics/:topicId/messages/:messageId/thread`
(`~/otium/apps/runtime-api/src/api/routes/messages.ts:341`) appends the reply and broadcasts it but
never starts a turn — the AI trigger is client-side `postAiQuery`
(`apps/app-renderer/src/stores/chat.ts:1366`), which the thread pane does not call. And the mapped-
topic branch rejects threads outright (`messages.ts:363`, "Attachments, threads, and mentions are not
supported by the Negotium canary"). Required end state: a mention inside a thread starts a turn whose
reply carries the same `threadRootId`, for both Otium-native and node-mapped rooms.

## Non-goals

- Making a topic visible on two surfaces at once.
- Moving a topic between surfaces after creation (may be added later; not part of this change).
- Splitting the canonical store or the node process per surface.
- Changing how memory/wiki/skills are stored.

## Work plan

| # | Phase | Repo | Depends on |
|---|---|---|---|
| 1 | `surface` column + schema migration + `(surface, kind, title)` uniqueness | negotium | — |
| 2 | Thread `surface` through topic creation (`registerTopic`, `derive`, CLI, MCP `register_topic`, spawn/fork inherit the parent's surface) | negotium | 1 |
| 3 | Surface-scoped listing in the store; adapters pass their surface | negotium | 2 |
| 4 | `session-comm` surface scoping | negotium | 3 |
| 5 | Delete `accessMode` end to end; gateway discovery keys on `surface='otium'` | negotium | 3 |
| 6 | Terminal UI: drop `/public`, `/private`, `Ctrl-P`; `Private` → `Topics` | negotium | 5 |
| 7 | Telegram startup backfill + telegram-surface topic creation | negotium | 3 |
| 8 | Collision auto-rename in the migration + tests | negotium | 1 |
| 9 | Otium: gateway/room projection reads `surface='otium'` instead of `accessMode` | otium | 5 |
| 10 | Otium: thread `@`-mention starts a turn and replies into the thread (S-11) | otium | — |
| 11 | Rollout: `NEGOTIUM_DEFAULT_SURFACE=otium` on `otium` + `otium-worker`, verify counts before/after | ops | 1-9 |

## Measured rollout state (2026-08-08)

| Host | negotium | topics | duplicate titles | after migration |
|---|---|---|---|---|
| local Mac | repo build | 13 | 0 | 12 `terminal` + 1 `telegram` (7 mapping rows, 6 point at deleted rooms) |
| `otium` | 0.2.24 (`~/otium/node_modules`) | 44 | 0 | 44 `otium` |
| `otium-worker` | 0.2.23 (global) | 3 | 0 | 3 `otium` |

`NEGOTIUM_DEFAULT_SURFACE=otium` is already appended to the env file on both hosts (worker processes
run with `cwd=$HOME`, so bun picks up `~/.env` at next start). It is inert until the new code boots.
Zero collisions anywhere, so the auto-rename path will not fire on this fleet.

**The local canonical store is already migrated** — a full `bun test` run initializes the real state
dir, so the schema init applied the backfill and dropped `access_mode` there. The local daemon still
holds the pre-migration code in memory and its topic INSERT still names `access_mode`; it must be
restarted before anything creates a topic locally.

## Verification

- Migration test on a copy of a real canonical store: row counts per surface before/after, zero
  duplicate `(surface, kind, lower(title))` after, rename log matches the collision count.
- A `terminal` topic and an `otium` topic with the same title coexist; each adapter's list shows one.
- `list_sessions` from a terminal topic never returns a telegram or otium topic.
- Two same-named topics on different surfaces resolve to *different* rooms via `tell_session`.
- Both surfaces' topics with memory key `X` load the same `wiki_read` brief (S-8).
- `grep -rn "accessMode" packages apps adapters --exclude-dir=dist` returns zero (S-4).
