# Otium ↔ Negotium node architecture

Status: **accepted direction, partially implemented.** Decided 2026-08-07. This document
owns the question "how does an Otium workspace use Negotium nodes"; the wire contract itself
stays in [Runtime Gateway Contract](./RUNTIME-GATEWAY-CONTRACT.md), enrollment/product rules
in [Otium enrollment and sharing](./OTIUM-ENROLLMENT-AND-SHARING.md), and the hub/worker
product model in otium's `docs/workspace-multi-node-peer-plan.md`.

Everything under **Decisions** describes the intended end state. **Current state** marks what
exists today. Do not present planned items as implemented.

## Product statement

Otium's job is to **connect Negotium nodes, including nodes on other computers**, and put a
multi-user product surface in front of them. A Negotium node owns the conversation; Otium owns
who may see it.

This is the concrete form of a rule that already exists in
`OTIUM-ENROLLMENT-AND-SHARING.md`:

> Terminal, Telegram, and Otium are views over the same canonical Negotium topic. They do not
> own independent message or provider-session copies.

## Decisions

### D-1. The Runtime Gateway is the only data plane between Otium and a node

Otium reaches a node through `/api/v1/control/runtime/v1` (`turns`, `events`, `topics`,
`messages`). It does not read the node's database, and the node does not write into Otium's.

Rejected alternative: the `shared-topic-sync` path, which *copied* a topic and its recent
messages into the hub's store (`publishTopic` sent up to 200 messages). Copying created a
second canonical store, which is the failure this architecture exists to avoid. That path was
removed once the Gateway carried both the local and the remote case.

### D-2. Two transports, one contract

| | transport | Central required |
|---|---|---|
| node on the same machine | loopback, `node-control-token` | no |
| node on another machine | relay tunnel, brokered short-lived token | yes |

The contract is identical either way; only reachability and credential differ. The gateway is
loopback-only today by construction — `node-control-token` is a strong host capability and must
not cross a network — so the remote case needs a brokered credential rather than that token.

Central therefore stays, but **only for the remote case**: node registry, peer-token mint and
verify. A single-machine setup must not need it.

### D-3. Ownership split

```
Otium                          Negotium node
─────                          ─────────────
identity, invitations,         topics, messages, turns
membership, authorization      provider sessions, files,
attachments and media          browser profiles, vault
websocket fan-out, UI          skills, wiki/memory
routing: which node
```

A node authorizes exactly one principal: its owner. Otium decides which humans may act as that
principal. **Authorization lives in Otium and is not duplicated in the node.**

### D-4. Identity: one execution principal, separate human attribution

`POST /turns` already separates three identities, and this is the seam:

| field | meaning | authority |
|---|---|---|
| `userId` | execution principal; checked against topic participants | node |
| `actorUserId` / `actorLabel` | the human who wrote it — **attribution only** | Otium |
| `vaultUserId` | credential namespace | node (`vault` is per-user) |

`actorUserId` must never become an input to a permission decision. Keeping it as data is what
stops authorization from drifting into two places.

Negotium stays single-user. It was deliberately migrated to single-user in 0.2.0, and its
resources — workspace directories, browser profiles, provider sessions — are machine-scoped,
not user-scoped. Making them per-user would be the wrong layer: the machine has one owner.

**Consequence to accept:** with execution enabled and a shared vault, anyone who can post in the
mapped Otium room runs commands as the machine owner, with the owner's credentials, on the
owner's machine. The node's participant check is then a consistency check, **not** a security
boundary. The boundary is Otium room membership.

### D-5. A mapped topic has exactly one owner

Already enforced: `gateway.ts` refuses a mapped topic whose owner count is not 1, and ownership
changes are guarded at every mutation site (account deletion, admin routes, topic routes). Keep
this. Execution is gated on it.

### D-6. Surface grants eligibility, not access (supersedes `accessMode`)

> **Superseded 2026-08-08.** `accessMode` (`private`/`shared`), `/public`, `/private`, and the
> subagent access-mode cascade described below were deleted end to end by
> [Surface-scoped sessions](./SURFACE-SESSION-SEPARATION.md). Otium eligibility is now
> `surface = 'otium'`, a permanent property set once at topic creation — not a flag an owner
> toggles later, and not something a subagent cascade needs to propagate, since a derived topic
> simply inherits its parent's `surface`. The paragraphs below describe the retired design for
> historical context only.

In the node, `accessMode: "shared"` means *"the owner consents to this topic being surfaced in
Otium"*. It does not decide who reaches it — Otium room membership does.

This matters because "public" reads as "everyone" in a multi-user product. It must not become a
one-keystroke grant of machine authority to a whole workspace.

