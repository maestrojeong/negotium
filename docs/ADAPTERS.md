# Adapters

Negotium keeps first-party adapters as private source workspaces and bundles them into `negotium`.
This document owns adapter lifecycle, state mapping, topic access, and transcript projection. Runtime
invariants are defined in [Architecture](./ARCHITECTURE.md).

## Package layout

```text
negotium
├── private node/runtime workspaces
├── built-in Terminal adapter
├── built-in Telegram adapter
└── built-in Otium adapter

Terminal/Telegram ── authenticated control API ── canonical node
Otium sidecar ────── authenticated adapter API ─── canonical node
all adapters ─────── @negotium/adapter-sdk lifecycle contract
```

Keeping source boundaries allows focused builds and tests without exposing internal npm APIs.
`adapters/*` is canonical source; the release build bundles it into `negotium`. Third-party adapters
depend on `@negotium/adapter-sdk`, including its `./outbox` and `./testkit` subpaths.

## Lifecycle contract

An adapter receives or creates a node client, starts its channel input, projects RuntimeBus events,
and returns a handle with an idempotent `stop()` operation. Adapter startup must either complete or
clean up all resources it created.

The adapter SDK declares capabilities instead of pretending every channel has the same UI:

| Adapter | Transcript | History backfill | External author display |
| --- | --- | --- | --- |
| Terminal | `full` | yes | `native` |
| Otium | `full` | not yet | `relayed` |
| Telegram | `live-only` | no | `relayed` |

Unsupported cards, visuals, files, or history operations need an explicit fallback or visible error.
They must not disappear silently.

## Process topology

One canonical long-lived node owns a state directory, turn execution, MCP hosts, Cron, and inbox
workers. Terminal and Telegram use its authenticated control API. Otium's public peer listener and
relay tunnel run in a sidecar, while its runtime bridge is mounted inside the canonical Node through
an authenticated loopback adapter API. Closing or crashing any adapter does not stop active turns.
Telegram and Otium enforce one process of each kind per state directory.

The loopback control and adapter APIs bind to `127.0.0.1` and use a mode-0600 bearer token stored
under the state root. A SQLite singleton lease prevents a second node from owning the same state
directory. Adapter process leases power `negotium status` and adapter-specific stop commands.

For commands and recovery options, see the root [README](../README.md) and the relevant package README.

## Shared and adapter-local state

| State | Relationship across adapters |
| --- | --- |
| Topic, message, provider session | Shared through core |
| Task, wiki, skill, vault | Shared through runtime services |
| Cron schedule and run history | Shared through the node module |
| Telegram chat/thread ID | Telegram-only mapping |
| Otium room, binding, and peer request | Otium-only mapping |
| Terminal selection, scroll, composer | One Terminal client only |

Adapters never create provider-specific copies of canonical tasks or topic history.

External room and message ids remain adapter-local and resolve to canonical Node ids at ingress.
The ownership and lifetime rules for `topicId`, `clientMessageId`, `requestId`, `queryId`, and
`surfaceScope` are defined in [Identifier boundaries](./IDENTIFIERS.md).

## Topic visibility and surface

Visibility and surface are independent fields:

- `visibility: visible | hidden` controls whether a topic appears in pickers.
- `surface: terminal | telegram | otium` is a permanent property of a topic, set once at creation.
  `surfaceScope` partitions a surface into independent namespaces: Telegram uses `tg:<chatId>` and
  Otium uses its stable workspace scope.
  There is no "share this topic with Otium" operation and no `accessMode` field; each adapter only
  ever lists topics whose `surface` matches its own, filtered in the store rather than in the
  adapter. See [Surface-scoped sessions](./SURFACE-SESSION-SEPARATION.md) for the full design and
  the migration this replaced (the former `accessMode: private | shared` field, `/public`,
  `/private`, and `Ctrl-P`, all deleted end to end).

Otium execution mirrors are `hidden`; they are internal worker state for hub-owned rooms, not
user-selectable local topics. A local `surface='otium'` topic is different: the visible Negotium
topic remains authoritative and the Otium room is a projection of it.

## Transcript projection

A full projection shares the same topic lock, append-only raw conversation history, compactable
active provider context, workspace, and provider session regardless of which adapter starts the
turn — but only within the topic's own surface. A Terminal topic is never visible to Otium or
Telegram, and vice versa; there is no cross-surface view of one topic.

```text
        terminal-surface topic         otium-surface topic
    messages · session · workspace   messages · session · workspace
                  ▲                              ▲
                  │                              │
              Terminal                        Otium
              full view                      full view

        telegram-surface topic
    messages · session · workspace
                  ▲
                  │
              Telegram
        input and live notifications
```

Telegram is not a full transcript surface even for its own topics. The Bot API cannot recreate
arbitrary authors, original timestamps, historical message IDs, or rich task/visual/card state.
Mapping a topic later therefore does not backfill it as though the conversation originally
occurred in Telegram.

Otium declares `full/no-backfill` until a durable projection journal can synchronize local-origin
history, reconnect from a binding sequence, and deduplicate messages by stable source ID. The exact
peer transport belongs in [Otium coupling](./OTIUM-COUPLING.md).

## Terminal

Terminal reads visible topics through the node control API and requires no channel mapping. Its state
reducer should be deterministic from a storage snapshot plus ordered runtime events. It must preserve
Unicode width, alternate-screen restoration, resize behavior, scrolling, and blocking-choice input.

The default client uses authenticated REST and cursor-based SSE. Composer submissions use the
idempotent Runtime Gateway turn contract; topic management, Vault, usage, and picker state remain on
the Terminal control surface. `--embedded` calls the same durable application boundary in process
and exists only as a recovery and development path.

## Telegram

Telegram owns durable group metadata and chat/thread-to-topic mappings. One bot may connect to
multiple forum groups. Every group has an independent topic namespace and `General` manager;
same-named topics in two groups are separate canonical topics. `/load` resolves only inside the
current group, and `/unload` removes only that mapping. Forum topic materialization must be
idempotent when duplicate `topic-created` events arrive.

Private messages use the same personal `General` manager topic visible in Terminal. A response to a
Telegram-origin turn returns only to its origin. A response started elsewhere has no Telegram origin
and may be projected to every Telegram mapping for that topic according to adapter policy.

Telegram-origin user messages are not echoed by the bot. User messages projected from another
adapter are rendered by the bot with a `[From: User]` prefix so the channel boundary remains visible.

Media grouping, HTML splitting, rate-limit retry, and outbound ordering are Telegram concerns. File
paths and symlinks must be validated before upload.

## Otium

Otium owns remote room IDs, node credentials, placement, binding state, and peer request journals. It
may bind a hub room to a hidden worker mirror or project a local `surface='otium'` topic. Unbinding
never deletes the local topic.

The adapter must preserve protocol versioning, primary-node authorization, request idempotency,
contiguous event sequence numbers, and exact abort semantics. See [Otium coupling](./OTIUM-COUPLING.md)
for the wire contract.

## Development rules

- Use the package-local `@/` alias only for imports within one package.
- Cross-package imports go through public package exports.
- Build output must not contain checkout-specific absolute paths or unresolved source aliases.
- Each adapter implements the shared contract tests plus channel-specific lifecycle and projection
  tests.
- A process that did not create the node must not stop it during adapter shutdown.

Run the repository checks from the root:

```bash
bun run check
bun test
```
