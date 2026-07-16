# Otium enrollment and topic sharing

This document owns the product, authorization, and user-experience design for attaching a Negotium
node to an Otium workspace and sharing local topics with it. The peer wire protocol remains owned by
[Otium coupling](./OTIUM-COUPLING.md); general adapter behavior remains owned by
[Adapters](./ADAPTERS.md).

Everything under **Current behavior** describes the repository today. Everything under **Target
design** or **Delivery plan** is planned work and must not be presented as already implemented.

## Goals

- A workspace administrator can invite one Negotium node without handling a long-lived credential.
- Negotium starts and remains useful without any Otium runtime API or network connection.
- A node operator can see which workspace is requesting enrollment before accepting it.
- Losing an invite response, retrying a request, or restarting either process cannot create duplicate
  runtime cells.
- Local topics remain private by default. Only an owner can make a topic eligible for Otium access.
- Every user surface distinguishes sharing permission from an active Otium room binding.
- Removing Otium access takes effect at request time, even if stale binding state remains.
- Secrets, invite tokens, local private keys, and private-topic data never appear in logs or UI copy.

## Non-goals

- Human workspace membership invitations. Those authorize people and have a separate identity and
  lifecycle from machine enrollment.
- Synchronizing every existing local message immediately after a topic is shared. Durable transcript
  backfill requires a projection journal and is separate work.
- Remote deletion of data that Otium received before a topic was made private.
- Hardware attestation or enterprise fleet policy in the first production release.

## System boundary

```text
Terminal client ── authenticated REST/SSE ──┐
Telegram adapter ── durable chat mapping ───┼── Negotium core
                                            │   topics, messages, sessions,
Otium adapter ── authenticated peer API ────┘   workspaces, runtime events
       │
       ├── enrollment credential for one Otium runtime cell
       └── Otium room <-> local topic bindings
```

Terminal, Telegram, and Otium are views over the same canonical Negotium topic. They do not own
independent message or provider-session copies. Otium additionally owns remote workspace and room
identity, peer authentication, event delivery, and binding journals.

## Runtime API and hub responsibility

“No runtime API” has two different meanings and the architecture must keep them separate:

1. **Negotium standalone:** no Otium process is installed or reachable. Terminal, Telegram, local
   topics, turns, tasks, files, and schedules continue to work. The Otium adapter is dormant.
2. **Otium workspace:** users open an Otium client and expect shared rooms, history, realtime events,
   membership, and placement. That product still requires one logical workspace hub even if there is
   no separately deployed process named `runtime-api`.

The hub role cannot disappear because one authority must own canonical Otium room state, client
authentication, WebSocket fan-out, placement decisions, ordered peer-event ingress, deduplication,
and reconnect recovery. Moving these responsibilities into Central or another managed service removes
the `runtime-api` deployment unit; it does not remove the logical hub.

### Recommended topology

The near-term topology should make Otium's existing runtime API the primary hub by definition, not a
generic node that sometimes behaves as a hub and sometimes as a worker:

```text
Otium Central
  identity, membership, enrollment, node registry, hub discovery
            │
            ▼
Otium workspace hub (current runtime-api)
  canonical Otium rooms/messages, client REST/WS, placement,
  peer orchestration, event ordering, projected artifacts
            │
            ├── optional built-in/local execution engine
            └── 0..N enrolled workers
                        ├── Negotium node
                        └── future worker implementations
```

Each Otium workspace has exactly one active hub and zero or more workers. A Negotium enrollment adds a
worker; it must not implicitly replace or become the workspace hub. Central should provision or locate
the default hub before issuing a worker invite. This preserves one stable client endpoint and one
canonical owner while allowing execution to move independently.

Otium Central already has the beginning of this invariant through primary assignments and rejection of
a worker assignment when no hub exists. The remaining work is to make it a product/deployment
contract, remove “runtime API as a generic peer node” assumptions, and separate hub availability from
local execution availability.

The peer transport can remain symmetric for authenticated `tell`, `ask`, reply, health, and capability
exchange. Data ownership is intentionally asymmetric: workers do not become alternate Otium databases
and may not write hub storage directly.

### Separate hub from local execution

The current runtime API combines two responsibilities that should become separable:

- **workspace hub:** canonical collaboration state and client/peer coordination;
- **local executor:** provider sessions and AI turns that happen on the hub machine.

