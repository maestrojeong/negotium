# Migration to 0.4.0

Version 0.4.0 makes execution-time Vault placeholder substitution consistent across Claude,
Codex, and Maestro, and removes the deprecated credential execution MCP surface.

## Breaking changes

- The Vault MCP server exposes `vault_list` only for every provider.
- `createVaultMcpServer` accepts `{ userId }` and a `VaultMcpHost` containing only `list(userId)`.
- Credential executor modules, request/result types, factory flags, executor injection, and public
  exports have been removed.
- `AgentExecutionHost` no longer includes the legacy Vault tool redirection callback.
- The legacy Vault policy factory and its broker-specific public helper types have been removed.

## Codex substitution

Negotium installs a capability-scoped Codex `PreToolUse` hook for each hosted turn. The hook denies
inputs that reference sensitive runtime storage and rewrites `{{KEY}}` placeholders only in the
same transient execution-tool allowlist used by the other providers. The hook reaches the
embedding host's `substituteVaultSecrets` callback through a private per-turn local socket; it does
not open Vault storage directly.

Codex hook configuration is supplied to the bundled CLI for the turn and is removed when the turn
ends. Provider events redact substituted values before they reach the embedding host.

## Embedding host upgrade

1. Remove credential executor modules and Vault MCP launch flags.
2. Replace the old credential-bearing host with `VaultMcpHost` and provide only `list`.
3. Remove the Vault tool redirection callback from `AgentExecutionHost` configuration.
4. Keep `substituteVaultSecrets`, `redactVaultSecrets`, and
   `referencesRuntimeSecretStorage` configured before running hosted agents.
5. Update prompts so all providers use `{{KEY}}` directly in supported transient tool inputs.
