# Migration to 0.1.19

Version 0.1.19 makes topic reset memory-safe and expands the public runtime boundary used by
embedding hosts.

## Topic reset

Every Negotium reset surface now enters the shared `restartTopicSession` service. Before provider
rollouts and the unified conversation are purged, the service fences queued and active work, cancels
the idle timer, archives the unarchived conversation tail, and launches the memory archiver. Reset
archiving runs even when idle archiving is disabled and shares its cursor, so a recent idle archive is
not duplicated.

Active-topic snapshots use a durable SQLite job claim shared by runtime processes. The conversation
cursor advances only after the memory turn succeeds; synchronous launch failures and background turn
failures leave the archive pending for retry. Archive files are created exclusively, so concurrent
resets cannot overwrite one another. Reset snapshots also accept short 1–3 message sessions even
though deleted-topic distillation retains its existing four-message quality threshold.

Embedding hosts should preserve the same order: stop and await the active turn, archive the reset
tail, purge provider context, then clear the session id. A reset must return a retryable error if the
active turn cannot stop before the timeout; purging underneath a live turn can lose or recreate
context.

## Public consumer boundary

The following are available from documented package subpaths in 0.1.19:

- `archiveActiveTopicForMemory` and `ActiveTopicArchiveOptions` from `negotium/agent-helpers`;
- canonical visual tool definitions, including the legacy `show_png` alias, from
  `negotium/agent-helpers`;
- query outcomes and parameter types from `negotium/query-runtime`;
- agent/runtime types, effort values, and `connectStdio` from `negotium/runtime-helpers`.

These are direct same-process imports. They add no IPC, serialization, subprocess, or dynamic-import
step to the request path.

## Otium upgrade order

1. Publish and smoke-test Negotium 0.1.19.
2. Upgrade Otium's `apps/runtime-api` dependency and lockfile to `negotium@0.1.19`.
3. Replace Otium's copied `types.ts`, `query/types.ts`, visual definitions, and active-topic archive
   algorithm with thin imports from the public subpaths. Keep Otium-owned WebSocket, database,
   logging, and Gateway policy in host adapters.
4. Run Otium's complete typecheck and tests, then enforce the overlap caps documented in the package
   README. Do not move host-owned singleton state into Negotium merely to lower a similarity metric.

## Verification without publication

`bun run release:smoke` packs the workspace into temporary tarballs and validates the public exports
from a clean consumer. It does not publish packages.
