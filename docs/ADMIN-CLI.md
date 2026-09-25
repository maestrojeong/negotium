# `negotium admin` — node DB maintenance (topic-link v2, PR12)

Node-local operator commands for the Otium topic-link migration (design v2 §6:
M2 scope repair, M5 manager cleanup). They are not reachable over the Runtime
Gateway, and only an operator on the node host can run them.

| command | writes? | purpose |
|---|---|---|
| `list-managers` | never | Personal Generals per `(owner, surface, scope)`: id, created_at, message count, which one the node resolves, hub mapping |
| `owners-report` | never | Topics with more than one `topic_members` owner |
| `delete-manager TOPIC_ID` | only with `--apply` | Removes **one** messageless duplicate General that has a mapped keeper |
| `scope-repair --topic ID…` | only with `--apply` | Files unscoped otium rooms into the scope the hub report proves, via PR7's `adminRepairOtiumTopicScope` |

Run `negotium admin help` for the full syntax. The code is in
`apps/cli/src/commands/admin/` and the tests are in `apps/cli/tests/admin*.test.ts`.

## Safety model

### 1. Reports and dry-runs never touch the live DB files

SQLite can create or modify a WAL database's `-shm` (and a missing `-wal`)
even when it opens the database `readonly`. So no read-only command ever
opens the live file with SQLite. Instead, `private-copy.ts` does the following:

1. Reads the main file plus `-wal`/`-journal`, if present, byte for byte. It
   never reads `-shm`, which is only an index.
2. Writes those bytes into a fresh `mkdtemp` directory (0700, owned by the
   current user) with `O_EXCL|O_NOFOLLOW`, mode 0600.
3. Opens the **copy**, so SQLite replays the copied WAL there.
4. Records `(dev, ino, size, mtime)` of every source file before and after
   the read. If anything moved (a writer or a checkpoint), it retries. After
   three attempts it refuses.
5. Deletes the copy on exit.

Tests prove that the live directory listing is unchanged: names, sizes and
sha256 of the DB, `-wal` and `-shm`. They cover three cases:
- a WAL DB held open by core;
- a WAL DB whose `-shm` is missing (no `-shm` may appear);
- a CLI subprocess run on the live DB.

### 2. The hub report is evidence, and it is bound to this node's live store

The link-audit report (otium `scripts/link-audit`, `reportVersion: 1`) names
no node id or dbEpoch. Its only fingerprint is `inputs[].sha256`, the hash of
each DB copy it read. Every use of a report therefore needs the full binding
set:

| flag | checked against |
|---|---|
| `--hub-report FILE` | read once through one descriptor (`O_NOFOLLOW`, regular file); the same bytes are hashed and parsed |
| `--report-sha256 HEX` | sha256 of those bytes (`shasum -a 256 audit.json`) |
| `--audit-node-copy FILE` | the node snapshot the audit read: its sha256/size must equal `inputs[role=node, cellKey=--hub-cell]`, and it must have no `-wal/-shm/-journal` |
| `--expect-node-id`, `--expect-db-epoch` | must equal `api_node_identity (node_id, epoch_id)` of **both** the audit snapshot and the live DB (from the node's `/health`: `nodeId`, `dbEpoch`) |
| `--hub-cell KEY` | exactly one node input for this cell (default `""` = loopback) |
| `--max-report-age` | `generatedAt` must be at most this old (default `24h`, max `7d`) and not more than 5 min in the future |

A failed binding exits with code 6. Mapped-ness comes only from the report
entries for that exact topic id: D7 members, D2 rows (mapped) and D6 rows
(unmapped). An id the report does not list is `unknown`, and every guard
refuses `unknown`. If the report is inconsistent about an id, the result is
also `unknown`.

Each target and keeper row is compared with the audit snapshot and with the
live DB. The comparison covers the full fingerprint: row columns, owners,
members, message count, and every referencing table. It runs three times:
- at plan time;
- after core is loaded;
- again inside the apply transaction.

If any row changed since the audit, the command refuses and you must re-run
the audit.

### 3. `--apply` requirements

- **Node stopped.** There is no override flag. Before core is loaded, the
  command checks the following:
  - no `node-daemon.json` exists with a live pid (this matches `negotium status`);
  - no `runtime_process_leases` row has a live pid or a fresh heartbeat.

  Then this process takes the **`node-daemon` singleton lease itself**, so no
  node can start during the apply, and it checks again that no other lease is
  live.
- **This install's own DB only.** An apply to any `--db` other than this install's DB is refused.
- **Verified backup first.** `--backup-dir` must be a real directory (not a
  symlink), owned by you, with no group/other bits. If it does not exist, it is
  created 0700; its parent must already exist. Its `(dev, ino)` is pinned and
  re-checked before every write. The backup then goes through these steps in
  this order:
  1. `VACUUM INTO` a new name inside a fresh 0700 staging directory. SQLite
     refuses an existing target file, so the staging directory replaces
     `O_EXCL`.
  2. Open the file with `O_NOFOLLOW`, then check that it is a single-link
     regular file and chmod it 0600.
  3. `fsync(file)`.
  4. Verify: `quick_check`, the target rows and the node identity, read with
     `immutable=1` and `safeIntegers` (int64 values compare exactly).
  5. No-clobber rename (`link` + `unlink`) to a random basename, for example
     `pre-delete-manager-20260925T140955Z-<16 hex>.db`. The name never
     contains a topic id.
  6. `fsync(dir)`.

  Only then does anything else happen.
- **Journal before the change.** A row in `admin_operation_journal` (`run_id`,
  `phase=prepared`, backup path + sha256, report sha256) commits BEFORE the
  destructive transaction. The transaction flips it to `committed` atomically
  with the change. After the commit it becomes `done`, or `followup_failed`.
  After a rollback it becomes `aborted`. `admin_audit_log` gets one row per
  changed topic in the same transaction.
- **One `BEGIN IMMEDIATE` transaction** does the live re-plan and the change
  together. A failure before COMMIT leaves everything intact and prints
  `NOT APPLIED: run …`.
- **After COMMIT** the command prints `COMMITTED run=<id> …` first. A later
  failure (read-back, `rmdir` of an empty workspace dir, lease release) is
  reported as **exit 9 `APPLIED, follow-up failed: run <id>`**, never as a
  plain failure. Do not re-run the command. Inspect the journal row instead.

### 4. `delete-manager` — only messageless duplicates with a mapped keeper

**A topic with ≥ 1 message is never deletable** (design M5). There is no
`--allow-messages` and no export. The old export could not be lossless: it
omitted children, provider/unified logs, the workspace, the browser profile,
inbox/ask files and uploads. All of the following must hold, and no flag
relaxes any of them:

- exact id, `kind='manager'`, `surface='otium'`, not the retired `general` row;
- 0 messages, no provider `session_id`, not a child/subagent room;
- exactly one member, and it is the owner;
- no other row references the topic. The command scans **every column named
  `*topic*` in every table**, so it also covers tables added later. Examples:
  children (`parent_topic_id`, `memory_topic_id`), create claims (any
  state), tombstones, turn leases/requests, cron jobs, session inbox, asks,
  grants and visuals. Only `api_topic_config` and `runtime_topic_state` are
  deleted with the topic. `runtime_events` and `api_topic_scope_moves` are
  history and are kept. A live maintenance fence also refuses;
- no session-inbox file (id- or legacy title-keyed), pending-ask file (by id
  or title) or upload (`*.meta.json` with this `topicId`) references it. Its
  workspace directory must be absent or empty; an empty directory is removed
  after commit;
- another General of the **same `(owner, otium, scope)`** exists (the keeper),
  so the last one is never deleted;
- the bound report lists the target as **unmapped** with 0 messages: a D6 row
  that matches the live row, and a D7 member of that exact `(owner, scope)`
  group. It lists the keeper as **mapped** (with its room id) in the same
  group, with a matching message count;
- `--confirm-topic-id`, `--confirm-owner`, `--confirm-scope WS` (or
  `--confirm-unscoped` for NULL) and `--backup-dir` are given.

The delete does not call the lifecycle cascade. `deleteTopicCascade` purges
files and several tables *before* its transaction, so a late failure could
leave a half-deleted topic. It also deletes pending asks **by topic name**,
which would hit the keeper, also titled "General". Under the preconditions
above there is nothing outside the DB to purge. So one transaction deletes
config/state/member/topic rows, and the PR7 trigger writes the `deleted`
tombstone, stamped with this node's identity, in the same statement. No
runtime event is broadcast because the node is stopped: the hub learns about
the delete from the tombstone feed on its next full reconcile.

### 5. `scope-repair` — only through `adminRepairOtiumTopicScope`, only where the report proves the scope

- The tool never writes `surface_scope`. The only writer is PR7's primitive:
  NULL → scope, CAS on `(surface, NULL scope, created_at, title)`, audited in
  `api_topic_scope_moves` (actor `negotium-admin:<user>`), and create claims
  are **not re-bound**. PR7's `api_topics_otium_scope_immutable` trigger
  still refuses any direct write; a test checks this.
- There is no `--to-scope` and no `--allow-new-scope`. The topic must be a
  **D2** row of the bound report (mapped, still unscoped), with a matching
  kind/created_at/titleHash. The report's **D3** check must name exactly one,
  unambiguous scope (run the audit with `--scope WS`). `--expect-scope` must
  equal that scope. Unmapped rooms have no scope evidence and are refused.
- It refuses up front whatever the primitive would refuse, plus more:
  - not otium; scope not NULL;
  - a live maintenance fence;
  - **title conflict with any otium room of the target scope**, which covers
    other users' Generals and the retired `general` row (this is the
    primitive's own rule), or with another listed topic;
  - the `general` row itself, and a non-manager room titled `general`: that
    title is reserved, because core's `findTopicTitleConflict` resolves it to
    the retired shared row;
  - a manager that is not single-owner;
  - a manager without a matching **D7** member in the report: same owner,
    NULL scope, mapped to the same hub room as its D2 row, and the live
    message count;
  - a manager whose owner already has a General in the target scope (D7
    duplicate);
  - a D3 title conflict listed for the topic.
- All listed topics are repaired in **one outer IMMEDIATE transaction**. The
  primitive joins it through a savepoint. Any refusal or fault rolls every
  topic back.
- **Irreversible:** a repaired otium scope is immutable, and there is no
  revert command. Only restoring the backup (with the node stopped) undoes
  it.

## Exit codes

| code | meaning |
|---|---|
| 0 | report printed / dry-run plan applicable / apply committed and verified |
| 1 | unexpected error — nothing committed |
| 2 | usage error |
| 3 | refused by a safety guard — nothing changed |
| 4 | drift: rows changed between plan and apply — nothing changed |
| 5 | target not found / not eligible (ids are exact: no prefix, case folding or trim) |
| 6 | hub report rejected (hash, freshness, node id/epoch, snapshot binding, cell) |
| 9 | **APPLIED, follow-up failed** — the change IS committed; see the printed run id |

## Runbook: jaehomacmini (loopback node, 5 unscoped Generals, 4 messageful unmapped Generals)

Every step below runs on the node host, as the node's user, with the node's
environment (`NEGOTIUM_STATE_DIR`, `NEGOTIUM_NODE_ID`, …). `NODE_DB` is the
node's DB path (`SESSIONS_DB_PATH`, default `$NEGOTIUM_STATE_DIR/data/` + the
sessions DB file). Finish steps 3–9 within `--max-report-age` (24 h).