The hub may initially ship with its local executor for compatibility. It should still operate as a
collaboration hub when that executor is disabled, provided every AI-enabled topic is placed on an
available worker. A topic without a valid executor remains readable and accepts human collaboration,
but an AI turn fails with an explicit placement error rather than falling back to an unintended node.

This separation creates a later migration path:

```text
today:        runtime-api = workspace hub + optional local executor
near term:    workspace-hub service + optional executor module
later:        managed hub service; customers install only Negotium workers
```

Renaming `runtime-api` to `workspace-hub` is useful only after the responsibility split is real. A
directory rename by itself does not improve the boundary.

### Ownership modes

The hub must record the source and authority of each room so sharing does not create split-brain state:

| Mode | Authoritative topic | Hub responsibility | Worker responsibility |
| --- | --- | --- | --- |
| Hub-owned, worker-placed | Otium hub room | Canonical transcript and client events | Hidden execution mirror and provider session |
| Negotium-shared | Visible Negotium topic | Otium projection, room membership, delivery cursor | Canonical local topic, execution, source event IDs |

A source authority cannot change implicitly. Moving a hub-owned room to another worker preserves hub
authority. Converting a projected Negotium topic into a native Otium room, or the reverse, requires an
explicit migration with a durable cursor and conflict policy.

### Failure isolation

- No enrollment credentials means the Otium adapter remains off; it must not affect node startup.
- Central or hub downtime blocks new Otium peer operations but does not block local adapters or turns.
- Existing local shared topics remain locally usable while Otium is offline.
- Outbound Otium events queue within a bounded durable policy or fail visibly; they never stall the
  canonical local topic lock indefinitely.
- Making a topic private is local and immediate even when the hub is unavailable.
- A workspace whose hub is unavailable is read-only only to the extent supported by its client cache;
  workers must not elect themselves hub or accept direct client writes.

## Current behavior

### Node join

The current v0 invite is a base64url-encoded credential bundle containing `central`, `cellId`, and
the runtime cell bearer `secret`. `negotium otium join <code>` decodes it locally and stores
`otium-join.json` with mode 0600. It does not claim a server-side one-time enrollment.

This is suitable only for the direct-URL development experiment because copying the invite copies the
long-lived runtime credential. Production `join` must replace this behavior. The v0 parser should
eventually be available only behind an explicit development command or flag.

### Topic access and bindings

Canonical topics have two independent fields:

| Field | Values | Meaning |
| --- | --- | --- |
| `visibility` | `visible`, `hidden` | Whether a user-facing picker may list the topic |
| `accessMode` | `private`, `shared` | Whether a non-local adapter such as Otium may address it |

Locally created topics default to `visible + private`. Otium execution mirrors are `hidden + shared`:
they are internal state for hub-owned rooms and never appear in Terminal or Telegram pickers.

An Otium binding is separate from `accessMode`. A visible local topic may therefore be in one of
three user-relevant states:

| State | `accessMode` | Otium binding | Effect |
| --- | --- | --- | --- |
| Local | `private` | none | Otium cannot discover or address it |
| Shared, unbound | `shared` | none | Eligible for Otium, but not projected to a room |
| Otium connected | `shared` | one or more | Eligible and connected to the listed Otium rooms |

Only an owner may change a visible topic's access mode. Making a topic private removes its shared
bindings while preserving the local topic, transcript, workspace, and provider session. Peer routes
also check `accessMode` at request time instead of trusting binding rows alone.

Current inspection is fragmented:

- `negotium topics` prints `[private]` or `[shared]`.
- `negotium otium bindings` prints actual mirror/shared binding rows.
- Terminal and Telegram list visible topics but do not label access or binding state.
- `negotium otium share` currently changes access and creates a binding in one operation.

## Target design: machine enrollment

Human invitations and machine enrollment must use different records, endpoints, audit events, and
revocation controls. A human invite grants membership to a user. A node enrollment bootstraps one
machine identity and one runtime-cell assignment.

### Invite creation

A workspace owner or administrator creates a node enrollment invite with:

- workspace ID;
- optional suggested node name;
- node kind, initially `negotium`;
- permitted transport: `relay`, `direct`, or `auto`;
- expiry, ten minutes by default and at most 24 hours;
- maximum claims, fixed to one for the first release;
- creator and audit metadata.

