# Migration to 0.1.20

Version 0.1.20 restores direct Vault placeholder substitution for normal tool inputs while keeping
encrypted storage and output redaction. It also resolves Vault placeholders inside the authenticated
Playwright wrapper, so browser form tools can consume `{{KEY}}` without exposing plaintext to the
model transcript.

## Vault behavior

- Claude and Maestro replace `{{KEY}}` immediately before normal tool execution.
- Browser MCP calls replace nested placeholders inside the browser process for every provider,
  including Codex, and redact secret values from browser results and errors.
- The default Vault MCP surface now exposes `vault_list` only. `vault_run` and
  `vault_http_request` remain available from `createVaultMcpServer` for compatibility when an
  embedding host explicitly opts into those broker tools.
- Vault values remain AES-256-GCM encrypted at rest. Raw, URL-encoded, base64, base64url, and hex
  forms remain redacted from provider-visible tool output.

## Embedding hosts

`AgentExecutionHost` now accepts `substituteVaultSecrets(userId, value)`. Hosts with device-local
Vault storage should inject this callback alongside `redactVaultSecrets`. Hosts that configure the
shared `negotium/vault` storage process-wide inherit the default substitution implementation.

The bundled Playwright manager passes the browser owner user id to the authenticated wrapper.
Embedding hosts that retain a private Playwright manager or wrapper must either migrate to the
bundled manager or mirror the browser Vault transform and user-id environment wiring.

## Otium upgrade order

1. Publish and smoke-test Negotium 0.1.20.
2. Upgrade Otium's `apps/runtime-api` dependency and lockfile to `negotium@0.1.20`.
3. Inject Otium's `vaultSubstituteDetailed(...).text` through `substituteVaultSecrets`.
4. Replace or update Otium's duplicated Playwright wrapper and manager so `browser_fill` and other
   browser inputs resolve Vault placeholders locally.
5. Change Otium's normal Vault MCP launch to list-only and remove broker-only prompt guidance.
6. Run Otium typecheck, Vault security tests, browser wrapper tests, and runtime overlap audit.
