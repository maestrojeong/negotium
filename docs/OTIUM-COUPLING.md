# Otium hub and Negotium worker coupling

This document is the wire-level authority for `@negotium/adapter-otium`. General runtime behavior is
defined in [Architecture](./ARCHITECTURE.md); topic access and transcript projection are defined in
[Adapters](./ADAPTERS.md).

The protocol described here is version 1. Every JSON peer request includes `v`. A receiver rejects a
non-numeric or newer version with HTTP 400. Peer responses use `{ ok: true, ... }` on success and
`{ ok: false, error: string }` with an appropriate status on failure.

## Roles

| Role | Responsibility |
| --- | --- |
| **Central API** | Workspace and node identity, assignment, peer-token issue and verification |
| **Hub** | Authoritative workspace membership, rooms, user-visible messages, and worker placement |
| **Worker** | Provider execution for rooms placed on that node |
| **Hidden mirror** | Worker-local execution topic for one hub-owned room |
| **Relay** | Optional outbound tunnel for workers that cannot accept inbound connections |

A placed room remains user-visible and authoritative on the hub. The worker owns its provider-native
session and local execution journal. The hub sends a complete execution specification for every turn;
the worker must not replace it with local defaults.

## Identity and discovery

A worker requires all of these values and fails closed when one is missing:

```text
CENTRAL_API_URL
RUNTIME_CELL_ID
RUNTIME_CELL_SECRET
```

Peer calls use short-lived tokens scoped to one workspace, source node, and destination node:

1. The caller requests a token with `POST {central}/peer/token`, authenticated by its runtime-cell
   secret and `{ toCellId }`.
2. The receiver verifies that token with `POST {central}/peer/verify`, authenticated by its own
   runtime-cell secret.
3. Central verifies the token destination and both live workspace assignments.

Node discovery uses `GET {central}/peer/nodes`. Positive discovery and verification results may be
cached briefly, but revoked assignments must converge quickly. Central unavailability fails closed.

Every node-to-node request sends:

```http
authorization: Bearer <peer token>
content-type: application/json
```

Workspace peer tokens authenticate the calling node. For calls from a worker
to the primary hub, session-comm also forwards the current hosted turn as
`sourceQueryId`. The hub accepts the claimed `userId` only when that turn is
active, assigned to the calling cell, and belongs to the user. Primary-origin
calls remain authoritative. Secondary-to-secondary user calls are rejected
until a future central-issued delegation credential can be verified by workers.

The hub-only endpoints below additionally require the verified caller to be the workspace primary.

## Placement and execution

When an owner places a room on a worker, the hub:

1. checks worker readiness and capabilities;
2. resolves agent, model, effort, MCP selection, description, and subagent policy;
3. provisions or updates the worker mirror; and
4. stores the room-to-worker assignment.

The hub must reject placement while a local native session or active turn makes migration unsafe.
Moving a room with worker history requires an explicit session migration design; it is not an implicit
side effect of changing a node ID.

For every user turn, the hub repeats readiness, capability, and provision checks before sending files
and dispatching the turn. This keeps execution configuration authoritative at the point of use.

## Worker HTTP surface

All peer endpoints return structured JSON errors. Peer authentication checks the bearer token with
central; hub-only endpoints also verify primary origin.

| Method and path | Authorization | Contract |
| --- | --- | --- |
| `GET /ready` | none | Required liveness probe; returns `{ ok: true }` |
| `GET /api/v1/peer/capabilities` | peer | Protocol/runtime version, available agents, efforts, and optional MCP names |
| `GET /api/v1/peer/health` | peer | Uptime and bounded CPU, memory, and optional disk metrics |
| `POST /api/v1/peer/provision` | peer + hub | Idempotently create/update a mirror or shared binding |
| `POST /api/v1/peer/turn` | peer + hub | Claim a request ID and accept asynchronous execution |
| `POST /api/v1/peer/abort` | peer + hub | Abort the exact request or the topic-scoped active turn |
| `POST /api/v1/peer/input-file` | peer + hub | Store a bounded attachment and return a worker file ID |
| `POST /api/v1/peer/tell` | peer + hub | Durably claim and enqueue fire-and-forget work |
| `POST /api/v1/peer/ask` | peer + hub | Enqueue an ask and reply to the source node on completion |
| `POST /api/v1/peer/sessions` | peer + hub | Return the caller-visible session list |
| `POST /api/v1/peer/reply` | peer + hub | Settle a cross-node ask callback |

When a placed worker asks a primary-hub topic, the hub records a one-shot callback route while the
source peer turn is active. The eventual reply returns through
`POST /api/v1/peer/ask-callback`; the hub consumes that route and injects the callback into the
canonical source topic. A worker mirror must not start an unbridged local callback turn.

Hub-only convenience routes such as topic placement, event application, bridge endpoints, and node
selection do not belong on the worker.

### Provision

Provision is idempotent by `(hostCellId, hostTopicId)`. A hub-owned room maps to one hidden local
topic. A local shared topic uses an explicit shared binding instead. If the effective agent or model
changes, the worker invalidates incompatible provider-native session state before the next turn.

### Turn idempotency

`POST /api/v1/peer/turn` claims `(hostCellId, requestId)` in durable storage:

- The first valid request starts asynchronous execution and returns `{ ok: true }` immediately.
- Replay of a non-failed request returns success without executing again.
- Replay of a failed request returns conflict with the stored failure.
- Reusing a request ID for another room returns conflict.

If a new human turn supersedes work in the same room, the worker emits one synthetic
`ai_aborted(reason: "superseded")` terminal event for the old request before beginning the new one.

