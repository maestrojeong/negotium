# Migration 0.13.0

Negotium 0.13.0 adds support for the newest Codex and Claude flagship models and upgrades the
provider SDKs so their bundled executables actually accept the new model IDs.

## New models

- **`gpt-6-astra`** (Codex, released 2026-09-03) is now selectable and becomes the new top-tier
  Codex route. It costs $10/M uncached input, $1/M cached input, $12.50/M cache write, and $50/M
  output — matching Claude Fable 5.1's headline pricing. `gpt-5.6-sol` is demoted from the fable
  tier to the opus tier; it remains selectable and unchanged in price.
- The `fable` alias now resolves to **`claude-fable-5-1`** (Claude, released 2026-09-01) instead of
  `claude-fable-5`. Fable 5.1 keeps the same input/output pricing but cuts cache-read pricing 75%
  (from $1/M to $0.25/M).

Both models were added to `MODEL_OWNER`, the `/model` picker's `SELECTABLE_MODELS`, cost estimation
in `token-stats.ts`, and Codex's explicit-agent-switch aliases.

## SDK upgrades

- `@openai/codex-sdk` → 0.153.4 (bundles the Codex CLI build that recognizes `gpt-6-astra`)
- `@anthropic-ai/sdk` → 0.124.0
- `@anthropic-ai/claude-agent-sdk` → 0.3.261 (bundles the Claude Code build that recognizes
  `claude-fable-5-1`)

Older bundled executables reject these model IDs outright, so the SDK bump is required, not
optional, for the new models to work.

## Unchanged behavior

- `zod` stays pinned at exactly `4.4.3` to match the version `@modelcontextprotocol/sdk` bundles
  internally; a looser range resolves a newer `zod` and breaks MCP tool-schema types across two
  separate module instances.
- `typescript` stays on 5.x. TypeScript 7 removes the `baseUrl` compiler option, which every
  workspace package's `@/*` path alias currently depends on; Bun 1.2.15's own bundler/test runner
  does not yet resolve `paths` without `baseUrl`, so upgrading breaks `bun test` at runtime even
  though `tsc` itself is satisfied. Moving those aliases to package.json `imports` subpaths (as
  `packages/core` already does) would unblock this, but touches every workspace package and is
  out of scope here.
- `node-telegram-bot-api` stays on 1.x. Its 2.x release is an intentional from-scratch rewrite
  ("no v1 compatibility") with a different import surface and middleware-based API; adopting it
  needs a dedicated migration of the Telegram adapter.
- `@biomejs/biome` stays on 2.4.12. 2.5.x enables additional lint rules that surface pre-existing
  findings unrelated to this release.

## Upgrade notes

No database migration is required. Run `bun install`, rebuild Negotium, and restart the resident
Node so existing topics configured with `fable` pick up Fable 5.1 and `gpt-6-astra` appears in the
`/model` picker.
