# otium ↔ negotium coupling — local E2E checklist (v1, Runtime Gateway)

One machine, no cloud, no relay. Model: `docs/OTIUM-NODE-ARCHITECTURE.md`
(Runtime Gateway / Dynamic Topic Mapping, D-1/D-6). The current `~/otium`
checkout is used — the "invite code" is a local-only credential bundle minted
through central's admin API, not a one-time production invite.

> **v1 note:** this checklist replaces the old "placed-turn" flow
> (`PUT /api/v1/topics/:id/node`, hidden mirror topics, `/api/v1/peer/turn`).
> That receiver was deleted end to end — see "Placed-turn receiver retired" in
> `docs/OTIUM-NODE-ARCHITECTURE.md`. There is one data plane now: the node
> owns a topic, the hub discovers it and mirrors a room automatically.

## Ports

| service | port | source |
|---|---|---|
| central-api | 4600 | `~/otium/apps/central-api` |
| hub runtime-api | 4000 | `~/otium/apps/runtime-api` |
| negotium worker sidecar | 7777 | this repo (`negotium otium serve --port 7777`) — legacy `/ready` + peer routes only |
| negotium canonical Node | 6479 (`NODE_PORT` env) | this repo — the Runtime Gateway contract (`/api/v1/control/runtime/v1/*`) lives here, **not** on the sidecar port. Defaults away from negotium's real default (6370) so the experiment does not collide with a Node already running on the machine for other purposes. |

## 1. Hub side — automated

```bash
cd ~/negotium
bun scripts/otium-experiment/hub-setup.ts
```

This boots central-api + hub runtime-api in the background (logs and
`state.json` under `/tmp/otium-experiment`), creates the workspace, registers
both cells with **direct** baseUrls (`http://127.0.0.1:4000` / `:7777` — no
relay needed), attaches worker `nego`, and prints the worker commands
(including the `NEGOTIUM_NODE_PORT` to use) plus the two follow-up steps
below.

Notes:
- Admin login uses central's dev email-code flow (`EMAIL_MODE=dev` returns the
  code in the HTTP response) — no mail is sent.
- The hub gets `OTIUM_MULTI_NODE=1`, `OTIUM_ALLOW_LOCAL_AUTH_IN_HOSTED=1`, a
  generated admin key, and fresh state dirs. Its exact spawn env is saved
  into `state.json` (`hub.env`) so `enable-gateway.ts` can restart the same
  process later with the Gateway env added, instead of guessing it back.
- Re-running requires removing `/tmp/otium-experiment` (and killing the PIDs
  in `state.json`) first.

## 2. Worker side — two commands

```bash
cd ~/negotium
export NEGOTIUM_STATE_DIR=/tmp/otium-experiment/worker-state
bun apps/cli/src/main.ts otium join <code-from-step-1> --legacy
NEGOTIUM_NODE_PORT=6479 bun apps/cli/src/main.ts otium serve --port 7777
```

(`--legacy` because `hub-setup.ts` mints a v1 local-experiment invite, not a
production v2 one — that flag makes `join` parse it directly instead of
expecting the newer versioned shape.)

`join` persists the join credentials under the experiment's isolated worker
state (0600) and self-checks against central ("attached to workspace as
nego"). `serve` starts the canonical Node (on `NEGOTIUM_NODE_PORT`, default
6370 — set it explicitly here to avoid colliding with any Node already
running on this machine) and the sidecar (on `--port`, legacy `/ready` +
peer routes only).

Agent auth on the worker: whatever agent you pass as `AGENT` below must be
logged in on this machine (`claude` → Claude Code login; check with
`negotium init`).

## 3. Turn the Runtime Gateway on — automated

```bash
bun scripts/otium-experiment/enable-gateway.ts
```

The hub was booted in step 1 *before* the worker Node existed, so it could not
yet know the worker's node-control credential (D-2: the loopback transport
authenticates with a credential minted only once the Node has started) — the
Gateway is off until this step runs. This script reads the credential the
Node wrote to disk under the worker state directory, restarts hub-runtime-api
with the Gateway env vars pointed at the worker Node, and waits for `/ready`
again. Re-run it any time the worker Node restarts (the credential is stable
across restarts, but re-running is harmless).

