# Migrating to Negotium 0.2.0

Negotium 0.2.0 is a breaking single-user filesystem release. It keeps public
`userId` arguments and database identity columns for adapter, authentication,
and wire compatibility, but standalone state has one canonical end-user
principal: `local`. Runtime process and lease `owner_id` values remain distinct
and are not rewritten.

The bundled Maestro runtime is `maestro-agent-sdk` 0.1.54. Its successful
login-PATH no-op bootstrap is silent, so importing the SDK no longer emits the
`login PATH already a subset` debug message.

## Before migrating

Stop the node and every adapter. The migration refuses to run when the state
tree records a live node process. Provider-native stores under `~/.claude`,
`~/.codex`, and `~/.maestro` are not read or changed.

The command is intentionally explicit and destructive. It preserves the
selected source principal, canonicalizes that principal to `local`, and deletes
all other user-owned filesystem and database state. Destination collisions and
canonical-local database rows cause preflight failure before mutation.

For a machine whose retained principal is already `local`, run:

```bash
negotium stop --all
negotium migrate single-user --source=local --delete-other-users --yes
```

For an older installation whose retained principal has another ID, pass that
exact ID to `--source`. The command does not print secret contents.

## New layout

```text
${NEGOTIUM_STATE_DIR:-~/.negotium}/
  data/
    sessions.db
    conversations/*.jsonl
    tasks/*.json
    uploads/
    vault/vault.db
  runtime/
  workspace/{topics,wiki,cron}/
  browser/profiles/<profile-name>/
  binaries/browser-rs/<version>/
  logs/
  secrets/{node-control-token,runtime-mcp-secret,vault-master-key}
```

`NEGOTIUM_BROWSER_DIR` overrides `browser/`. Existing
`NEGOTIUM_DATA_DIR`, `NEGOTIUM_LOG_DIR`, `NEGOTIUM_RUN_DIR`, and
`NEGOTIUM_WORKSPACE_DIR` remain accepted for compatibility. The `RUN` name is
deprecated; its default target is now `runtime/`.

## Safety and reruns

Moves first enter `.migration-0.2.0-staging` and are journaled after each
rename. Database files receive temporary rollback copies inside that staging
directory. A failed migration restores filesystem moves and databases. A rerun
also reconciles interruption between a rename and its journal update.

Success writes `.migration-0.2.0-single-user.json`, an owner-only JSON marker
containing the selected and canonical principals, completion time, path counts,
and migrated table names. Repeating the command after that marker is an
idempotent no-op.
