# 0.1.14 canonical Node migration

Negotium now has one advertised Node process per state directory. That process is the sole owner of
turn execution, MCP hosts, Cron, and inbox workers. Otium and Telegram no longer start embedded Nodes.

## Commands

```bash
negotium serve otium                 # canonical daemon + foreground Otium sidecar
negotium status                      # Node and adapter PIDs
negotium stop                        # Node only
negotium stop otium                  # Otium sidecar only
negotium stop telegram               # Telegram adapter only
negotium stop --all                  # adapters, then Node
```

`negotium otium serve` remains available for rolling migration and prints a deprecation warning.

## Operational changes

- Otium exposes peer routes and the optional relay tunnel from its sidecar. The sidecar forwards peer
  HTTP payloads across an authenticated loopback adapter API; runtime and storage APIs stay private.
- A stopped Node produces HTTP 503 from the Otium sidecar. The sidecar discovers a replacement
  advertised Node on every request, so no sidecar restart is needed after Node recovery.
- Telegram remains a separate polling process but submits user turns to the canonical Node control
  API. Existing chat/thread mappings and SQLite state are unchanged.
- Start or restart the canonical Node after joining a new Otium workspace so its runtime bridge is
  mounted. Adapter failure no longer stops Terminal, other adapters, or active Node-owned work.