Central generates at least 256 bits of random token material. The client receives the opaque token
once; storage retains only its hash. An invite must never contain a runtime cell secret or serialized
credential bundle.

The preferred user representation is a join URL whose token is in the fragment, so ordinary HTTP
server and proxy logs do not receive it:

```text
https://app.otium.example/join#<opaque-token>
```

The CLI may also accept a short copyable form containing an Otium origin identifier plus the opaque
token. It must not infer an arbitrary Central URL from unsigned JSON.

### Preview and confirmation

Before claiming, `negotium otium join` requests a non-sensitive preview and displays:

- Otium origin;
- workspace name;
- inviting administrator identity where policy allows;
- requested node name and transport;
- invite expiry;
- the fact that only explicitly shared Negotium topics will be accessible.

Interactive use requires confirmation. A non-interactive deployment must pass an explicit acceptance
flag and node name. Preview does not consume the token and is rate-limited.

### Node identity

The node generates an Ed25519 key pair locally before claiming. The private key never leaves the
Negotium state root and should use the operating-system secret store when available, with an atomic
mode-0600 file fallback.

The claim sends the public key, node name, Negotium version, supported protocol versions,
capabilities, transport preference, and a client-generated idempotency key. Central atomically:

1. verifies and locks the unexpired invite;
2. binds the invite to the submitted public-key fingerprint;
3. creates or recovers one runtime cell;
4. creates the workspace worker assignment;
5. marks the invite claimed;
6. returns endpoints, cell identity, workspace metadata, and a credential bound to the node key.

Public-key challenge authentication is the target. If the first production increment must retain a
bearer runtime secret, Central returns it once, stores only its hash, and exposes credential rotation.
That is an implementation step toward the key-bound identity, not a reason to put the secret in the
invite.

### Idempotency and ambiguous responses

The claim is keyed by invite ID, public-key fingerprint, and client idempotency key. If Central
accepted a claim but the response was lost, retrying with the same token and key returns the same
cell and assignment. It must not create another cell. Reusing a claimed token with another key is a
conflict and an auditable security event.

The node writes returned credentials atomically before reporting success. If local persistence fails,
it can recover the same accepted enrollment with the original local key. The plaintext invite token
is deleted after successful persistence.

### Transport verification

Relay or `auto` with relay fallback is the default because most nodes are behind NAT. A direct URL is
not marked ready merely because the client submitted it. Central or the hub performs a nonce
challenge and the node signs the challenge with its enrolled key.

Direct endpoint validation must defend against SSRF and DNS rebinding: allow only approved schemes,
resolve and validate every address, apply network policy, revalidate redirects, bound response sizes
and timeouts, and never forward workspace credentials to the candidate endpoint before proof.

### Enrollment lifecycle

```text
pending -> claimed_pending_verification -> active
   |                    |                    |
expired/revoked      failed/revoked      suspended/rotating/removed
```

- Unclaimed invites can be listed and revoked by workspace administrators.
- Active nodes can be suspended without deleting their historical room assignments.
- Credential rotation increments a credential version and invalidates the previous credential after
  a bounded overlap.
- Losing the node key requires a new enrollment; it does not make an old invite reusable.
- `negotium otium leave` removes the local credential only after clear confirmation and attempts an
  authenticated server-side disconnect. A failed remote disconnect is reported, not hidden.

### Proposed Central records

```text
node_enrollment_invites
  id, workspace_id, token_hash, created_by, suggested_name,
  transport_policy, constraints_json, expires_at, claimed_at,
  claimed_key_fingerprint, revoked_at, created_at

runtime_cells / worker_assignments
  existing cell and workspace ownership plus node public key,
  credential_version, status, last_seen_at

node_enrollment_claims
  invite_id, idempotency_key, key_fingerprint, cell_id,
  response_version, created_at
```

Claim consumption, cell creation, assignment, and recovery metadata must commit in one transaction.

### Proposed Central API

