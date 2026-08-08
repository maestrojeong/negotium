# Surface-Scoped Sessions (S-1 … S-11)

Status: shipped — negotium 0.2.26, otium `0fe85c1`, all hosts migrated
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

**S-12 — the `otium` surface will need an instance scope before a node can join
more than one Otium. Designed now, not built.**

`surface` stays a closed set of three. What it does *not* encode is *which*
Otium a room belongs to. Today that is safe because a node holds exactly one
join — `loadJoin()` reads a single `otium-join.json` or a single
`OTIUM_CENTRAL_URL`/`OTIUM_CELL_ID`/`OTIUM_CELL_SECRET` triple
(`adapters/otium/src/join.ts:344-378`). The fan-out is the other way round: one
hub reaches many nodes (`gatewayTargets()`, `apps/runtime-api/src/negotium/nodes.ts:76-95`).
A single *machine* can already be in several Otiums by running several nodes
with different `NEGOTIUM_STATE_DIR`s, but each of those has its own store, so
nothing mixes.

The intended shape when multi-join arrives:

```
surface: terminal | telegram | otium          (closed set, unchanged)
  └─ otium only: scope = which Otium + which role
       · the local Otium app                  (self / hub runtime)
       · another workspace, as hub runtime
       · another workspace, as worker runtime
```

Concretely: an `api_topics.surface_scope` column (`cell_…`, or `local` for the
app on this machine), NULL for terminal/telegram, added to the uniqueness key
and to `session-comm` target resolution. The identifiers already exist —
`OtiumJoin.cellId` + `central` for the instance, `PeerNode.isPrimary`/`self`
for the role.

**Order matters**: the scope column is worthless until `loadJoin` returns a
*set* of joins and the gateway/peer paths branch per cell. Adding it first
yields a column with one distinct value and a more complex uniqueness key for
no isolation. Adding it *after* rooms from two workspaces have already mixed in
one store means splitting them apart by hand. So: build multi-join and the
scope together, or neither.

**S-13 — a threaded mention in a *node-mapped* room still gets no answer.
Scoped, awaiting a decision on one merge rule.**

S-11 fixed threads for Otium-native rooms. A room backed by the node is still
broken, and worse than before the thread pane existed: the reply is stored and
the answer never comes. Two refusals sit in the way —
`apps/runtime-api/src/api/routes/messages.ts:363` rejects threads/mentions on a
mapped room, and `apps/runtime-api/src/api/routes/ai.ts:2094` rejects the whole
mapped room from the local AI route — so the client posts the reply, then gets a
409 for the turn.

**The contract extension is smaller than it first looks.** An earlier claim in
this document's history — that Negotium has no thread concept — was wrong.
The canonical store already models threads end to end: `api_messages.thread_root_id`
(`packages/core/src/storage/api-messages.ts:38`), the DTO field
(`packages/core/src/types/api.ts:246`), read/write mapping (`:180`, `:238`),
thread summaries (`:486`) and exclusion of replies from the main list (`:434`).
Nothing needs a migration.

What is missing is carrying one thread id from the gateway request to the
assistant messages of that turn:

1. `UserTurnEnvelope` (`packages/core/src/runtime/user-turn-envelope.ts:2`) gains
   `threadRootId?`. It is persisted as JSON, so this is additive — no schema change.
2. `submitRuntimeGatewayTurn` (`packages/core/src/application/submit-runtime-gateway-turn.ts:17`)
   accepts it, stamps the user message, and puts it in the envelope.
3. `POST /api/v1/control/runtime/v1/turns` (`packages/node/src/control.ts`) accepts
   and forwards it.
4. The turn's assistant text has exactly one chokepoint —
   `emitPendingAssistantMessage` (`packages/core/src/runtime/turn-event-stream.ts:218`) —
   which already receives a per-turn `execution` object carrying `sourceNode`
   (`:131`). `threadRootId` rides there, plumbed from the pending request through
   `startAiTurn` → `streamAgentEvents` (`turn-runner.ts:267,1648`).
5. Otium routes a mapped room's threaded mention through `submitTurn` with the
   thread id instead of the local AI route, and drops the blanket refusal.

**The open question — merge semantics.** Negotium deliberately merges pending
user messages for a busy room into one batch
(`mergeRuntimeUserTurnRequest`). If one queued message was asked in a thread and
another in the channel, the merged turn has two possible homes and no correct
answer. Options: (a) answer in the channel whenever a batch is mixed, (b) never
merge across thread boundaries — keep a separate pending request per thread, (c)
answer each contributing message in its own thread by splitting the reply. (b)
is the only one that is always right and the only one that changes queue
behaviour. This needs a decision before implementation.

## Non-goals

- Making a topic visible on two surfaces at once.
- Joining one node to several Otium workspaces (see S-12 — designed, not built).
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

## Rollout (completed 2026-08-09)

negotium **0.2.26** + otium **`0fe85c1`**. Every store on the fleet now carries `surface` and has
dropped `access_mode`.

| Store | topics | surface | notes |
|---|---|---|---|
| local node | 14 | `terminal` | telegram backfill idle — the adapter is not running locally |
| local Otium (`:4200`) | 2043 | `otium` | |
| `otium` node | 44 | `otium` | gateway list verified: 44 rooms, surface all `otium` |
| `otium` Otium (`:3000`) | 52 | `otium` | |
| `otium-worker` node | 3 | `otium` | no Otium checkout; pure node |

Zero title collisions fleet-wide, so the auto-rename path never fired.
`NEGOTIUM_DEFAULT_SURFACE=otium` is set in the env file on both remote hosts; Otium's own store
declares it in `forum-db.ts` instead, so a developer machine needs no configuration.

### Two traps this rollout hit

**A stale nested `node_modules` silently pinned the hub four versions back.**
`~/otium/apps/runtime-api/node_modules/negotium` held 0.2.21 and shadowed the workspace root's
0.2.25, so `otium-api` kept booting old code and its store never gained the column — through a
`git pull`, a `bun install` and a restart. `bun install` does not remove such a copy; only
`require.resolve("negotium/package.json")` exposes it. The same copy existed on the local Mac.

**Otium's store needs a convergent invariant, not a one-shot migration.** Negotium's backfill records
itself, so a store first opened by an older build keeps its rooms on `terminal` while new rooms
arrive as `otium`. Because `findTopicTitleConflict` is surface-scoped, that split silently starts
accepting duplicate titles — two rename tests caught it. Otium therefore re-asserts the invariant on
every boot rather than migrating once.

## Verification

- Migration test on a copy of a real canonical store: row counts per surface before/after, zero
  duplicate `(surface, kind, lower(title))` after, rename log matches the collision count.
- A `terminal` topic and an `otium` topic with the same title coexist; each adapter's list shows one.
- `list_sessions` from a terminal topic never returns a telegram or otium topic.
- Two same-named topics on different surfaces resolve to *different* rooms via `tell_session`.
- Both surfaces' topics with memory key `X` load the same `wiki_read` brief (S-8).
- `grep -rn "accessMode" packages apps adapters --exclude-dir=dist` returns zero (S-4).
