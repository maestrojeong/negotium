# Migration to 0.1.42

Version 0.1.42 hardens browser gateway port allocation and startup ownership checks. No SQLite,
topic, conversation, Vault, Wiki, or browser-profile data migration is required.

## Browser gateway port ownership

Version 0.1.41 could misclassify an occupied browser port as free when the runtime environment
could not execute `lsof`. On macOS this occurred when a PM2 process did not include `/usr/sbin` in
`PATH`. A newly spawned gateway then failed to bind, while its readiness probes could reach a
foreign browser service already listening on that port.

Version 0.1.42 removes `lsof` from browser port allocation:

- Port occupancy is checked with an exclusive `node:net` loopback bind probe.
- Probe errors fail closed and occupied ports are skipped without signalling their owner.
- Stale profile cleanup remains bounded to the exact host-managed browser profile directory.

## Spawn-owned readiness

Each browser gateway spawn now receives a cryptographically random nonce. The gateway returns that
nonce from `/health`, and the manager accepts readiness only when it matches the expected spawn.
An unrelated service cannot satisfy the startup check even if it exposes compatible health and MCP
endpoints.

Startup also races readiness against child-process `error` and `exit` events. The manager drains
and retains the last 8 KiB of child stderr so early bind failures such as `EADDRINUSE` are reported
instead of being hidden behind a generic readiness timeout.

## Upgrade checklist

1. Upgrade direct Negotium dependencies to `0.1.42`.
2. Restart the runtime process that owns browser profiles.
3. Start a browser-enabled turn and confirm the selected gateway port belongs to the new child.
4. When another process occupies the base browser port, confirm Negotium selects the next free port
   without terminating the existing listener.
5. Confirm browser gateway startup failures include bounded stderr diagnostics.
