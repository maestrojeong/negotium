# Migration 0.9.0

Negotium 0.9.0 converges Terminal and Telegram user turns on the versioned Runtime Gateway ingress
while preserving the existing surface, topic, transcript, and provider-session model. It also lets
Terminal render an optional title carried by a visualization reference.

## Turn ingress

Terminal and Telegram now submit external user turns with stable `clientMessageId` and `requestId`
values. A retry of the same payload returns the original acknowledgement and canonical `messageId`
instead of creating another message or provider turn. Reusing an identity with a different payload
still returns `409 Conflict`.

- Terminal mints `terminal:<uuid>` for one composer submission. Its remote client retries one
  ambiguous transport, timeout, or 5xx failure with the same identity; the embedded client enters the
  same durable application boundary without HTTP.
- Telegram derives text and single-media identities from the Bot API message id. Album batches add
  the lowest Bot message id in that flush to the media-group id, so reordered redelivery deduplicates
  while a genuinely late split batch remains distinct.
- Telegram registers origin routing before waiting for the Gateway acknowledgement. Early turn
  events therefore remain in the originating chat or forum thread instead of fanning out to every
  mapping.

The legacy Terminal control message route remains available for older clients. New Gateway
acknowledgements additively include the canonical `message`; new clients reconstruct it from the
existing acknowledgement fields when talking to an older v1 node.

## Mixed-version behavior

A new Telegram adapter attached to an older Node recognizes its own Gateway messages from the
`telegram:` source-message namespace, even when that Node records the older
`sourceAdapter: "runtime-gateway"` value. This prevents user-message echo during a rolling upgrade.

Payload hashes remain compatible with existing Gateway submissions. Adapter provenance is stored on
new canonical messages but is deliberately not added to the idempotency hash, and legacy pre-hash
rows do not reject a replay merely because the adapter gained a provenance label.

## Visualization references

The Terminal visualization reference parser accepts the optional `title` field emitted by current
conversation visualizations. Titles are bounded, reject control characters, and are used as the
display label without changing the referenced absolute HTML path or `wide` mode rules.

## Upgrade notes

No database migration is required. Existing `surface`, `surfaceScope`, `topicId`, `messageId`,
transcripts, and provider-native sessions remain unchanged. Upgrade the Node and adapter from the
same release when possible, then restart the resident Node so the new Gateway acknowledgement and
provenance behavior are loaded.
