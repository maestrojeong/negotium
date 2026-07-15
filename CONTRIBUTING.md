# Contributing to Negotium

Negotium is an early-stage Bun and TypeScript monorepo. Issues and pull requests should keep the
runtime host-agnostic and preserve the package boundaries described in the architecture documents.

## Set up the repository

Requirements:

- Bun 1.2.15 or newer
- Node.js 20 or newer when testing Codex stdio MCP tools
- macOS or Linux

```bash
git clone git@github.com:maestrojeong/negotium.git
cd negotium
bun install
```

Credentials are not required for the token-free unit tests. Never commit `.env`, provider
credentials, Telegram tokens, a live `NEGOTIUM_STATE_DIR`, or generated vault keys.

## Make a change

- Keep unrelated changes in separate pull requests.
- Add or update tests for behavior changes.
- Update the root and package README files when commands, environment variables, exports, or
  lifecycle semantics change.
- Import across packages through public exports rather than source-relative paths.
- Do not add a built-in skill catalog. Reusable skills belong to the runtime-managed shared wiki
  and should accumulate through `skill_save` and the wiki archiver.

Run the relevant package tests while iterating, then run the repository checks before opening a
pull request:

```bash
bun run check
bun test
bun run release:check
```

For changes that affect package contents or public exports, also run:

```bash
bun run release:dry-run
bun run release:smoke
```

## Pull requests

Describe the user-visible behavior, the package boundaries affected, and how the change was
verified. Call out migrations, compatibility risks, new processes or ports, and changes to stored
state. Maintainers handle version updates and npm publishing after the pull request is merged.
