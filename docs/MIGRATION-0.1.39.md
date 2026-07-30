# Migration to 0.1.39

Version 0.1.39 exposes host-injected browser, query, prompt, session-catalog, and agent-lifecycle
APIs for applications that embed Negotium. No SQLite, topic, conversation, Vault, Wiki, or
browser-profile data migration is required.

## Browser runtime

- Import the shared lifecycle from `negotium/browser-runtime`.
- Call `configurePlaywrightManagerHost` once during bootstrap, before starting a browser.
- Inject the application's profile assignment, profile path, port range, browser binaries, proxy,
  child-process environment, exact-profile crash cleanup, and path-bounded orphan cleanup.
- Keep product-specific Vault callback variables in `createChildEnvironment`. Negotium always
  supplies the authenticated browser capability and owns process readiness, restart serialization,
  and failure fan-out.
- Remove downstream copies of the Playwright manager only after browser startup, shared-profile
  reuse, active-profile deletion, infrastructure failure, and restart recovery pass against the
  injected host.

See [Browser runtime](./BROWSER-RUNTIME.md) for the host contract and example.
The exact browser, tool-format, and query-state signatures used by downstream migration are recorded
in [Otium runtime deduplication](./OTIUM-RUNTIME-DEDUP.md).

## Shared helpers

- Replace downstream query-state file forks with
  `createQueryStateStore({ usersLogDir, logger, sanitizeTopicId })` from
  `negotium/query-runtime`.
- Import tool display and shell-summary helpers from `negotium/agent-helpers`.
- Replace product prompt forks with `createPromptBuilders` from `negotium/prompts`. Preserve
  product wording through ordered `extraSections` and optional `loadTemplate`; keep visual and
  file-delivery behavior behind the existing feature flags.
- Replace session target listing/validation forks with `createSessionTargetCatalog` from
  `negotium/mcp-factories`. Keep inbox, transport, and legacy configuration glue downstream.
- Import `createAskUserRuntime`, `createArchiverRuntime`, `createTopicLogMaintenance`,
  `createSelfConfigRuntime`, and `createSubagentLifecycle` from `negotium/agent-helpers`.
  Implement their host interfaces with product storage, messaging, runtime, and configuration
  services; do not import files from `dist/runtime/src`.
- Keep idle scheduling policy, MCP catalogs, ports/environment configuration, and top-level agent
  wiring in the downstream product.

## Package dependencies

Negotium's public packages are released at one version, but consumers only install packages they
directly use. Applications that only embed the runtime should upgrade `negotium` to `0.1.39`.
Add or upgrade `@negotium/adapter-sdk` only when the application implements or imports its public
adapter contracts.

## Upgrade checklist

1. Upgrade direct Negotium dependencies to `0.1.39`.
2. Configure the browser host before any call to `ensurePlaywright`.
3. Replace query-state, tool-format, prompt, session-catalog, ask-user, archiver, topic-cleanup,
   self-config, and subagent lifecycle forks with public factories plus thin host adapters.
4. Compare prompt snapshots before deleting the product builder.
5. Restart the node and exercise browser startup, profile reuse, profile deletion, failure
   propagation, recovery, ask settlement, self-configuration, and subagent completion.
