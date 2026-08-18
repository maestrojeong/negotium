# Migration 0.4.9 - transport durability and bounds

`0.4.9` hardens the transports between the Negotium node, Telegram, Terminal, and Otium. No manual
data migration is required; the node and Telegram adapter create the new SQLite tables lazily.

## Changes

- Telegram persists an ordered runtime-event inbox and cursor. AI messages produced while the
  adapter is restarting are replayed with at-least-once delivery semantics.
- Runtime SSE applies the same strict workspace scope rule as REST and no longer exposes legacy
  unscoped topic events to a strict multi-workspace caller.
- SSE queues and catch-up scans are bounded. The runtime event log keeps a soft maximum of 100,000
  events and does not prune events that an active durable consumer has not captured.
- The Otium relay tunnel limits aggregate in-flight HTTP requests, request bodies, bridged sockets,
  pre-open WebSocket buffers, and outbound socket buffering.

## Rollout

Upgrade the `negotium` package and restart the node and Telegram/Otium sidecars. Upgrade
`@negotium/adapter-sdk` to `0.4.9` only in projects that import the public adapter SDK directly.

The first Telegram start after upgrading begins its cursor at the current event tail, preventing old
historical messages from being replayed. Messages produced during subsequent adapter restarts are
captured and delivered after reconnect.