1. **Record the identity** while the node still runs:
   `curl -s http://127.0.0.1:<port>/health` → note `nodeId` and `dbEpoch`.
   Cross-check `nodeId` with the hub's record for jaehomacmini. After the stop,
   `negotium admin list-managers` prints the same `node_id`/`db_epoch`,
   read from a private copy of the stopped DB.
2. **Stop the node**: `negotium stop --all`, then `negotium status` must say
   it is not running. From here until step 10 the node stays stopped. Every
   apply re-checks this, and holds the `node-daemon` lease while it runs.
3. **Fresh private dirs**:
   `umask 077; RUN=$(mktemp -d "$HOME/negotium-admin-XXXXXX"); mkdir -m 700 "$RUN/backup"`.
4. **Snapshots bound to the stopped state**:
   - node: `sqlite3 "$NODE_DB" ".backup $RUN/node-copy.db"`. Keep this file
     byte-identical; it is `--audit-node-copy`. The node is stopped, so this is
     the only process that opens the live DB, and it runs before any admin
     command.
   - hub: with the hub in maintenance for this node, take
     `sqlite3 <HUB_DB> ".backup hub-copy.db"` on the hub host.
5. **Fresh audit** (otium repo, any machine holding both copies):
   `bun run link-audit --hub-db hub-copy.db --node-db node-copy.db --scope <WS> --node-identity <nodeId> --limit 0 --out audit.json`.
   For a worker cell, use `--cell-db <cellId>=node-copy.db` and pass
   `--hub-cell <cellId>` below. Bring `audit.json` into `$RUN`, then run
   `REPORT_SHA=$(shasum -a 256 "$RUN/audit.json" | cut -d' ' -f1)`.