| Method and path | Authorization | Purpose |
| --- | --- | --- |
| `POST /api/v1/workspaces/:id/node-invites` | workspace admin | Create an opaque one-time invite |
| `GET /api/v1/workspaces/:id/node-invites` | workspace admin | List status without token material |
| `POST /api/v1/workspaces/:id/node-invites/:inviteId/revoke` | workspace admin | Revoke an unused invite |
| `POST /api/v1/node-enrollments/preview` | invite token | Return bounded non-sensitive metadata |
| `POST /api/v1/node-enrollments/claim` | invite token | Atomically enroll or recover one node |
| `POST /api/v1/node-enrollments/rotate` | active node | Rotate its credential |
| `POST /api/v1/node-enrollments/leave` | active node | Disconnect the node |

Exact payloads and version negotiation belong in Otium's Central API contract. Negotium's peer
runtime endpoints remain in [Otium coupling](./OTIUM-COUPLING.md).

## Target design: topic sharing

### Authorization invariant

Every room-scoped inbound or outbound Otium operation involving a local topic must satisfy all of the
following:

```text
authenticated enrolled node
AND permitted workspace/room
AND active binding for that room and topic
AND topic.accessMode == shared
```

Discovery is the deliberate exception because it is used to create a binding: it may list only shared
topics visible to the requesting local user and reveals no transcript or workspace contents. Private
topics must be treated as absent rather than leaking their title or existence. Binding lookup is not
authorization: a stale row cannot override the canonical topic access mode.

### Product terminology

The database and wire contract may retain `private | shared` for compatibility, but user interfaces
should prefer unambiguous labels:

- **Local**: private to local Negotium adapters;
- **Shared**: Otium access is allowed but no room is connected;
- **Otium connected**: shared and bound, followed by the workspace/room count or names;
- **Otium mirror**: hidden internal topic, never shown in normal topic pickers.

“Shared” must not imply that every Otium workspace can access the topic. Access is limited to the
enrolled node's workspace and explicit room bindings.

### Share, bind, unbind, and privatize

These are distinct domain operations even when a convenience UI combines them:

- **Share** changes `accessMode` from private to shared.
- **Bind** connects one Otium room to an already shared local topic.
- **Unbind** removes one room connection without changing shared eligibility.
- **Make local/private** removes every Otium binding and changes `accessMode` to private.

All changes require a topic owner. A share flow should preview the workspace and room receiving
future messages. Making a topic private warns that Otium may retain data already delivered.

The service layer should expose these operations independently. Channel adapters must call that
service rather than editing topic or binding rows directly.

### Surface behavior

#### Negotium CLI

`negotium topics` continues to show access mode and adds binding count. Structured output supports
automation without parsing presentation text.

```text
Product Design  codex/gpt-5.6  [shared,otium:1]  <topic-id>
Personal Notes  claude/sonnet  [private]         <topic-id>
```

Planned commands:

```text
negotium topic status <topic-id-or-name> [--json]
negotium otium bindings [--topic <topic>] [--json]
negotium otium share <topic> [--room <room>]
negotium otium bind <topic> --room <room>
negotium otium unbind <topic> --room <room>
negotium otium private <topic>
```

The current low-level host-node/host-topic form can remain for diagnostics, but ordinary commands
should resolve human-readable workspace and room identities through Central.

#### Terminal

The topic picker and active-topic header display one persistent status label:

```text
Personal Notes   claude/sonnet   Local
Research         codex/luna      Shared · not connected
Product Design   codex/terra     Otium · 2 rooms
```

Topic details show workspace, rooms, node connection health, and last successful projection. Share
and privatize actions require confirmation; status is not represented by color alone.

#### Telegram

`/topics` and `/status` include textual access and connection state:

```text
[Local] Personal Notes
[Shared, not connected] Research
[Otium, 1 room] Product Design
```

Telegram may load private and shared visible topics because it is a local trusted adapter. It may not
list hidden Otium mirrors. A future `/share` command must authenticate the local owner, preview the
destination, and require confirmation. It should not silently choose an Otium room.

#### Otium

Otium shows the source node and local topic for a projected room, including disconnected, suspended,
or access-revoked state. It must stop accepting new work immediately after Negotium makes the topic
private. A room may retain historical messages with a visible “source access removed” status.

## Failure and privacy behavior

- Enrollment and peer authentication fail closed when Central verification is unavailable.
- Making a topic private is a local authorization change and must succeed even when Otium is offline;
  binding removal is durable locally and remote reconciliation can follow.
- Outbound delivery retries are idempotent and ordered. UI status distinguishes queued, delivered,
  failed, and access-revoked states.
