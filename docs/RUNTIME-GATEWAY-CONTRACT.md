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
- `POST /turns` accepts `{ v: 1, topicId, userId, actorUserId?, actorLabel?, vaultUserId?, sourceAdapter?, text, clientMessageId, requestId?, allowAutoContinue?, visualTools?, fileDeliveryTools? }`.
  `userId` is the canonical execution principal. A trusted gateway may preserve the authenticated
  human author separately in `actorUserId`/`actorLabel` and select the topic owner's credential
  namespace with `vaultUserId`.
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
  It returns `202` only after the canonical user message, durable turn request, acknowledgement event,
  and message event have been committed in one SQLite transaction. `cursor` is the exact sequence of
  that turn's `turn_accepted` event. Current nodes also include the canonical `message` in the
  acknowledgement so short-lived clients can render it immediately; clients remain compatible with
  older v1 nodes by reconstructing it from `messageId` and the submitted text.
  Repeating the same `clientMessageId` and `requestId` returns the original acknowledgement with
  `deduplicated: true` with the same message id and cursor; reusing either identifier for another
  turn returns `409`. Messages accepted while a topic turn is active request immediate steering;
  arrivals during provider unwind are retained in order and folded into the next durable batch.
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
