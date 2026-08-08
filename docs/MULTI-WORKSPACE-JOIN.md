# Joining Several Otium Workspaces (M-1 … M-9)

Status: accepted, not yet implemented
Date: 2026-08-09
Extends: [SURFACE-SESSION-SEPARATION.md](./SURFACE-SESSION-SEPARATION.md) S-12
Related: [OTIUM-NODE-ARCHITECTURE.md](./OTIUM-NODE-ARCHITECTURE.md) D-1 … D-8

Goal: one node may be joined to **several** Otium workspaces at once, and may
join or leave one of them **without a restart** and without disturbing the
others.

## How a join works today

Worth stating plainly, because the word "join" suggests a connection and there
isn't one.

1. `negotium otium join <code>` decodes a base64url invite into
   `{ v, central, cellId, secret }` and writes `~/.negotium/data/otium-join.json`
   at 0600 (`adapters/otium/src/join.ts:44,290`). **No network call happens.**
2. At node startup `mountConfiguredOtiumNodeRuntime()` reads that file
   (`adapters/otium/src/node-runtime.ts:37`). Absent → returns `null` and no
   Otium feature exists in the process. Present → `startOtiumNodeRuntime({ join })`.
3. Mounting registers the peer runtime bridge, the session bridge, the canonical
   MCP bridge, the peer reply outbox worker and file hooks, and calls
   `configureOtiumCentral(join)` (`adapters/otium/src/index.ts:93-130`).

So **the join file is an on/off switch**, and there is no standing socket:
Central is called per request with a 30 s cache (`adapters/otium/src/central.ts`).
The log line is "attached to workspace", not "connected".

Reachability runs the other way round:

- **Local** (hub and node on one machine) — the hub calls the node over loopback
  through the Runtime Gateway. This works with no join at all; it is how the
  `otium` host runs today.
- **Remote worker** — the node opens an outbound relay tunnel via `otium serve`
  (`adapters/otium/src/tunnel-client.ts`, reconnecting with backoff) and the hub
  arrives through it. This is the NAT traversal path.

Central only does three things: node discovery (`/peer/nodes`), peer token
minting and peer token verification. No transcript passes through it.

## Decisions

**M-1 — a room's workspace is fixed when the room is created.**
`api_topics.surface_scope` is written at creation and never changes, exactly as
`surface` is (S-1). NULL for `terminal`/`telegram`.

**M-2 — the scope key is the workspace, not the seat.**
Three identifiers are easy to confuse:

| value | means | after leave + re-join |
|---|---|---|
| `cellId` | this node's **seat** in that workspace | new invite → **new value** |
| `secret` | that seat's credential | new invite → new value |
| `workspaceId` | the **workspace itself** | unchanged |

A room belongs to a workspace, so the scope is derived from `workspaceId`, not
`cellId`. Keying on `cellId` would orphan every room the moment the owner
re-joined the same workspace with a fresh invite — the exact failure this
decision exists to avoid.

`scopeId = sha256(central_origin + "\n" + workspaceId)`, truncated for
readability. `central` is included because two independent Otium deployments may
issue the same `workspaceId`. Both source values are kept in the join record;
the hash only keeps the column short and opaque.

**M-3 — `workspaceId` is resolved lazily, and joining stays offline.**
The invite carries no `workspaceId`; only Central knows it, and it is already
returned by `/peer/nodes` (`central.ts:71,77`) and by peer token verification
(`VerifiedPeer.workspaceId`, `central.ts:21,135`).

Making `join` an online operation would be simpler and is rejected: it would
break offline enrollment, which works today. Instead the join record is written
with `scopeId: null` and resolved on the first successful Central contact.
**Until it resolves, that workspace may not create rooms** — a room with no
scope cannot be filed and would have to be repaired later. Execution and reads
are unaffected.

**M-4 — leaving keeps its rooms, and keeps them executable.**
`leave` removes credentials only. The rooms stay, keep their `surface_scope`,
and remain runnable exactly as before. This is the smallest change and matches
what `otium leave` already does. Consequences accepted:

- Nobody can reach those rooms *through that workspace* any more (its hub can no
  longer call the node), but their transcript and local execution survive.
- Re-joining the same workspace makes them reachable again with no repair step,
  because the scope is workspace-derived (M-2).

Rejected: read-only-on-leave (needs a per-room execution gate that does not
exist and adds a state nothing else uses) and delete-on-leave (an unrecoverable
answer to a reversible action).

**M-5 — Central credentials become per-cell instead of process-global.**
This is the largest piece of work. `configureOtiumCentral(join)` stores one
`joinConfig` in a module-level variable and `centralFetch` reads it
(`central.ts:39-51`), i.e. the whole process assumes a single workspace. Every
Central call must instead take the cell it is speaking for, and the peer caches
(`nodesCache`, verify cache) must be keyed by cell rather than reset globally.

**M-6 — the runtime mounts once per joined workspace.**
`startOtiumNodeRuntime` becomes an instance per join: its own peer reply outbox
worker, its own relay tunnel, its own self-check. Bridges that are *global by
nature* (the canonical MCP bridge, file hooks, the topic-deleted subscription)
stay single and are refcounted, not duplicated.

**M-7 — join and leave take effect without a restart.**
`join` resolves the scope (M-3), then mounts that workspace's instance; `leave`
unmounts exactly that instance — stopping its tunnel and outbox and dropping its
credentials — and leaves every other workspace running. The mount/unmount
surface is the same one the node already uses at startup, so there is one code
path, not a startup path plus a hot path.

**M-8 — inbound peer requests are attributed to a cell before they are trusted.**
A verified peer token already reports `workspaceId` and `fromCellId`. With
several workspaces attached, verification must also answer *which of my cells
was this addressed to*, and a request verified against workspace A must never be
allowed to touch a room scoped to workspace B. This is the security boundary of
the whole feature and needs an explicit test.

**M-9 — migration: stamp existing rooms with the current workspace.**
On upgrade, every `surface='otium'` room is stamped with the scope of the single
join present at that moment (or left NULL when there is none, e.g. a pure
loopback hub with no join). No rename can occur, because the scope enters the
uniqueness key at the same time — unlike the surface migration, which had to
rename collisions (S-10).

## Order of work

1. `surface_scope` column + uniqueness key + `session-comm` scoping, behind the
   single existing join (no behaviour change yet)
2. M-9 migration stamp
3. Per-cell Central credentials (M-5) — the invasive one, alone in its own change
4. `loadJoins(): OtiumJoin[]` + storage format with single-file migration
5. Per-workspace mount (M-6) and dynamic join/leave (M-7)
6. Inbound attribution and its tests (M-8)

Steps 1–2 are safe to land before any multi-join capability exists and make the
later steps mechanical. Step 3 is the one that can destabilise the running
fleet; it should ship on its own so a regression has an obvious cause.

## Verification

- Two workspaces attached: a room named `paper` may exist in each, and neither
  appears in the other's list.
- `session-comm` from a room in workspace A cannot address a room in workspace B.
- Leave A: its rooms remain, still execute locally, and B is untouched — no
  restart, no dropped tunnel for B.
- Re-join A with a **new invite** (new `cellId`): the original rooms reattach
  with no repair step.
- A peer token verified for workspace A is refused against a workspace B room.
- Joining offline leaves `scopeId` unresolved, blocks room creation for that
  workspace only, and resolves on the first Central contact.