Because a subagent room holds its parent's conversation context, consent is expressed at the
parent: switching a topic cascades to its subagent descendants, and a subagent room cannot
change its own access mode.

### D-7. Node-to-node agent conversation is flat

Agents address each other as `"<nodeName>/<topicTitle>"` through session-comm
(`tell_session` / `ask_session` / `abort_session`). Any node may call any node; traffic does not
route through the hub, so agent collaboration survives the hub being down.

This is the horizontal data plane, distinct from the vertical Otium↔node one:

```
        Otium  ── Gateway (turns / events) ──►  node A
                                                  ▲
                                                  │ session-comm "<node>/<topic>"
                                                  ▼
                                                node B
```

### D-8. Channels are Otium membership over a node topic

A Channel's room, transcript, and execution belong to a node; its invitations and membership
belong to Otium. Nothing about multi-participant rooms requires the node to be multi-user —
`participants[]` plus `actorUserId` already carry what is needed.

Concretely this is now the Gateway and nothing else: a room created in Otium gets a *canonical*
node topic via `POST runtime/v1/topics` (`canonical-topic-create`), and turns and events flow
over `runtime/v1` (D-1/D-2). Earlier there was a second mechanism — the hub placed a room on a
worker and drove a private *mirror* topic there over `/api/v1/peer/turn`. Mirrors made a node
topic that its owner had never published reachable from the workspace, which is exactly the
consent split D-6 draws, and they were a second execution path with its own event transport. The
mirror receiver has been removed; there is one data plane.

The room's whole lifecycle therefore has to be expressible over that one plane, or Otium ends up
holding state the node contradicts. Since 0.3.7 it is: `DELETE runtime/v1/topics/:id`
(`canonical-topic-delete`) so a deleted room is not re-mirrored on the next sync pass,
`PATCH runtime/v1/topics/:id` (`canonical-topic-update`) so the agent/model/effort/AI-mode picker
changes the row the turn runner actually reads, and `respond: false` on `POST /turns`
(`turn-submit-silent`) so a room with the AI off or set to mention-only still records its
messages canonically without queueing an answer.

0.3.8 closes the turn/session half of the same gap: `POST runtime/v1/topics/:id/abort`
(`canonical-topic-abort`), `.../session/reset` (`canonical-session-reset`) and
`.../session/compact` (`canonical-session-compact`). A host that starts a turn must be able to
stop it, and a long-running room needs context management that is not "delete the room" — both
existed as control routes, so the gap was purely that Otium could not reach them. All five
mutations plus the two session verbs are what the remote forward exposes (D-2), because the hub
already runs turns on exactly these rooms and aborting a turn is narrower than starting one.
Forking (`POST /topics/:id/derive`) stays loopback-only: it creates a room, which collides with
the mirror/mapping lifecycle above and needs its own design pass.

`packages/node/tests/runtime-contract-coverage.test.ts` now derives both route tables from
`control.ts` and fails when a mutating control route is neither mirrored in the contract nor on an
explicit, reasoned exclusion list, so this particular drift has to be a deliberate choice.

## Current state

> **Update 2026-08-08:** two bullets below (the access-mode cascade and the `accessMode=shared`
> discovery filter) describe the pre-surface model and are superseded by
> [Surface-scoped sessions](./SURFACE-SESSION-SEPARATION.md); see the inline notes on each. The
> rest of this list is unaffected.

Implemented:

- Runtime Gateway contract, both sides — node endpoints in `packages/node/src/control.ts`,
  Otium client in `apps/runtime-api/src/negotium/` (~695 lines) with tests (~495 lines).
  Capability negotiation, SSE resume cursors, idempotent turn submission.
- Execution guarded by a second flag (`OTIUM_NEGOTIUM_GATEWAY_EXECUTION_ENABLED`) separate from
  read/projection (`..._ENABLED`), so a gateway can be verified before it becomes a transcript
  authority.
- session-comm `"<node>/<topic>"` addressing and the `peer-forward` hook, with graceful failure
  on a standalone node.
- Access-mode cascade over subagent rooms, and the subagent self-change guard. *(Superseded: a
  derived topic now simply inherits its parent's `surface`; there is no cascade to run because
  there is nothing left to change after creation.)*
- **Dynamic topic mapping** (D-1/D-6). Three parts, all present:
  - node topic discovery — *(superseded)* was `GET runtime/v1/topics?accessMode=shared`,
    negotiated as the `canonical-topic-list` capability; gateway discovery now always returns the
    `otium` surface and takes no filter at all, so it cannot mirror rooms outside that surface.
  - a persisted mapping table in Otium (`negotium_topic_map`), keyed `(node, topic)` with the
    room 1:1 in the other direction. `OTIUM_NEGOTIUM_GATEWAY_TOPIC_MAP` is now only a seed for
    an existing deployment, not the authority.
  - a sync loop that creates one room per unmapped shared topic and withdraws its own mappings
    when a topic goes private. Operator-written pairs are never withdrawn automatically.
  The room is a shell: the transcript is still projected, never copied.
