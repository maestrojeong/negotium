# Migration 0.10.0

Negotium 0.10.0 is a dependency-only release. It upgrades the bundled agent SDKs to their current
upstream versions; no runtime behavior, API surface, or database schema changes.

## Upgraded dependencies

- `@anthropic-ai/claude-agent-sdk`: `0.3.220` → `0.3.251`
- `@anthropic-ai/sdk`: `0.111.0` → `0.122.0`
- `@openai/codex-sdk`: `0.146.0`/`0.147.0` → `0.151.0`

The Codex SDK bump in particular resolves an upstream `codex_models_manager` cache-schema
incompatibility (`missing field 'base_instructions'`) that could surface when a host's shared
`~/.codex/models_cache.json` was refreshed by a newer Codex CLI than the one a Negotium-embedded
agent process invoked.

## Upgrade notes

No database migration is required. Reinstall dependencies (`bun install`) and restart the resident
Node so agent-facing processes pick up the new SDK builds. Hosts that also run a standalone Codex
CLI or GUI client outside of Negotium's own `node_modules` should upgrade that install too, since it
may share the same on-disk models cache.
