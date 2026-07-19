# Migration to 0.1.18

Version 0.1.18 prepares shared, host-injected runtime boundaries. It is intentionally safe to build,
pack, and consumer-test before publishing.

## CLI cleanup

- Running `negotium` without arguments now starts Terminal; `negotium terminal` remains available.
- The undocumented `start` and `adapters` shortcuts are removed. Run `terminal`, `telegram`, or
  `serve otium` directly.
- The one-shot `chat` command is removed. Use Terminal for local conversations.
- The `otium disconnect` alias is removed; use `otium leave`.
- `negotium -v` and `negotium --version` print the installed version.
- `negotium otium serve` remains available with its existing warning, but is scheduled for removal
  in a future cleanup release. Use `negotium serve otium`.

## Otium upgrade order

1. Publish Negotium only after `bun run lint`, `bun run --filter negotium build`,
   `bun test`, and `bun run release:smoke` pass from a clean checkout.
2. Change Otium's `apps/runtime-api` dependency from `negotium@0.1.17` to `0.1.18` and refresh its
   lockfile.
3. Replace Otium's copied context warning implementation with
   `createContextWarningState`, `nextContextWarning`, `clearContextWarning`, and
   `contextUsageRatio` from `negotium/runtime-helpers`. Pass `supportsCompact: false` while legacy
   Otium supports `/new` only.
4. Replace copied auth, fork, and task-event helpers with `negotium/agent-helpers`. Keep Otium's
   provider policy in its `AgentExecutionHost` callbacks.
5. Replace task, token-stats, system-health, Vault, and Wiki tool registration with
   `negotium/mcp-factories`. Otium must inject its own DB, Vault, wiki root, and topic-brief bridge.
6. Derive common required/optional MCP policy from `negotium/mcp-catalog`, then merge Otium-only
   catalog entries locally.
7. Use `createBackgroundBashManager` from `negotium/background-bash` for the Otium runtime instance;
   do not use Negotium's default singleton wrappers inside the Otium process.
8. Replace copied JSONL helpers with `negotium/runtime-helpers`, outbox processing with a
   host-bound `createOutboxFileOps` from `negotium/outbox`, query ownership with
   `createRoomQueryRegistry` from `negotium/query-runtime`, and Codex process-tree helpers with
   `negotium/agent-helpers`.
9. Construct an Otium-owned `createLifecycleManager({ logger, process })`; do not import the
   standalone Negotium `onShutdown` singleton into the Otium process.
10. Run Otium's focused consumer tests and the overlap audit. Remove a copied file only after its
   wrapper and host integration tests pass.

Do not import paths under `negotium/dist/` or `negotium/runtime/src/`. Only documented package
subpaths are stable.

## Stateful boundary rule

SQLite connections, loggers, configuration, Vault stores, process managers, and lifecycle registries
are host-owned state. Public helpers either remain pure or require an explicit host/instance. A
factory must not configure another host's singleton at module import time. Standalone CLI adapters may
construct default hosts, but those defaults are not the embedding API.

## Verification without publication

`bun run release:smoke` packs the unpublished workspace packages into temporary tarballs, installs
them into a clean temporary consumer, type-checks every public subpath, and executes runtime import
checks. This is the release gate for the changes above; it does not publish to npm.