- Invite tokens, bearer credentials, private keys, message bodies, attachment paths, and signed
  challenge material are redacted from structured logs.
- Output and uploaded files remain scoped to topic and user authorization. An Otium file bridge must
  independently verify binding and shared access before resolving a file ID.
- Symlink, traversal, redirect, MIME, and size validation occurs at each trust boundary, not only in
  the originating adapter.

## Delivery plan

### Phase 1: make sharing state legible

- Add a core-owned, adapter-neutral persistent read model for external topic bindings. Otium writes
  its workspace/room/status summary through a public core service while retaining protocol-specific
  request journals in the adapter. This must be persistent rather than an in-memory provider because
  Terminal, Telegram, and Otium run in separate processes.
- Define reconciliation between the generic binding read model and Otium's operational binding rows
  so a crash cannot leave a permanently false “connected” label.
- Label Local, Shared/unbound, and Otium-connected states in Terminal, Telegram, and CLI.
- Add JSON status output and tests ensuring private and hidden topic details do not leak.
- Split the service operations for share, bind, unbind, and privatize while keeping compatible CLI
  aliases.

Acceptance: the same topic reports the same access and binding state on every surface, and changing
it to private blocks a concurrent Otium request even if a stale binding exists.

### Phase 2: production one-time enrollment

- Add Central invite records and admin endpoints with hashed tokens, expiry, revoke, and audit.
- Implement preview, atomic claim, lost-response recovery, and local atomic credential persistence.
- Move v0 credential bundles to an explicit development-only path.
- Default to relay/auto; require challenge verification and SSRF defenses for direct endpoints.
- Add status, rotate, and leave commands.
- Make hub discovery explicit in the enrollment result and reject worker activation when the
  workspace has no active hub; Central should normally provision the default hub first.

Acceptance: a two-client race yields exactly one cell; same-key retry recovers it; another key is
rejected; database/log inspection reveals no plaintext invite or long-lived secret.

### Phase 3: key-bound node identity and operations

- Replace or wrap bearer-cell authentication with signed challenges or short-lived certificates bound
  to the enrolled public key.
- Add bounded credential overlap during rotation, suspension, reconnect health, and administrator
  node removal.
- Add a durable projection journal for optional history backfill and clear delivery state.
- Split the Otium workspace-hub responsibility from its optional local execution engine, then remove
  assumptions that every hub can execute AI turns locally.

Acceptance: copying Negotium's non-secret configuration cannot impersonate the node, rotation does
not duplicate events, and suspension stops new peer requests without corrupting local topics.

## Required test matrix

### Enrollment

- expiry, revocation, malformed token, and preview rate limiting;
- two simultaneous claimers and same-key idempotent recovery;
- accepted claim followed by lost HTTP response or local process crash;
- another public key replaying a claimed token;
- transaction rollback between cell creation and workspace assignment;
- atomic local credential write, restrictive permissions, and secret redaction;
- relay reconnect and direct challenge success/failure, including SSRF cases;
- credential rotation, suspension, leave, and key-loss re-enrollment.

### Sharing

- private topics excluded from every Otium discovery and peer operation;
- hidden mirrors excluded from Terminal and Telegram;
- shared/unbound versus shared/bound status on all user surfaces;
- owner-only access changes and destination confirmation;
- privatize racing with turn, ask, abort, file, and visual requests;
- stale binding cannot authorize a private topic;
- unbind preserves shared state; privatize removes all bindings;
- local privatize succeeds while Otium is offline and reconciles later;
- actual hub-worker E2E for messages, tools, files, visuals, aborts, and reconnect deduplication.

## Open decisions

1. Whether the first production enrollment ships directly with key-bound authentication or uses a
   hashed one-time bearer secret as an explicitly transitional step.
2. Whether one local topic may bind to multiple Otium rooms by default or requires an administrator
   policy opt-in.
3. Whether sharing exposes only future activity until a user explicitly requests history backfill.
4. Which operating-system secret stores are required at launch versus mode-0600 file fallback.
5. Whether Terminal and Telegram may create bindings directly or only change eligibility while room
   selection stays in Otium.

Recommended defaults are key-bound identity, relay-first transport, multiple bindings only after
explicit confirmation, future-only projection, and room selection in Otium with a confirmation shown
on the Negotium surface.