### Tell and ask idempotency

Tell and ask use a durable claim over source node, request ID, kind, and payload hash. Exact replay
returns success with `replayed: true`; a request ID with a different payload is a conflict. An ask
completion posts one reply to the source node. A missing or expired callback may resolve as not found;
it must not execute the ask again.

### Abort

An abort with a request ID succeeds only when that request is still the active turn. Otherwise it
returns not found. A topic-scoped abort is permitted for callers that do not have the request ID. The
authoritative completion signal is the resulting `ai_aborted` event, not the HTTP response alone.

## Worker outbound obligations

The worker calls central for discovery, token issue, and inbound-token verification. It also posts
ordered events to the hub:

```text
POST {hub}/api/v1/peer/event
{ v, requestId, seq, event }
```

Sequence numbers start at 1 for each request and are contiguous. Sends are serialized: event `n + 1`
waits for event `n` to succeed. A gap blocks later events until the missing sequence is recovered.

Accepted event shapes are the Otium `WsServerMessage` forms used by the hub:

- `message` for the final or intermediate assistant text;
- `message_updated` for supported task/card updates;
- `typing`;
- `tool_call`, `tool_output`, and `tool_status`;
- `file_ready` and `visual`; and
- exactly one of `ai_done`, `ai_error`, or `ai_aborted`.

The final answer text is carried by a `message` event. `ai_done` carries terminal metadata and usage,
not the answer body. A successful stream therefore publishes the final message before `ai_done`.

The worker retries a transient event failure without advancing its sequence. It stops the stream on
a permanent authorization error, unknown request, or an unrecoverable sequence conflict and records a
visible local failure.

## Hub event journal

The hub stores the turn request, last applied sequence, and each event before applying it:

1. Reject an unknown request, wrong worker, or invalid sequence.
2. Claim `(requestId, seq)` as pending.
3. Return success for an already-applied replay.
4. Reject a sequence other than `lastEventSeq + 1` as a gap.
5. Apply the event to hub message and runtime state.
6. Commit the event as applied and advance the cursor atomically.

If application fails, the cursor does not advance and the worker may resend the same sequence. A
terminal event settles the turn once, cancels outstanding cards, resolves ask/subagent callbacks, and
drains queued injections.

On hub restart, queued or running peer turns may be marked failed. A worker receiving not found for a
previously accepted request stops forwarding that request and aborts unnecessary local work.

## Files and bridge operations

Input files are uploaded before turn dispatch and referenced by worker-local file ID. Implementations
must bound size, validate MIME and paths, enforce topic access, and define cleanup after terminal
completion.

Worker turns sometimes need the hub to create subagent rooms or render hub-owned interactive state.
These operations use explicit bridge endpoints. They require the same peer authentication,
idempotency, and request scoping as turn dispatch. Until a bridge is implemented, the worker must
return a visible unsupported response rather than keeping the interaction worker-local and invisible
to the user.

## Relay transport

Direct HTTPS is sufficient when the worker has a reachable base URL. A worker behind NAT may maintain
one outbound WebSocket tunnel to the relay. The relay authenticates the runtime-cell secret, removes
the `/n/{cellId}` prefix, and proxies HTTP frames to the local node.

The tunnel is transport only: it does not change peer authentication, endpoint bodies, idempotency, or
event ordering. Disconnects fail pending requests visibly; reconnect uses bounded exponential backoff.

## Current adapter coverage

| Capability | Status |
| --- | --- |
| Ready, capability, health, and central authentication | Implemented |
| Provision and hidden/shared binding | Implemented |
| Hub execution specification | Implemented |
| Durable turn and tell claims | Implemented |
| Ordered event backflow with bounded retry | Implemented |
| Exact abort, tell, and session listing | Implemented |
| Hub-backed subagent bridge | Implemented |
| Remote ask/reply | Implemented |
| Input/output file and visual bridge | Implemented |
| Hub-backed ask-user and self-configuration | Implemented |
| Worker-origin peer session communication | Implemented |
| Relay client | Implemented; outbound relay protocol v1 tunnel |

Acceptance criteria for these gaps belong in [Feature review](./FEATURE-REVIEW.md), not in this wire
contract.

## Join flow

The product and authorization design for enrollment, including invite lifecycle and topic-sharing
UX, is owned by [Otium enrollment and topic sharing](./OTIUM-ENROLLMENT-AND-SHARING.md). This section
records only the worker-coupling target.

The production target is a one-time node invite created by a workspace administrator:

1. The administrator creates a short-lived, hashed, single-use code.
2. `negotium otium join <code>` claims it with a node name and optional direct base URL.
3. Central creates a runtime cell and worker assignment.
4. The claim returns the cell ID, one-time secret, central URL, relay URL, workspace, and node name.
5. Negotium stores the credential bundle mode 0600 and starts the adapter.

The current direct-URL experiment uses a credential bundle created through central administration. It
is not a one-time invite and must remain development-only. The executable setup and teardown live in
[`scripts/otium-experiment/README.md`](../scripts/otium-experiment/README.md).

## Compatibility risks

- Peer event payloads are tightly coupled to Otium's runtime message schema. Keep serialization golden
  tests and review every protocol-version change.
- Central verification is fail-closed. Central downtime prevents new authenticated peer calls.
- Optional MCP names must use the same canonical identifiers on hub and worker.
- A room with an existing native session cannot move implicitly between nodes.
- Ask-user, files, visuals, and other missing bridges are user-visible gaps and must not be hidden by
  a successful terminal event.
- Automated protocol E2E tests do not prove that every event renders correctly in the Otium client;
  retain a focused manual UI check for release candidates.
