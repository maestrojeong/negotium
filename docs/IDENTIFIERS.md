# Identifier boundaries

Negotium separates canonical Node identifiers from adapter-local and transport identifiers. The
wire and SQLite representations remain strings; the names below define ownership and lifetime, not
new serialization formats.

## Canonical Node identifiers

| Identifier | Meaning | Minted by |
| --- | --- | --- |
| `userId` | Execution principal on this Node | Host or canonical user store |
| `topicId` | One canonical topic and provider-session owner | Node |
| `messageId` | One message in the canonical transcript | Node |
| `fileId` | One file staged in the Node file store | Node |
| `providerSessionId` | Provider-native continuation state for a topic | Node/provider boundary |
| `surface` | Product partition owning a topic (`terminal`, `telegram`, or `otium`) | Adapter at topic creation |
| `surfaceScope` | Stable namespace inside a surface | Owning adapter |

`surface` and `surfaceScope` are canonical topic properties. A scope is an opaque string to core:
exactly one adapter mints it, it remains stable for the namespace lifetime, and only that adapter may
parse it. Telegram forum groups currently use `tg:<chatId>`; Otium uses a hash of the Central origin
and stable workspace id. Core must not depend on either encoding.

## Turn and correlation identifiers

| Identifier | Meaning |
| --- | --- |
| `clientMessageId` | Caller-minted idempotency key for one external message |
| `requestId` | Durable request/correlation key; defaults to `clientMessageId` on Gateway ingress |
| `queryId` | Wire name for the Node-minted execution `TurnId` |
| `sourceQueryId` / `hostQueryId` | The calling Node's `queryId` while crossing a peer boundary |
| Runtime event `seq` / cursor | Ordered event-log position, not an entity identifier |

The wire name `queryId` is stable. Internal code may brand it as `TurnId`; adapters and stored events
must not rename the field. Likewise, a Gateway `clientMessageId` is persisted as
`MessageDto.sourceMessageId`. The two names describe the same value before and after canonical
message creation.

## Adapter-local and transport identifiers

External room identifiers belong to adapter-local stores. Telegram persists
`(chatId, threadId) <-> topicId`; Otium keeps workspace and cell discovery state in its own files and
tables. Canonical ids may appear in those stores as foreign keys. External ids must not become
canonical topic or message ids.

Transport and authentication identifiers such as Otium `cellId`, `viaCellId`, peer tokens,
`NODE_CONTROL_TOKEN`, and process owner ids identify a route or credential, not a topic. In
particular, `cellId` is reissued on enrollment and must never key durable rooms.

## Ingress invariant

External user turns converge on the Runtime Gateway identity tuple:

```ts
{
  topicId,
  userId,
  actorUserId?,
  actorLabel?,
  vaultUserId?,
  clientMessageId,
  requestId?,
  text,
}
```

The Node creates `messageId`; the durable worker executes the request with
`queryId === requestId`. Replaying the same idempotency keys and payload returns the original
acknowledgement. Reusing a key with another payload is a conflict.

Adapter shutdown, relay reconnects, and HTTP retries must therefore resend the same
`clientMessageId` rather than minting a fresh key.

Terminal mints a fresh `terminal:<uuid>` key for each composer submission. Its remote client retries
an ambiguous Gateway submission once with that same key; its embedded client calls the same durable
application boundary in process. Telegram derives its key from the stable Bot API message id; an
album flush combines its media-group id with that batch's first Bot message id, so an exact
redelivery deduplicates while a genuinely late split batch remains distinct. Otium supplies the host
message id.

## Adapter SDK boundary

Each adapter persists the external binding shape it actually needs and resolves it to a canonical
`topicId` before submitting a turn. Core owns no generic external-room mapping table. Shared binding
types remain documentation-only until at least one concrete adapter consumer can enforce them.

See [Adapters](./ADAPTERS.md) for lifecycle and projection behavior, [Surface-scoped
sessions](./SURFACE-SESSION-SEPARATION.md) for the partition design, and [Runtime Gateway
contract](./RUNTIME-GATEWAY-CONTRACT.md) for the loopback wire contract.
