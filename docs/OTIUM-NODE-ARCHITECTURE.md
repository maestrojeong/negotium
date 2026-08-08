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

Rejected alternative: the `shared-topic-sync` path, which *copies* a topic and its recent
messages into the hub's store (`publishTopic` sends up to 200 messages). Copying creates a
second canonical store, which is the failure this architecture exists to avoid.

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

### D-6. `/public` grants eligibility, not access

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

## Current state

Implemented:

- Runtime Gateway contract, both sides — node endpoints in `packages/node/src/control.ts`,
  Otium client in `apps/runtime-api/src/negotium/` (~695 lines) with tests (~495 lines).
  Capability negotiation, SSE resume cursors, idempotent turn submission.
- Execution guarded by a second flag (`OTIUM_NEGOTIUM_GATEWAY_EXECUTION_ENABLED`) separate from
  read/projection (`..._ENABLED`), so a gateway can be verified before it becomes a transcript
  authority.
- session-comm `"<node>/<topic>"` addressing and the `peer-forward` hook, with graceful failure
  on a standalone node.
- Access-mode cascade over subagent rooms, and the subagent self-change guard.
- **Dynamic topic mapping** (D-1/D-6). Three parts, all present:
  - node topic discovery — `GET runtime/v1/topics?accessMode=shared`, negotiated as the
    `canonical-topic-list` capability. `shared` is the only filter a host should use, so it
    cannot mirror rooms the owner never published.
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

Not implemented:

- **Retiring `shared-topic-sync`** (D-1). Still present and still copies messages. It is now
  redundant for the single-machine and worker cases alike; removing it means unpicking
  `startOtiumNodeRuntime`, `peer-server`, `index` and `cli`, which all reach into it.

Deliberately kept from the peer stack: relay tunnel, enrollment, Central node registry and token
brokering — these are the remote *transport*, which D-2 needs. Only the message-copying half is
being retired.

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
