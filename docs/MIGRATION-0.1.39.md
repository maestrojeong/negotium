# Migration to 0.1.39

Version 0.1.39 exposes host-injected browser and query runtime APIs for applications that embed
Negotium. No SQLite, topic, conversation, Vault, Wiki, or browser-profile data migration is
required.

## Browser runtime

- Import the shared lifecycle from `negotium/browser-runtime`.
- Call `configurePlaywrightManagerHost` once during bootstrap, before starting a browser.
- Inject the application's profile assignment, profile path, port range, browser binaries, proxy,
  child-process environment, and path-bounded orphan cleanup.
- Keep product-specific Vault callback variables in `createChildEnvironment`. Negotium always
  supplies the authenticated browser capability and owns process readiness, restart serialization,
  and failure fan-out.
- Remove downstream copies of the Playwright manager only after browser startup, shared-profile
  reuse, infrastructure failure, and restart recovery pass against the injected host.

See [Browser runtime](./BROWSER-RUNTIME.md) for the host contract and example.

## Shared helpers

- Replace downstream query-state file forks with
  `createQueryStateStore({ usersLogDir, logger, sanitizeTopicId })` from
  `negotium/query-runtime`.
- Import tool display and shell-summary helpers from `negotium/agent-helpers`.
- `negotium/prompts` remains available to consumers that already share Negotium's prompt policy.
  Do not replace a product-specific prompt builder solely to deduplicate code: visual, file-delivery,
  memory-path, and copyable-draft sections may be part of the host application's behavior. A
  downstream builder should migrate only after its prompt snapshots match or the shared builder
  gains the required host extension points.

Large agent orchestration modules remain internal until their storage, session, and scheduler
dependencies have explicit host contracts. Do not import files from `dist/runtime/src`.

## Package dependencies

Negotium's public packages are released at one version, but consumers only install packages they
directly use. Applications that only embed the runtime should upgrade `negotium` to `0.1.39`.
Add or upgrade `@negotium/adapter-sdk` only when the application implements or imports its public
adapter contracts.

## Upgrade checklist

1. Upgrade direct Negotium dependencies to `0.1.39`.
2. Configure the browser host before any call to `ensurePlaywright`.
3. Replace query-state and tool-format forks with public imports. Keep product-specific prompt
   builders until prompt snapshots and host policy sections are preserved.
4. Restart the node and exercise browser startup, profile reuse, failure propagation, and recovery.