6. **Reports**. Define the binding flags once:
   `B="--hub-report $RUN/audit.json --report-sha256 $REPORT_SHA --audit-node-copy $RUN/node-copy.db --expect-node-id <nodeId> --expect-db-epoch <dbEpoch>"`.
   Then run `negotium admin list-managers $B` and `negotium admin owners-report $B`.
   Expected today: the 4 messageful unmapped Generals (52/77/9/7 messages)
   are shown as `unmapped WITH messages (never deletable)`.
7. **Scope repair, one topic at a time**, for each of the 5 unscoped Generals:
   `negotium admin scope-repair --topic <id> --expect-scope <WS> $B` (dry-run).
   - Only topics that the report lists in D2 (mapped) get a `WRITE` line.
     Unmapped ones are refused with `no D2 evidence` and stay unscoped.
   - A `title_conflict` means the target scope already has an otium room
     titled "General": another user's General, or a General repaired earlier
     in this same step. The primitive refuses it; leave it unscoped and report
     it (see Risks). In practice, at most one of the 5 can be repaired into a
     scope, and only if that scope holds no General yet.
   - For each `WRITE` plan:
     `negotium admin scope-repair --topic <id> --expect-scope <WS> $B --apply --backup-dir "$RUN/backup"`.
     Keep the printed `COMMITTED run=…` line. The repair is irreversible.
8. **Re-snapshot and re-audit** (steps 4–5) if step 7 changed anything:
   repaired rooms no longer match the old audit snapshot.
9. **Delete only messageless duplicates that have a mapped keeper**: for each
   candidate from `list-managers` (a `DUPLICATE` group with a 0-message,
   unmapped member and a mapped sibling), run
   `negotium admin delete-manager <id> $B` (dry-run), then
   `… --apply --confirm-topic-id <id> --confirm-owner <owner> --confirm-scope <WS> --backup-dir "$RUN/backup"`.
   Expected on jaehomacmini today: **0 eligible**. The 4 messageful unmapped
   Generals are refused under every flag combination and are preserved.
10. **Restart the node** the way it normally runs (its service manager, or `negotium serve`). Then on
    the hub, run a **full reconcile** for this node, so it consumes the
    tombstone feed, including the `scopeMoved` entries of the repairs.
11. **Re-audit** with fresh snapshots (steps 3–5) and compare it with step 6:
    D2 should shrink by the repaired rooms, and D7 duplicates by the deleted
    ones.

If any apply exits 9, the change is committed. Do not re-run it. Look up
`admin_operation_journal` / `admin_audit_log` for the printed run id, fix the
follow-up (usually harmless: read-back, `rmdir`, lease release), and continue.

## Risks and limits

- **Generals vs. the primitive's title rule.** Every personal General is
  titled `General`. Core's `findTopicTitleConflict` and link-audit D3 both
  exempt managers from title checks. PR7's `adminRepairOtiumTopicScope` does
  **not**: it refuses `title_conflict` whenever any otium room titled `General`
  is already in the target scope. This tool calls only that primitive and
  does not work around it, so unscoped Generals whose scope already holds a
  General stay unscoped. Fixing this is a PR7/core follow-up: exempt
  `kind='manager'` in the primitive, the same way `findTopicTitleConflict` does.
- The private copy is a byte copy guarded by a stat-stability check. It does
  not use SQLite's backup API, because that API would open the live DB and
  could create `-shm`. The copy only feeds reports and plans; every apply
  re-plans on the live DB inside its `BEGIN IMMEDIATE` transaction.
- A report is bound to one snapshot. After any apply that touches a row a
  later command depends on, take a fresh snapshot and audit first.
- The only undo is restoring a backup file with the node stopped. That also
  discards every write made after the backup.
