# Migration to 0.1.29

Version 0.1.29 upgrades the browser backend and hosted agent SDK integrations. No stored topic,
conversation, Vault, or browser-profile data migration is required.

## Browser automation

- Package installation now downloads the verified Browser.rs `v0.1.12` binary for supported
  macOS arm64 and Linux x64 hosts.
- Browser.rs is the preferred engine behind Negotium's authenticated browser gateway. Patchright
  remains the automatic fallback when Browser.rs is unavailable, fails validation, or cannot
  support the configured browser proxy.
- Claude, Codex, and Maestro retain owner-isolated browser sessions. Browser credentials continue
  to pass through Vault substitution and fail-closed output redaction at the gateway boundary.
- Set `NEGOTIUM_SKIP_BROWSER_RS_INSTALL=1` during package installation to skip the optional binary,
  or set `NEGOTIUM_BROWSER_RS_BIN` to an executable Browser.rs `0.1.12` or newer.

## Agent runtimes and credentials

- Claude uses the version-matched Claude Code executable bundled with the Agent SDK by default.
  `NEGOTIUM_CLAUDE_EXECUTABLE` remains available as an explicit operator override.
- Codex SDK `0.145.0` uses a version-isolated model cache and keeps provider-native multi-agent
  tools disabled; Negotium's runtime `spawn_subagent` remains the supported delegation path.
- Maestro SDK `0.1.48` reads `DEEPSEEK_API_KEY` and `MOONSHOT_API_KEY` from each topic owner's
  Vault before falling back to process environment variables. In Terminal, choosing a Kimi or
  DeepSeek model with no key opens the matching masked Vault form and retries the switch after save.

## Terminal path completion

- `@path` completion now supports debounced recursive fuzzy matching for sufficiently specific
  fragments while retaining cheap current-directory completion for short input.

## Upgrade checklist

1. Upgrade `negotium` and `@negotium/adapter-sdk` together to `0.1.29`.
2. Allow the `negotium` postinstall script to fetch Browser.rs, or opt out explicitly with
   `NEGOTIUM_SKIP_BROWSER_RS_INSTALL=1`.
3. Restart Negotium and Terminal processes so they load the new agent SDKs and browser gateway.
4. For Kimi or DeepSeek, store the provider key in the user's Vault when it is not supplied by the
   runtime environment.
