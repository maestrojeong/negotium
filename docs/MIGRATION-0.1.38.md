# Migration to 0.1.38

Version 0.1.38 hardens the long-lived browser MCP lifecycle. No SQLite, topic, conversation, Vault,
Wiki, or browser-profile data migration is required.

## Browser readiness

- Browser readiness now exercises both authenticated transports used by agents: SSE and Streamable
  HTTP.
- Both SSE and Streamable HTTP probes perform a complete MCP client connection and `tools/list`.
  Streamable HTTP also deletes its temporary session. A process-only `/health` response or partial
  transport handshake no longer qualifies a browser instance for reuse.
- Readiness credentials are derived for a dedicated probe owner. The browser's master capability is
  never sent through an agent-facing transport.

## Failure handling

- An unexpected browser MCP exit, child-process error, or failed transport probe fails every active
  turn using that shared browser profile with the specific infrastructure error.
- Browser infrastructure failures are distinct from user stops and newer-message supersedes, so
  callers and subagents receive the actual failure instead of waiting indefinitely.
- A failed health check restarts the browser only after notifying existing borrowers. The next turn
  creates or reuses a fully initialized instance.

## Startup cleanup

- After acquiring the singleton node-daemon lease, Negotium immediately reaps browser processes
  left under its managed profile tree by an earlier daemon.
- The sweep is lease-gated and path-boundary checked. It does not inspect or terminate Chrome
  profiles outside Negotium's browser-profile directory.
- The existing periodic janitor remains active for orphans created after startup.

## Upgrade checklist

1. Upgrade every Negotium package that the application directly depends on to `0.1.38`. Most
   runtime consumers only need `negotium`; upgrade `@negotium/adapter-sdk` in lockstep only when
   the application implements or imports the public adapter SDK.
2. Restart the singleton Negotium node so startup cleanup runs under the new daemon lease.
3. Start one browser-enabled turn and confirm both SSE and Streamable HTTP readiness checks pass.
4. Confirm a browser MCP failure ends affected turns promptly and the next browser turn starts a
   healthy instance.
