# Migration to 0.1.37

Version 0.1.37 separates the immutable conversation history used for archive and teardown from the
compacted context supplied to AI providers. It also makes reset and deletion fail closed when
provider context cannot be removed.

## Conversation storage

Each participant/topic conversation can now have two files:

```text
data/conversations/<userId>/<topic>.jsonl
data/conversations/<userId>/<topic>.active.jsonl
```

- `<topic>.jsonl` is the append-only raw UnifiedEvent stream. Compaction never replaces it.
- `<topic>.active.jsonl` is the replaceable provider context. It is created by compaction and then
  receives each new event alongside the raw stream.
- Agent switching and provider rollout repair read the active projection when it exists.
- Reset and deletion archive the raw stream under `workspace/wiki/archive/` before cleanup.

## Automatic legacy migration

The singleton node runs an idempotent migration before accepting work. A legacy log whose first
conversation pair starts with `[Negotium compacted context]` is handled as follows:

1. The untouched legacy file is copied to
   `data/conversation-migration-backups/raw-active-v1/<userId>/<topic>.jsonl`.
2. The legacy compacted stream becomes `<topic>.active.jsonl`.
3. Visible messages from before the compaction boundary are reconstructed from SQLite, with
   incremental assistant UI updates collapsed to their final query result.
4. The reconstructed messages and legacy compacted stream become the raw `<topic>.jsonl`.

Both the 0.1.36 marker without `synthetic: "compaction"` and the newer marked event are accepted.
Malformed JSONL lines are logged and skipped so one damaged line cannot prevent node startup; the
untouched backup retains those bytes.

Legacy compaction already discarded provider tool and reasoning events from before its boundary.
Those events cannot be recreated from SQLite, but visible user and assistant messages are restored.

## Maestro session storage

The bundled `maestro-agent-sdk` is upgraded to `0.1.52`. Maestro now independently keeps its native
session history in `<sessionId>.jsonl` and its compacted working projection in
`<sessionId>.active.jsonl` under the SDK data directory. These provider-native files are separate
from Negotium's provider-neutral conversation files described above.

Negotium uses the SDK's configured data paths when checking whether a Maestro session can resume.
Reset and deletion remove both native files and fail closed if either remains.

## Reset and deletion

- Reset archives and purges every participant's conversation files.
- The topic session ID is cleared only after every provider rollout and raw/active file is removed.
- Deletion keeps the topic row when provider context cleanup fails, preventing a later topic with
  the same name from inheriting stale context.
- `force` continues to override archive failure only. It does not override provider-context cleanup
  failure.

## Upgrade checklist

1. Upgrade `negotium` and `@negotium/adapter-sdk` together to `0.1.37`.
2. Restart the singleton Negotium node. Migration runs before the node accepts new work.
3. Check logs for `conversation storage migrated to raw/active streams`.
4. Confirm migrated topics have both raw and `.active.jsonl` files and a backup under
   `data/conversation-migration-backups/raw-active-v1/`.
5. Keep migration backups until the migrated topics have completed at least one successful turn and
   their raw archives have been inspected.
