# Migrating to Negotium 0.1.49

Negotium 0.1.49 fixes the public `negotium/registry` package contract introduced
in 0.1.48. The runtime entrypoint now exports `getRegistryOperations` alongside
`getRegistry`, matching its TypeScript declarations.

Consumers that write, fork, or clean up provider rollouts must use
`getRegistryOperations(agent)`. Metadata-only consumers should continue using
`getRegistry(agent)` so provider operation modules stay lazy until needed.

The packed-install release smoke now imports `negotium/registry` from the built
tarball and verifies that all three registry operations are callable. The same
audit also found and fixed missing runtime exports for four Codex patch-preview
helpers under `negotium/rollout` and the agent-health and compaction-log server
factories under `negotium/mcp-factories`.

Release smoke now compares every runtime value promised by the declarations
against the installed JavaScript for all 22 public subpaths across both published
packages. No browser runtime or persisted-state migration is required; Browser.rs
remains pinned to 0.1.16.
