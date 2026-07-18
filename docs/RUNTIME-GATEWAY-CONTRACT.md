# Runtime Gateway Contract v1

Negotium exposes an authenticated, loopback-only contract for an Otium Hub Gateway at
`/api/v1/control/runtime/v1`. It is an ingress and reconciliation boundary over the canonical
topic/message store, RuntimeBus event log, and durable turn worker. It is not a public API.

The node binds `127.0.0.1`; callers must send `Authorization: Bearer <node-control-token>`. The
token is state-directory local and mode `0600`. This is a strong host capability, not an end-user
credential: a holder can read canonical state. A gateway must keep it private and apply its own
identity, workspace authorization, attachment/media handling, REST/WS fanout, and product metadata
before it calls Negotium. Turn submission additionally verifies that `userId` is a participant of
the canonical topic.

## Endpoints

- `GET /health` returns `{ ok, v: 1, capabilities, cursor }` for capability negotiation.
- `POST /turns` accepts `{ v: 1, topicId, userId, text, clientMessageId, requestId?, allowAutoContinue? }`.
  It returns `202` only after the canonical user message, FIFO turn request, acknowledgement event,
  and message event have been committed in one SQLite transaction. `cursor` is the exact sequence of
  that turn's `turn_accepted` event.
  Repeating the same `clientMessageId` and `requestId` returns the original acknowledgement with
  `deduplicated: true` with the same message id and cursor; reusing either identifier for another
  turn returns `409`. Multiple accepted turns for one topic remain FIFO and are not overwritten.
- `GET /events?after=<global-seq>&topicId=<optional>` is an SSE stream. `runtime` events preserve
  the global durable RuntimeBus sequence, `cursor` records advance even when a topic filter omits an
  event, and reconnects resume from `after`. A submitted turn emits `ai-status.kind=turn_accepted`,
  then its canonical `message`, followed by normal `ai_active`, streaming/tool, and terminal events.
- `GET /topics/:topicId` and `GET /topics/:topicId/messages?cursor=&limit=` reconcile canonical state.

`turn_accepted` confirms durable acceptance, not worker placement or successful agent execution.
Existing worker placement, turn leases, RuntimeBus event persistence, and Terminal projections remain
unchanged. Otium-specific JWTs, tenancy, hosted handoff, attachments/media, and UI metadata stay on
the Gateway side of this contract.