- **Remote transport for the Gateway** (D-2). A worker exposes the contract at
  `/api/v1/peer/runtime/*`, reached over the relay with a Central-minted peer token and
  restricted to the hub (`fromIsPrimary`). The worker swaps that token for its own
  `node-control-token` in-process, so the host capability never crosses the network. Only the
  read/turn subset is forwarded — mutating control routes stay loopback-only.
- **Placed-turn receiver retired** (D-1/D-8). The worker-side mirror path is deleted:
  `turn-bridge.ts` (`provisionMirrorTopic` / `runPeerTurn` / `abortHostedPeerTurn`),
  `event-backflow.ts` (the worker→hub turn event stream and its terminal outbox), the
  `/api/v1/peer/provision`, `/api/v1/peer/turn` and `/api/v1/peer/input-file` routes, and the
  `otium_peer_sessions` / `otium_peer_turn_requests` / `otium_peer_terminal_outbox` tables.
  Existing databases keep those tables; nothing recreates or drops them. Two consequences worth
  naming: `peerAddressable` collapsed back to a single check (originally `isTopicShared`, now
  `surface === 'otium'`), because a mirror was the only other way onto the cross-node surface, and
  `/api/v1/peer/abort` is purely topic-scoped — a `requestId` named
  one placed turn and now selects nothing. The adapter reports
  `capabilities.externalPlacedTurn: false` and `features.inputFiles: false`.
- **`shared-topic-sync` retired** (D-1). `shared-topic-sync.ts` and `bindings.ts` are deleted
  along with their peer routes (`bind`, `unbind`, `shared-topic/messages`,
  `shared-topics/private`), their CLI subcommands (`bindings`, `share`, `private`) and the
  `otium_shared_*` / `otium_peer_lifecycle` tables. No message is copied into the hub's store any
  more. `negotium otium leave` now only removes the stored credentials — with the copies gone
  there is nothing to delete, and the hub cannot reach a topic it can no longer authenticate to.

Not implemented:

- Nothing outstanding from D-1.

Deliberately kept from the peer stack, and only this:

- the remote *transport* D-2 needs — relay tunnel, enrollment, Central node registry and peer
  token mint/verify (`relay.ts`, `tunnel-client.ts`, `enrollment.ts`, `central.ts`, `sidecar.ts`),
  and the Gateway forward itself (`gateway-forward.ts`, `/api/v1/peer/runtime/*`);
- session-comm (D-7): `/api/v1/peer/tell`, `/ask`, `/sessions`, `/reply` and the title-addressed
  `/abort`, with their idempotency and durable reply/remote-ask state. This is horizontal
  node↔node traffic, not an Otium↔node data plane, so D-1 does not apply to it;
- the peer *bridge* (`runtime-bridge.ts`, `canonical-mcp-bridge.ts`), which routes canonical-room
  mutations such as `spawn_subagent`, `ask_user` and visuals back to a hub. Its per-turn
  `peerBridge` context was only ever produced by the placed-turn path, so on a worker it is
  currently dormant: the code is retained because the hub-side surface it calls still exists and
  the Gateway is the natural place to re-establish that context.

## Open questions

1. **Per-topic execution consent.** `EXECUTION_ENABLED` is process-wide. Given D-4's blast
   radius, a per-topic opt-in is probably required before execution is enabled broadly.
2. **Attribution in other views.** Terminal and Telegram do not render `actorLabel`; with
   multiple humans in one room they will need to.

## Invariants worth testing

- A node never writes to a store it did not resolve through `configureStorageHost`.
  Two independent things broke this, and both are now covered:
  - **Import-time storage access.** A top-level `db.exec(...)` resolves the connection while the
    module is being imported, which for an embedding host is before it can inject one. Schema
    creation must go through `registerStorageSchemaInitializer`, and anything else that touches
    storage during module evaluation must be deferred (see the lazily constructed process bus in
    `bus.ts`). Regression: `tests/core/storage-host-isolation.test.ts`.
  - **Duplicated module state in the published bundles.** Entrypoints built as separate graphs
    each carried their own `configuredHost`, so configuring one did not configure the others.
    Every entrypoint that can reach `storage-host` is now built in one graph. Regression:
    `scripts/package-shared-state.test.ts`, which asserts against built output because source
    is not where this can be seen.
- A subagent room's access mode always equals its root ancestor's.
- A mapped topic has exactly one owner.
- `actorUserId` never reaches an authorization check.
