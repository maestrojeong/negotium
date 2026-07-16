# npm release guide

Negotium publishes 12 npm packages from one repository at a lockstep version. Scoped packages contain
the implementation; the unscoped `negotium` package is a working convenience entry point for
`@negotium/cli`.

## One-time setup

1. Use an npm account with a verified email address and two-factor authentication.
2. Create the public `negotium` npm organization.
3. Authenticate locally and confirm the release identity.

```bash
npm login --auth-type=web
npm whoami
```

The organization owns `@negotium/*`. The npm account that first publishes the unscoped `negotium`
package owns that name, so use a stable release account.

## Validation

Run every check before publishing:

```bash
bun install
bun run check
bun test
bun run release:check
bun run release:status
bun run release:dry-run
bun run release:smoke
```

Narrow a dry run or resume a status check when investigating one package:

```bash
bun scripts/release-packages.ts dry-run --only=@negotium/core
bun scripts/release-packages.ts status --from=@negotium/node
```

The release scripts enforce:

- one version across all publishable packages;
- dependency order and exact release versions for internal packages;
- an explicit `files` allowlist and public publish configuration;
- a clean Git worktree for an actual publish;
- idempotent skipping when a version already exists on npm; and
- npm packing plus npm installation of all tarballs into an empty project during `release:smoke`.

## Publish order

Packages are published in dependency order:

1. `@negotium/adapter-sdk`
2. `@negotium/core`
3. `@negotium/mcp-host`
4. `@negotium/module-cron`
5. `@negotium/mcp`
6. `@negotium/node`
7. `@negotium/adapter-testkit`
8. `@negotium/adapter-terminal`
9. `@negotium/adapter-telegram`
10. `@negotium/adapter-otium`
11. `@negotium/cli`
12. `negotium`

## Publishing

After reviewing the dry run, publish from a clean committed worktree:

```bash
bun run release:publish --confirm
```

If authentication or registry propagation interrupts the command, run it again. Versions already
published are skipped. Use `--from=<package>` only when a deliberate resume point is needed.

Releases currently run locally. The repository does not store a long-lived npm token or an npm
publish workflow. Confirm `npm whoami` immediately before publishing.

For a new release:

1. Update all publishable package versions together.
2. Refresh the lockfile.
3. Run check, test, dry-run, and smoke validation.
4. Commit the version change.
5. Publish with explicit confirmation.
