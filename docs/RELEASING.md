# npm release guide

Negotium publishes two npm packages at one lockstep version:

1. `@negotium/adapter-sdk` for third-party adapter contracts, outbox helpers, and testkit utilities.
2. `negotium` for the CLI, runtime, MCP services, Cron module, and first-party adapters.

The other ten workspaces are private source boundaries. They are built and tested in the monorepo
but must never be published or referenced by a public package manifest.

## One-time setup

1. Use an npm account with a verified email address and two-factor authentication.
2. Create the public `negotium` npm organization.
3. Authenticate locally and confirm the release identity.

```bash
npm login --auth-type=web
npm whoami
```

The organization owns `@negotium/adapter-sdk`. The stable release account owns the unscoped
`negotium` name.

## Validation

```bash
bun install
bun run check
bun test
bun run release:check
bun run release:status
bun run release:dry-run
bun run release:smoke
```

The release scripts enforce:

- one version across both public packages and the runtime version constant;
- `private: true` and no `publishConfig` on every internal workspace;
- no public dependency on a private workspace package;
- explicit package file allowlists and public publish configuration;
- a clean Git worktree for publishing;
- idempotent skipping when a version already exists on npm; and
- tarball installation of both packages into an empty project.

## Publishing

Commit and push the validated release before publishing:

```bash
git push
bun run release:publish --confirm
```

The command publishes the SDK first and the complete runtime second. If authentication or registry
propagation interrupts it, rerun the same command; versions already visible on npm are skipped.

## Retiring the old package graph

Previously published internal packages remain available so old lockfiles continue to install. Do
not unpublish them. After the replacement `negotium` version is visible, mark their old versions as
deprecated with a migration message:

```bash
npm deprecate '@negotium/core@<=0.1.7' 'Bundled into negotium; install negotium instead.'
npm deprecate '@negotium/mcp@<=0.1.7' 'Bundled into negotium; install negotium instead.'
npm deprecate '@negotium/mcp-host@<=0.1.7' 'Bundled into negotium; install negotium instead.'
npm deprecate '@negotium/module-cron@<=0.1.7' 'Bundled into negotium; install negotium instead.'
npm deprecate '@negotium/node@<=0.1.7' 'Bundled into negotium; install negotium instead.'
npm deprecate '@negotium/adapter-testkit@<=0.1.7' 'Use @negotium/adapter-sdk/testkit instead.'
npm deprecate '@negotium/adapter-terminal@<=0.1.7' 'Bundled into negotium; run negotium terminal.'
npm deprecate '@negotium/adapter-telegram@<=0.1.7' 'Bundled into negotium; run negotium telegram.'
npm deprecate '@negotium/adapter-otium@<=0.1.7' 'Bundled into negotium; run negotium otium.'
npm deprecate '@negotium/cli@<=0.1.7' 'Replaced by the complete negotium package.'
```

Deprecation is reversible and preserves reproducible installs. Unpublishing is not part of the
release process.

## Release checklist

1. Update both public manifests, private workspace manifests, and `NEGOTIUM_VERSION` together.
2. Refresh `bun.lock`.
3. Run check, test, dry-run, and smoke validation.
4. Commit and push the release.
5. Publish with explicit confirmation.
6. For the first consolidated release only, deprecate the old package graph after verification.
