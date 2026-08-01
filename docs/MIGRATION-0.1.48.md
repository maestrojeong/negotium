# Migrating to Negotium 0.1.48

Negotium 0.1.48 removes the always-resident `mcp-patchright` gateway and hosts
the shared MCP surfaces in the Negotium node process. Browser automation now
uses `browser-rs` directly.

## Browser runtime

- Negotium installs `browser-rs` 0.1.16 and requires 0.1.15 or newer.
- `mcp-patchright` is no longer installed or used as a fallback.
- The Rust process owns HTTP authentication, owner and session isolation, the
  tool allowlist, and graceful browser shutdown.
- Vault substitution and output redaction use a host-owned Unix socket broker.
  Broker failures are fail-closed and never return unredacted tool output.
- Browser output limits are applied after Vault redaction. This contract is why
  0.1.15 is the minimum supported browser-rs version.

Existing browser profiles remain in place. Restart the Negotium daemon after
upgrading so the old JavaScript gateway exits and the managed Rust process is
started with the new capability contract.

## Hosted MCP surfaces

Task, wiki, skills, Vault, token statistics, system health, session
communication, and agent health now share the Negotium HTTP MCP host. Runtime
tokens are audience-bound to a surface and session, and the host closes idle or
deleted sessions during shutdown.

The legacy runtime MCP URL remains available for compatibility, but newly
generated provider configuration uses the hosted surface URLs.

## Daemon memory

Provider SDKs and Otium runtime modules are loaded on first use. The node daemon
also imports narrow core entrypoints instead of the full `@negotium/core`
barrel. This keeps unused Claude, Codex, Maestro, and adapter modules out of an
idle process.

## Verification

After upgrade:

1. Run `negotium --version` and confirm `0.1.48`.
2. Restart the daemon and confirm its health endpoint is ready.
3. Start one browser-backed turn and confirm the browser tools are listed.
4. Confirm no `mcp-patchright-http.mjs` process remains resident.

If an older browser-rs binary is forced through an override, Negotium rejects
it instead of silently falling back to an insecure or incompatible transport.
