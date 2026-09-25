# Runtime Gateway Contract v1

Negotium exposes an authenticated, loopback-only contract for short-lived hosts and adapter
sidecars at `/api/v1/control/runtime/v1`. Terminal and Telegram use it locally for idempotent turn
ingress; the Otium adapter can forward a reviewed subset over its peer-authenticated relay. It is an
ingress and reconciliation boundary over the canonical topic/message store, RuntimeBus event log,
and durable turn worker. It is not a public API.

The node binds `127.0.0.1`; callers must send `Authorization: Bearer <node-control-token>`. The
token is state-directory local and mode `0600`. This is a strong host capability, not an end-user
credential: a holder can read canonical state. A gateway must keep it private and apply its own
identity, workspace authorization, attachment/media handling, REST/WS fanout, and product metadata
before it calls Negotium. Turn submission additionally verifies that `userId` is a participant of
the canonical topic.

## Endpoints

- `GET /health` returns `{ ok, v: 1, capabilities, cursor }` for capability negotiation.
- `POST /turns` accepts `{ v: 1, topicId, userId, actorUserId?, actorTopicScope?, remoteSession?, actorLabel?, vaultUserId?, sourceAdapter?, text, clientMessageId, requestId?, allowAutoContinue?, visualTools?, fileDeliveryTools?, hostMcpServers? }`.
  `userId` is the canonical execution principal. A trusted gateway may preserve the authenticated
  human author separately in `actorUserId`/`actorLabel` and select the topic owner's credential
  namespace with `vaultUserId`.
  `actorTopicScope` is `{ visibleNodeTopicIds: string[], ownedNodeTopicIds: string[] }`: the node
  topic ids (on the receiving node) the human author participates in and owns, as the gateway's
  own membership store sees them. It rides the durable turn row and the signed per-turn MCP token,
  so a retried or handed-off turn keeps it and the agent cannot widen it. On the `otium` surface the
  runtime MCP (`list_topics`, `abort_topic`, `restart_topic`, `delete_topic`) and `session-comm`
  (`list_sessions`, `peek_session`, `tell_session`, `ask_session`, `abort_session`) confine
  themselves to the asserted rooms — visible ones for reading and messaging, owned ones for
  abort/restart/delete; a room outside the assertion answers as "not found". A turn without one
  (an older gateway, or a turn no person started) is fail-closed to the current room. A malformed
  assertion is a 400. Like the capability flags it describes the caller, not the message, so it
  is excluded from the idempotency payload hash.
  **The assertion is authoritative.** When a turn carries one, it is the *whole* answer: reachable
  is exactly the current room plus `visibleNodeTopicIds`, owned is exactly `ownedNodeTopicIds`.
  The node adds nothing from its own records — in particular not subagent lineage. A subagent
  room this node spawned for a room is expected to exist on the hub as a mirrored room carrying
  the parent's roster and roles (Otium's `reconcileMirroredSubagentLineage`; the node itself gives
  a subagent its parent's participants and roles verbatim), so a hub whose actor owns the parent
  lists the workers in both arrays and a hub whose actor merely belongs to the parent lists them
  as visible only; a hub that does not mirror them must not expect the node to fill them in. That is what keeps a non-owner member of a shared room from aborting or
  deleting that room's workers, and a person speaking from a worker room from reaching a room an
  ancestor granted the worker but the person cannot see.
  **Lineage without an assertion.** Turns no person started — the subagent's own spawned turn, its
  report back, the parent's follow-up — carry no `actorUserId` and no assertion, and for those the
  node's own lineage stands in: a subagent reaches its direct parent and the rooms an ancestor
  granted it (`grant_subagent_tell`), a room reaches and may abort its own subagent workers, and
  nothing else.
  **Subagent management.** The tools that manage the current room's delegation tree follow the
  same rule as the cross-room tools. On `otium` with an assertion, `list_subagents` shows only
  the descendants in `visibleNodeTopicIds`; `start_subagent`, `delete_subagent` and
  `grant/revoke_subagent_tell` act only on a descendant in `ownedNodeTopicIds`, and a grant's
  target must be the current room or a visible descendant. A descendant outside the assertion
  answers as "not a descendant subagent managed by this room" — the same as an unrelated id —
  whether the person may not see it or merely does not own it. Since a hub mirrors a worker
  with its parent's roster, a person who owns the parent owns the workers and manages them in
  full, and a member who does not owns none of them and can at most list the ones the hub shows.
  `spawn_subagent`/`create_subagent` need no entry in the assertion: they create a child of the
  room the turn is running in, which a participant of that room may always do, and the child
  exists on the hub (and so in later assertions) as the hub mirrors it. Without an assertion
  the tools keep the node's own participant and root-owner checks over the whole tree, which is
  what lets a parent's own follow-up turn manage the workers it spawned.
  **Limits.** Each list holds at most 200 ids (counted before de-duplication), an id is at most
  128 characters after trimming, the normalized assertion is at most 8 KiB of JSON, and the object
  must carry exactly those two keys (any other key, including prototype names, is rejected).
  Anything over is a `400` naming the limit. The same parser enforces the caps on the gateway
  body, the signed tokens and the stdio argv. A hub whose actor is in more rooms than fit must
  trim the assertion (the node then treats the omitted rooms as not visible) — the node rejects an
  over-cap assertion rather than trimming it for the hub, because narrowing what a person may
  reach belongs to whoever owns the membership store. A trimming hub must keep
  `ownedNodeTopicIds ⊆ visibleNodeTopicIds` and should keep the room the turn runs in; the byte
  cap counts both lists, so an owned room costs its id twice.
  The caps are sized to the transport, not the store: the assertion rides the signed per-turn
  token in the MCP URL query, and the node's HTTP server refuses an over-long request line (Bun
  1.3.14: a 16,205-character URL is served, 16,305 answers 431). The assertion cap alone does not
  bound that URL, so the node bounds the whole of it. The token carries no free text: the user's
  message (`text` on `/turns`, unbounded) goes to the transcript and the durable turn row, and
  the only thing the runtime tools ever needed it for — `set_agent`'s rule that a backend switch
  must be asked for in the current message — is decided on the node from the full text when the
  token is minted and signed into it as `explicitAgentSwitchTargets`, the list of agents the
  message explicitly asked to switch to (at most three names). An earlier revision put a 1 KiB
  head of the prompt in the token, which refused a switch phrased after the cut; the derived
  field does not depend on where in the message the request is. Every built-in MCP URL is
  checked against a 14 KiB (14,336-character) budget when it is minted. Measured with UUID ids:
  the maximal assertion (8,159 bytes, 208 ids) plus every other runtime-token field at its
  largest gives a 12,052–12,055-character URL; the hosted tokens with the same assertion and
  every optional field are marginally larger, not smaller — `session-comm` ~12,118 characters,
  the other hosted surfaces 12,100–12,109 — since the surface name and lifecycle fields outweigh
  the runtime token's switch-target list. All stay ≥ 2,200 characters under budget. Over budget the node refuses to mint the token and the turn's MCP
  setup fails with a logged error; nothing is dropped or trimmed to make a token fit. On the
  stdio transport the assertion alone is one argv entry of at most 10,924 base64url characters,
  far below any platform argv limit, and the encoder re-validates it against the same caps and
  throws on anything over — an in-process caller cannot put an unbounded object into argv.
  `set_agent` is not offered on the `otium` surface at all (the hub owns provider routing); the
  derived field matters on Terminal and Telegram rooms, where it is the whole authorization.
  **Targets.** On `otium` the room the turn is running in, manager (General) rooms and rooms whose
  AI is off are never targets: `list_topics`/`list_sessions`/`peek_session` leave them out and a
  direct reference to an AI-off room is "not found", whatever the assertion says. The current
  room and the caller's own General still resolve for abort/restart/delete so those tools can
  refuse them precisely ("cannot abort the current topic", "manager rooms are system-managed").
  DM rooms are not node topics and must not appear in an assertion.
  **Queueing.** Pending requests of one room fold into a single turn only when they come from the
  same `actorUserId` (and thread); another person's message ends the run and queues as its own
  turn, in arrival order, with its own actor and assertion. When one actor's requests fold, the
  batch runs with the *intersection* of their assertions, and with none if any of them had none.
  The same rule decides steering: a message from the person whose turn is currently running
  aborts that turn and resumes it as the merged batch (as before); a message from anyone else
  does **not** abort the running turn — it is queued behind it and runs afterwards as its own turn.
  A running turn whose actor was never recorded (a turn the node started for itself, or a row
  older than the field) is treated as another person's: it is never aborted or merged into.
  **Remote sessions.** The peer bridge (`node/topic` addressing) carries the execution principal
  only, never the actor or an assertion, so on `otium` remote session-comm is fail-closed unless
  the turn carries a **`remoteSession` grant** from the hub: without one, remote rooms are not
  listed and remote `tell_session`/`ask_session`/`abort_session` refuse with an explicit error.
  Terminal and Telegram rooms keep the existing peer behaviour.
  `remoteSession` is `{ hubUrl, capability }`: `hubUrl` a loopback `http://` or any `https://`
  origin (≤ 512 chars, no credentials/query/fragment; persisted without a trailing slash) and
  `capability` an opaque `rsc1.<payload>.<hmac>` bearer (≤ 2 KiB accepted; the hub refuses to
  mint above 1 KiB) that only the hub can verify — the node holds no key and never verifies it.
  The node does base64-decode the payload's `e` (expiry) for one purpose only: ordering grants
  when several requests fold into one turn; that value is untrusted and takes part in no
  security decision. Anything else is a 400; absent means no grant.
  With a grant, the remote branches of `session-comm` call the hub
  (`POST {hubUrl}/api/v1/session-comm/remote/{sessions,peek,tell,ask,abort}`, `Authorization:
  Bearer <capability>`, no actor id in the body, `redirect: "error"` — a bearer is never
  forwarded to a redirect target) and the hub re-checks the person's membership of the origin and
  target rooms on every call; the adapter peer bridge is never used on `otium`. A 2xx is only a
  success when it carries the exact v1 envelope (`ok: true`, `v: 1`, and the operation's fields,
  parsed field by field — for a listing every node entry carries exactly one of `sessions` or
  `error`, and on `/peek` every room carries a `status`, since that is the whole answer a peek
  gives); any other 2xx body is a protocol failure treated like a transport failure (retried, then
  reported as unconfirmed), and `{ code: "in_progress" }` (the hub is still delivering the
  same `requestId`) is retried the same way. That verdict is read off the `code`, not the status:
  the contract's status for it is `409`, but a hub that relays a target node's `409 in_progress`
  as its own `502` while keeping the code is still saying "in flight", and reading it as a final
  `502` is what drops a pending ask the late reply still needs. A transport failure once the
  request has been sent is *uncertain* unless the socket error proves the connection was never
  established (`ECONNREFUSED`, DNS, TLS handshake): a bare `fetch failed` after the bytes left is
  indistinguishable from one before, so the node keeps its pending ask and reports a `tell` as
  unconfirmed instead of deleting state a late reply needs. A target on the origin's own node is refused by the
  hub with 400 (`same_node`): such rooms are local sessions.
  Like the assertion, the grant rides the durable turn row and the signed `session-comm` MCP token
  (no other token), is outside the idempotency hash, and merges fail-closed: a batch keeps a grant
  only when every folded request carries one for the same hub (the latest-expiring wins).
  Cron, self-schedule and subagent-lineage turns never carry one. Measured with the maximal
  assertion the hub's real grant adds ≈680 URL characters (12,800 of the 14,336 budget); the hard
  budget check refuses a mint that does not fit rather than dropping a field. Full contract:
  `cross-node-interface.md` (node ↔ hub), summarized below.
  **Remote session-comm inbox.** `POST /topics/:id/session-comm/inbox` (`{ v: 1, userId, kind:
  "tell" | "ask" | "abort" | "ask-reply", requestId, ... }`) is how the hub delivers a remote
  `tell`/`ask`/`abort` into a room on this node, or the `ask-reply` answering an ask this room
  raised. Same authentication and workspace check as `/turns`; `userId` must be a participant.
  `tell` carries `from: { label, hubTopicId? }`, `message` (≤ 10,000 chars, else 413) and `depth`
  (≤ `MAX_TELL_DEPTH`, else 400); `ask` adds `fromDepth` and a `remoteReply`
  `{ via: "hub", hubUrl, token: "rsr1.…", nodeName, topicId, requestId }` the node uses to post
  the answer back to `{hubUrl}/api/v1/session-comm/remote/reply` (`Bearer <token>`) from a
  durable outbox (immediate attempt, then 5/10/20/30 s jittered backoff, 15 min TTL, works
  without an adapter). `remoteReply.hubUrl` obeys exactly the grant's `hubUrl` rule (https, or
  loopback http; no credentials/query/fragment; ≤ 512 chars) and `token` must be shaped like an
  `rsr1` token (≤ 2 KiB), else the entry is a 400. `ask-reply` carries `fromLabel`, `replyKind:
  "reply" | "error"`, `replyText`. Every delivery is claimed by `requestId`
  (`remote_session_inbox_claims`, a `processing → completed` state machine with a 60 s lease):
  the same payload again answers `200 { replayed: true }` only once the claim is `completed`
  (tell/ask/abort: in the same transaction as the enqueue; `ask-reply`: in the same transaction
  as the caller-room record and the consumption of the durable ask), a duplicate that meets a
  live `processing` claim answers `409 { code: "in_progress" }` (retry later, never a false
  replay), a `processing` claim whose lease expired is re-run by the node's maintenance pass and
  at startup, and a different payload is `409`. A room with no AI answers `409` to tell/ask
  whatever the hub's mirror said; an `ask-reply` nobody is waiting for is `404`. Versioning on
  this route is scoped, and a client must classify accordingly: the `202`/`200` acknowledgement
  and every error the inbox handler itself produces (validation, claim, delivery — the `400`s,
  the `409`s, the handler's `404`/`413`) carry `v: 1` (`{ ok: false, v: 1, error, code? }`), but
  errors from the layers in front of the handler do not. Authentication and method dispatch
  (`401`/`403`, the `404` for an unknown route or a method mismatch), the request-size cap
  (`413`), the Otium relay and sidecar (`4xx`/`5xx`, sometimes an HTML page or an empty body),
  and any proxy in between answer **versionless** and possibly non-JSON. So a hub must key every
  non-2xx on the HTTP status plus the optional `code` field and must never require `v` (or `ok`)
  to read one: `401`/`403` is an authentication failure (its body belongs to whatever rejected
  the call, so it is not relayed onward), `404` is an unknown target, `409` with
  `code: "in_progress"` is retryable, `413` is too large, and `5xx`/transport is uncertain and
  retried. A hub must in turn accept a `2xx` only
  as the exact envelope (`ok: true`, `v: 1`, `accepted: true`, the `requestId` it sent, and a
  boolean `replayed`); any other `2xx` is a protocol failure, never a delivery. Nodes
  advertise `remote-session-comm` (route and `remoteSession` supported) and, when the Otium
  adapter forwards the route over its relay, `remote-session-comm-relay`; a hub must see the
  former before attaching a grant and the latter before routing a delivery to a worker.
  `visualTools` and `fileDeliveryTools` are capabilities minted by the gateway and are
  **default-deny**: unless the gateway sends `true`, the turn's runtime MCP omits `show_html`,
  `show_mermaid`, `show_image`, `publish_html`, and the file-delivery tools. A gateway
  should grant them only if it actually renders a visual panel and a chat file surface, because the
  node has no other way to know whether that output would be displayed or dropped. They describe the
  caller, not the message, so they are excluded from the idempotency payload hash.
  `publish_html`/`unpublish_html` need `visualTools` *and* a snippet backend on the node
  (`NEGOTIUM_SNIPPETS_API_URL`), which the capability cannot supply because it is the node's own
  configuration. A node without one grants the visual tools and omits the publish tools, logging a
  warning when it does. Configure the backend on every node behind a gateway that has one, or the
  same room offers different tools depending on which host ran the turn.
  `hostMcpServers` grants remote `{ type: "sse" | "http", url, headers?, timeout? }` MCP servers
  to manager-topic turns. The field is optional and omission preserves the existing topic grant;
  `{}` revokes it. Non-manager topics, process transports, non-HTTP(S) URLs, unknown spec keys, and
  names owned by the node are rejected. Nodes advertise `host-mcp-turn-injection` before a host may
  rely on the field. Credentials stay in the dedicated `api_topic_host_mcp_grants` table and are
  resolved only into normal manager executions, never cron, forum, subagent, signed runtime context,
  or durable turn payloads. Codex supports the `http` transport; its provider ignores SSE entries.
  It returns `202` only after the canonical user message, durable turn request, acknowledgement event,
  and message event have been committed in one SQLite transaction. `cursor` is the exact sequence of
  that turn's `turn_accepted` event. Current nodes also include the canonical `message` in the
  acknowledgement so short-lived clients can render it immediately; clients remain compatible with
  older v1 nodes by reconstructing it from `messageId` and the submitted text.
  Repeating the same `clientMessageId` and `requestId` returns the original acknowledgement with
  `deduplicated: true` with the same message id and cursor; reusing either identifier for another
  turn returns `409`. A message accepted while a topic turn is active requests immediate steering
  only when it comes from the actor whose turn is running (same `actorUserId`; see **Queueing**
  above): that turn is aborted and resumed as the merged batch, and arrivals during provider unwind
  are retained in order and folded into the next durable batch. A message from a different actor —
  or one arriving while a turn with no recorded actor runs — never aborts the running turn; it is
  queued as its own entry and runs after that turn finishes, with its own actor and assertion.
- `GET /topics/<id>/visuals/<vizId>` returns `{ ok, v: 1, visual }` for a visual a turn rendered on
  this node: `{ id, kind, title, html, source, fileId, mimeType, createdAt }`. A turn in a mapped
  room runs here, so `show_html` and friends write to *this* node's visual store and the URL on the
  `visual` runtime event names a topic id only this node knows. A gateway that owns the room but not
  the execution has nothing to serve its panel from, so it copies the visual into its own store on
  receipt. Copying rather than proxying keeps panels working when the node is offline and leaves the
  gateway's own access control in charge. `fileId` names a file in this node's store; a copying
  gateway has to fetch those bytes and re-upload them under an id of its own.
- `GET /topics/<id>/files/<fileId>?user=<userId>` returns the bytes of a file this node holds for
  that room. The contract could previously upload *to* a node but never read back, so both the media
  behind a `show_image` visual and a file the agent delivered to the chat were
  unreachable from the gateway. Addressed through the owning room on purpose: every mapped room
  executes as the same `local` principal, so a file ACL keyed on the caller's user id authorizes
  nothing across workspaces. Routing through the topic puts the read behind the same
  `topicInRequestScope` check as every other topic-scoped route (M-8), and the file must belong to
  the room named in the path.
- `GET /events?after=<global-seq>&topicId=<optional>` is an SSE stream. `runtime` events preserve
  the global durable RuntimeBus sequence, `cursor` records advance even when a topic filter omits an
  event, and reconnects resume from `after`. A submitted turn emits `ai-status.kind=turn_accepted`,
  then its canonical `message`, followed by normal `ai_active`, streaming/tool, and terminal events.
  Strict workspace forwarding applies the same scope rule as topic REST routes. Per-connection
  buffering and catch-up scans are bounded, so clients must continue reading and reconnect from the
  last received cursor after a disconnect. The initial `ready` event includes `oldestCursor` and
  `truncated`; a client receiving `truncated: true` must reconcile canonical topic/message state.
- `GET /topics/:topicId` and `GET /topics/:topicId/messages?cursor=&limit=` reconcile canonical state.

`turn_accepted` confirms durable acceptance, not worker placement or successful agent execution.
Existing worker placement, turn leases, RuntimeBus event persistence, and Terminal projections remain
unchanged. Otium-specific JWTs, tenancy, hosted handoff, attachments/media, and UI metadata stay on
the Gateway side of this contract.

The RuntimeBus log keeps a soft maximum of 100,000 events. Active durable consumers heartbeat the
highest sequence they have captured; pruning never crosses the minimum active cursor. Inactive
consumers must reconcile canonical topic/message state if their cursor predates the retained log.

## Topic link v2 (create claims, existence, tombstones, surface scope)

Additive; advertised as `canonical-topic-create-claims`, `canonical-topic-existence`,
`canonical-topic-tombstones` and `canonical-surface-scope`. A host sending none of the new fields
sees the previous behaviour byte for byte.

- **Create claims.** `POST /topics` and `POST /topics/:id/derive` accept optional `requestId` (1-200
  chars) and `payloadHash`. The node keys a claim on `(caller principal, requestId)` and its own
  sha256 of the canonical JSON (keys sorted at every depth, compact, `undefined` dropped) of the body
  minus `requestId`/`payloadHash` — for derive, of `{ sourceTopicId: <path id>, ...body }`. The
  principal is `loopback` (no `x-negotium-surface-scope`) or `scope:<value>`; it is never read from
  the body. The claim is written in the topic's own SQLite transaction, before `topic-created` is
  broadcast. Answers: first create `201 { topic, requestId, payloadHash, replayed: false }`; the same
  key and hash again `201 … replayed: true` with the same topic; another hash `409
  request_id_conflict`; an aborted key `409 request_aborted`; a claimed topic since deleted `410
  claim_topic_gone`; a key still being processed `409 request_in_progress`. Topic DTOs from
  `GET /topics` and `GET /topics/:id` carry `hostCreate: { requestId, op, createdAt }` for rooms the
  same principal created.
- **Claim recovery.** `GET /topic-claims/:requestId` → `{ state: "none" | "committed" | "aborted",
  op?, topicId?, topicPresent? }` (always 200). `POST /topic-claims/:requestId/abort` deletes the
  claimed room only while it holds no message written after creation (`409
  claim_topic_has_messages` otherwise) and fences the id so a late create is refused; an abort for
  an unknown id records the fence. The abort decides the claim's state and writes its outcome in one
  `BEGIN IMMEDIATE` transaction, so a create committing concurrently in another process is either
  refused by the fence or deleted by the abort — a committed claim is never aborted while its room
  lives. While an abort deletes a room, every message insert into it is refused by SQLite and
  `POST /turns` for it answers `409 topic_unavailable`; the "no new message" check is repeated inside
  the transaction that deletes the messages, so a message that still lands keeps the room (`409
  claim_topic_has_messages`, claim stays committed). The loser of a cross-process race on the same
  key (create or derive) gets the winner's `201 … replayed: true`.
- **Claim binding (review round 2).** `requestId` is used exactly as sent: 1-200 characters, and a
  leading/trailing space is `400 invalid_request_id` (never trimmed). A claimed derive is bound to the
  PATH source: the hash input is `{ ...body, sourceTopicId: <path id> }`, a body `sourceTopicId` that
  differs from the path is `400 source_topic_mismatch`, the claim records its source (a replay on
  another parent is `409 request_id_conflict`), and a derive replay is only answered after the normal
  source-access check (a gone/inaccessible source is 404). A replay or abort whose room is no longer
  filed under the caller's workspace is `409 claim_topic_moved` (no DTO, nothing deleted);
  `GET /topic-claims/:id` then reads `topicPresent: false, topicMoved: true`. An abort deletes only a
  room whose message set is exactly the one it was created with (count + hash of ids recorded with
  the claim). Claim retention: committed claims 30 days from `created_at`, aborted claims (fences)
  30 days from the moment they became aborted (`settled_at`); pruning is bounded per request.
- **Otium scope immutability.** An otium room's `surface_scope` never changes after creation (SQLite
  trigger `api_topics_otium_scope_immutable`; upserts keep the stored value). The only exception is the
  audited, storage-only `adminRepairOtiumTopicScope` (`NULL → scope`, CAS), which the one-time M-9
  stamp also uses. Create claims are never re-bound: they stay on their original principal and a
  replay/abort by a principal the room's current scope no longer belongs to is `409
  claim_topic_moved`. The move is recorded in `api_topic_scope_moves` with a seq from the tombstone
  counter and appears in `GET /topic-tombstones` as `reason: "unshared", scopeMoved: true` for the OLD
  scope (not shown to callers that still see the room); existence answers the old scope `present,
  shared: false`. Refusals (nothing changes): `invalid_scope | not_found | not_otium |
  scope_not_null | row_changed | title_conflict | duplicate_manager | maintenance_in_progress`.
- **Repair title rule (revision 6).** The repair uses the same title rule as room creation
  (`findTopicTitleConflict`): manager rooms — every member's personal "General" — take no part in
  title conflicts, neither as the room being moved nor as a room already in the target scope (the
  reserved shared `general` row is still a peer of a regular room titled "General"). Regular rooms
  still refuse `title_conflict` against a same-titled (trimmed, case-insensitive) regular room in
  the target scope. Instead, moving a manager room is refused with `duplicate_manager` (`detail`:
  the existing room's id) when the target scope already holds a manager room with an owner in common
  with it, so no caller can give one owner two manager rooms in one workspace. The M-9 stamp uses the
  same check and keeps a `duplicate_manager` room pending like a title conflict.
- **Existence.** `GET /topics/:id/existence` → `{ nodeId, topicId, state: "present" | "gone" |
  "unknown", shared?, deletedAt? }`. `gone` only when this store holds a deletion tombstone stamped
  with the identity answering now and within the caller's scope; a topic the node simply does not
  have is `unknown`, never `gone`.
- **Tombstones.** SQLite triggers on `api_topics` write `api_topic_tombstones` (`deleted`, or
  `unshared` when a room leaves the visible Otium surface) in the same statement as the change,
  stamped with the node identity. `GET /topic-tombstones?after=&limit=` pages them by `seq`, which
  comes from a never-decreasing counter (`highWater` on the page is its current value): every
  tombstone written after a cursor has a larger `seq`. A topic can appear more than once (unshared,
  later deleted); consumers must be idempotent. The `ready` event of `GET /events` and every
  `topic-deleted` payload carry `nodeId`.
- **Store epoch.** `/health`, `/surface-scope`, existence, tombstone and claim responses carry
  `dbEpoch`, a random id minted when the store first recorded an identity. A wiped/recreated store
  under the same `NODE_ID` has another one; a restore of a backup of the same store does not (a hub
  can only notice that as `highWater` below its recorded cursor).
- **Surface scope.** `GET /surface-scope` → `{ nodeId, principal, surfaceScope, resolved,
  scopeRequired, joinsMounted, linkGuard, unscopedPending }`: the workspace this caller's rooms are
  filed under. `unscopedPending` (additive, revision 5) counts pre-existing otium rooms the one-time
  M-9 stamp has not filed yet; non-zero means that migration is incomplete and still retrying.
- **M-9 stamp completion (revision 5).** The stamp that files pre-existing unscoped otium rooms under
  the first resolved workspace records itself complete only when no room was skipped. A room refused
  for a retryable reason (live maintenance, title conflict, duplicate manager room, row changed) is
  kept in `api_surface_scope_stamp_pending` with the scope of the first attempt; retries touch only those
  rooms, always under that pinned scope (never a newly joined workspace), and run on scope
  resolution, when a pending room's maintenance fence is released in-process, and on a 30-second
  timer (unforced retries are rate-limited to one per 30 s per process). Each incomplete attempt
  logs a warning with the pending topic ids. A permanent title conflict (or duplicate manager room)
  keeps the migration open until an operator renames or resolves the room (or repairs it with
  `adminRepairOtiumTopicScope`).
- **Create guard.** `NEGOTIUM_OTIUM_LINK_V2` (default off) applies to the three gateway room creators.
  `on`: callers declaring `x-otium-link-protocol: 2` get `409 scope_unresolved` when the scope is
  not resolved (create and manager-topic) and `409 scope_mismatch` when an
  `x-otium-link-expected-scope` header differs from it; callers without the header are unaffected.
  `strict`: additionally `409 link_protocol_required` for callers without protocol 2. A replay of a
  committed claim is answered before the guard.

## Known limitations

- **Remote-session authority is the hub's, per call.** Unlike the assertion, the remote-session
  grant is re-checked by the hub on every remote call (membership, revocation on the turn's
  terminal event, a 4 h ceiling), so a membership change reaches a running turn's *remote*
  branches at once. What the node cannot do is start such a turn on its own: cron, self-schedule
  and subagent turns carry no grant and stay fail-closed. A grant whose `hubUrl` is unreachable
  degrades to one "(hub unreachable)" line in the remote listing and an error on remote
  tell/ask/abort; local tools are unaffected. A `tell`/`ask` whose hub response never arrived
  after the request left is reported as "sent, delivery unconfirmed" rather than retried under a
  new id, so a duplicate is never invited.
  A host that revokes on the terminal event can rely on one turn meaning one `queryId`: the
  node's own internal retries (a provider session expiry, one retry after a zero-content
  response) emit **no** terminal event and continue under the *same* `queryId`, so the grant
  stays valid across them and still ends exactly once when the turn really finishes. A host must
  therefore not treat "no event for a while" as the end of a turn, and must not mint a second
  grant for a turn it already submitted: a duplicate submission is answered
  `deduplicated: true` and any capability minted for that replay has no turn to end it. The hub's per-actor rate limit (60 calls/min) is a
  process-local sliding window on the hub (accepted: a hub restart resets it; the per-turn
  capability counter is persisted).
- **Revocation is not instant.** The actor room assertion is captured when a turn is accepted
  and travels with the durable request and the signed MCP token (TTL 4 h). A membership change
  the hub learns of afterwards does not reach a turn that is already queued or running, and a
  replay of the same `clientMessageId` with a narrower assertion is acknowledged as a duplicate
  while the stored assertion stays as first accepted (the assertion is outside the idempotency
  hash). Aborting the turn is the only way to cut it short. Tightening this — per-tool-call
  re-validation against the hub, or shorter token TTLs — is deliberately deferred.