## 4. Drive the E2E — automated

```bash
bun scripts/otium-experiment/run-e2e.ts            # defaults: AGENT=claude, one-line prompt
# PROMPT="..." AGENT=claude bun scripts/otium-experiment/run-e2e.ts
```

What it does now (Runtime Gateway flow, not the old placement flow) and what
proves what:

1. `GET {worker}/ready` (sidecar) + `GET {node}/health` (Gateway,
   node-control-credential auth) — both are up.
2. Hub login (`POST /api/v1/auth/verify` with the generated admin key).
3. `POST {node}/api/v1/control/runtime/v1/topics` — creates a topic directly
   on the negotium Node. `control.ts` always creates these with
   `surface: "otium"`, which is the only thing the hub's discovery loop looks
   for.
4. Polls the hub's `GET /api/v1/topics` (≤30s, topic-sync itself polls every
   15s — `SYNC_INTERVAL_MS` in `topic-sync.ts`) until a room with the same
   title appears. **This is the discovery-latency number** the earlier
   latency analysis could only estimate; the script reports it in
   milliseconds.
5. `POST /api/v1/topics/:id/messages` on the mirrored room — a mapped topic
   executes the turn automatically via `submitTurn` (`messages.ts`) straight
   to the node's `POST /turns`. There is no separate `POST /ai` call for a
   mapped topic any more; calling `/ai` on one now returns 409 by design
   (`ai.ts`: "executed by Negotium through message submission").
6. Polls `GET /messages` until an `authorId:"ai"` message created at or after
   the turn started appears — that message traveled node → SSE event stream
   (`GET /events`) → `projection.ts` → hub room. Reports this as the
   **turn round-trip** number (submitTurn ack + real agent turn + projection
   back).

### Not carried over yet

`E2E_FEATURES=input,artifact,ask` (file bridging, visuals, remote `ask_session`)
existed in the old script but all of it assumed a *placed* room
(`createAgentRoom(..., placeOnWorker: true)`), which no longer exists. Redoing
these against a *mapped* room is a separate, larger piece of work — tracked
but intentionally out of scope for this pass. See `tmp/run-e2e-fix-plan.html`
§4 (item 3) for the reasoning.

## 5. Manual verification (optional but instructive)

- Hub UI feed: `open http://127.0.0.1:4000` and log in with the admin key
  from `/tmp/otium-experiment/state.json` — typing/tool events of the mapped
  room render live while the worker runs.
- Confirm the mapping table directly with a SQLite client against the hub's
  local state under `hub-state/data/` in `EXPERIMENT_DIR` — the table is
  `negotium_topic_map`, columns `otium_topic_id, negotium_topic_id`.
- **Abort:** send a long-running prompt, then
  `POST {node}/api/v1/control/runtime/v1/topics/:id/abort` directly on the
  node, or use the hub UI stop button on the mapped room.
- **Cross-node tell:** unaffected by this rewrite — still node-to-node over
  session-comm (D-7), not through the hub at all.

## 6. Current limitations

| gap | symptom |
|---|---|
| discovery latency | a fresh node topic takes up to ~15s (average ~7.5s) to appear as a hub room — there is no push path yet, only `topic-sync`'s poll. See the latency analysis in this topic for the ranked fix. |
| `E2E_FEATURES` suite | not ported to the mapped-room model yet (see §4 above) |
| direct URL | `serve --port` / `NEGOTIUM_NODE_PORT` must match the cell's registered `baseUrl` and the Gateway's configured base URL; relay transport for this local experiment is out of scope (it is implemented in production, D-2, just not exercised by this script) |

## 7. Teardown

```bash
kill $(bun -e 'const s=await Bun.file("/tmp/otium-experiment/state.json").json();console.log(s.central.pid,s.hub.pid)')
rm -rf /tmp/otium-experiment
```
