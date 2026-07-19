# Migration to 0.1.22

Version 0.1.22 improves interactive Vault use, prevents native passkey dialogs from blocking
browser automation, and hardens daemon handoff and browser-process ownership.

## Vault placeholders

- Claude and Maestro substitute `{{KEY}}` placeholders immediately before normal tool execution
  and redact matching values from tool output.
- Browser form tools can consume Vault placeholders without routing the operation through a shell
  or HTTP broker.
- Codex native shell and HTTP calls continue to use the Vault broker because Codex does not expose
  the same host-side tool hooks.
- Direct reads of Vault database and runtime secret-storage files remain blocked.

## Browser passkeys

- The managed Patchright wrapper installs a virtual WebAuthn authenticator before page tools run.
  This prevents Chrome-native passkey prompts from invisibly blocking DOM interactions.
- Explicit passkey install/create/list/delete tools remain available.
- Agent-facing passkey results never include private-key material.

## Daemon and browser ownership

- A canonical node process exits explicitly after its shutdown handlers complete, preventing a
  lease-losing daemon from remaining alive with module timers or sockets.
- Only the current `node-daemon` lease owner may run the cross-process browser orphan janitor.
  A stale process therefore cannot mistake a replacement daemon's browser for an orphan.

## Upgrade checklist

1. Upgrade the runtime and adapter SDK together to `0.1.22`.
2. Restart the Negotium node so the new daemon-exit and browser-wrapper behavior is loaded.
3. Confirm `negotium status` reports one node daemon after restart.
