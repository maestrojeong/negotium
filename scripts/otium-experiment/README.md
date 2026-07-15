# otium ↔ negotium coupling — local E2E checklist (v0)

One machine, no cloud, no relay. Contract: `docs/OTIUM-COUPLING.md`.
The current `~/otium` checkout is used — the "invite code" is a local-only credential bundle
minted through central's admin API, not a one-time production invite.

## Ports

| service | port | source |
|---|---|---|
| central-api | 4600 | `~/otium/apps/central-api` |
| hub runtime-api | 4000 | `~/otium/apps/runtime-api` |
| negotium worker | 7777 | this repo (`negotium otium serve --port 7777`) |

## 1. Hub side — automated

```bash
cd ~/negotium
bun scripts/otium-experiment/hub-setup.ts
```

This boots central-api + hub runtime-api in the background (logs and
`state.json` under `/tmp/otium-experiment`), creates the workspace, registers
both cells with **direct** baseUrls (`http://127.0.0.1:4000` / `:7777` — no
relay needed), attaches worker `nego`, and prints:

```
bun apps/cli/src/main.ts otium join <base64url-code>
```

Notes:
- Admin login uses central's dev email-code flow (`EMAIL_MODE=dev` returns the
  code in the HTTP response) — no mail is sent.
- The hub gets `OTIUM_MULTI_NODE=1`, `OTIUM_ALLOW_LOCAL_AUTH_IN_HOSTED=1`, a
  generated `ADMIN_KEY` (saved to state.json) and fresh state dirs.
- Re-running requires removing `/tmp/otium-experiment` (and killing the PIDs
  in `state.json`) first.

## 2. Worker side — two commands

```bash
cd ~/negotium
export NEGOTIUM_STATE_DIR=/tmp/otium-experiment/worker-state
bun apps/cli/src/main.ts otium join <code-from-step-1>
bun apps/cli/src/main.ts otium serve --port 7777
```

`join` persists `{central, cellId, secret}` under the experiment's isolated worker state
(0600) and self-checks against central ("attached to workspace as nego").
`serve` sees the join file and mounts the otium peer routes
(`/ready`, `/api/v1/peer/*`) in front of the negotium MCP handler on :7777.

Agent auth on the worker: the placed room's agent must be logged in on this
machine (`claude` → Claude Code login/`ANTHROPIC_API_KEY`; check with
`negotium init`). The hub checks this via `/api/v1/peer/capabilities` before
placing.

## 3. Drive the E2E — automated

```bash
bun scripts/otium-experiment/run-e2e.ts            # defaults: AGENT=claude, one-line prompt
# PROMPT="..." AGENT=claude bun scripts/otium-experiment/run-e2e.ts

# Optional feature-level cross-process suite (adds provider turns):
E2E_FEATURES=input,artifact,ask bun scripts/otium-experiment/run-e2e.ts
# E2E_FEATURES=all is equivalent.
```

What it does (the placement/turn flow in the coupling contract §1.3–1.4) and what proves what:

1. `GET {worker}/ready` — worker is up.
2. Hub login (`POST /api/v1/auth/verify` with the generated ADMIN_KEY).
3. `GET /api/v1/peer/workspace-nodes` — `nego` shows `ready: true`
   (hub → worker `/ready` probe through central discovery).
4. `POST /api/v1/agents {title, agent}` — **fresh** room (a room with an
   existing native session cannot be placed, doc §risk 7).
5. `PUT /api/v1/topics/:id/node {"nodeName":"nego"}` — 200 proves the whole
   placement chain: `/ready` → `/capabilities` (agent available, `execution.mcp
   ⊆ optionalMcp` — empty here to avoid catalog-name mismatch) → `/provision` (hidden mirror
   topic created on negotium).
6. `POST /messages` + `POST /ai` — hub answers with `queryId = pt-…`
   (the peer requestId), i.e. the turn was dispatched to the worker, not local.
7. Polls `GET /messages` until an `authorId:"ai"` message with
   `queryId == requestId` appears — that message traveled
   negotium bus → adapter backflow → `POST {hub}/api/v1/peer/event` (seq 1..n)
   → hub journal → room. Terminal `ai_done` marks `peer_turns.status=completed`.

With `E2E_FEATURES`, the driver creates isolated rooms for each additional
contract and fails unless the hub observes the real end result:

- `input`: uploads a marker file to the hub, attaches it to a placed turn, and
  requires the worker agent to read the copied file and return the marker.
- `artifact`: requires the worker to create and `send_file` a marker file, then
  call `show_html`, `show_mermaid`, `show_image`, and `show_video`. The driver
  downloads the announced hub attachment, compares its bytes, and requires
  exactly one hub-owned attachment/visual for every expected title and kind.
- `ask`: creates a local hub target and a placed caller, then requires the
  worker to call `ask_session` back to the hub. The marker must return through
  remote reply and appear in the canonical placed hub room. This also exercises
  active `sourceQueryId` user delegation.

## 4. Manual verification (optional but instructive)

- Hub UI feed: `open http://127.0.0.1:4000` and log in with the ADMIN_KEY from
  `/tmp/otium-experiment/state.json` — typing/tool events of the placed room
  render live while the worker runs.
- Worker-side state:
  ```bash
  sqlite3 /tmp/otium-experiment/worker-state/data/sessions.db \
    "SELECT request_id,status FROM otium_peer_turn_requests ORDER BY created_at DESC LIMIT 5;
     SELECT host_topic_id,local_topic_id FROM otium_peer_sessions;"
  ```
- Hub-side journal:
  ```bash
  sqlite3 /tmp/otium-experiment/hub-state/data/sessions.db \
    "SELECT request_id,status,last_event_seq FROM peer_turns ORDER BY created_at DESC LIMIT 5;"
  ```
- **Abort** (coupling contract §1.5): send a long-running prompt, then stop it —
  `DELETE {hub}/api/v1/topics/:topicId/ai/:queryId` (or the UI stop button).
  The worker aborts the local turn and the hub receives `ai_aborted`.
- **Cross-node tell** (coupling contract §1.5): in another hub room, ask its agent to
  run `tell_session` with target `nego/<room title>` — the worker's
  `/api/v1/peer/tell` claims it durably and injects it into the mirror room's
  inbox.
- **Hub restart mid-turn** (doc risk 2): kill the hub while a turn streams —
  the worker's event POSTs get 404, retry ≤5 times, then hard-block; the local
  turn still finishes locally and no later seq is ever sent.

## 5. Current limitations

| gap | symptom |
|---|---|
| MCP names | placing a room whose MCP override names servers negotium doesn't have → 409 `node "nego" lacks MCP: …`. Leave the room's MCP override empty. |
| direct URL | `serve --port` must match the worker cell's registered `baseUrl`; relay transport is not implemented yet. |
| projection | generic local-message projection and history backfill into the hub are not implemented. |

## 6. Teardown

```bash
kill $(bun -e 'const s=await Bun.file("/tmp/otium-experiment/state.json").json();console.log(s.central.pid,s.hub.pid)')
rm -rf /tmp/otium-experiment
```
