# @negotium/adapter-otium

Attach a [negotium](https://github.com/maestrojeong/negotium) node to an
[otium](https://github.com/maestrojeong/otium) workspace as a **worker node**:
the workspace issues an invite code, the node joins, and rooms placed on the
node execute their agent turns locally — messages, tool activity, and visuals
flow back into the workspace UI.

The worker is fully supplied by Negotium packages. It does not import, install,
or check out the Otium runtime repository: `@negotium/adapter-otium` implements
the peer/relay boundary while `@negotium/core` owns local agent execution.

```bash
npm install --global @negotium/cli
negotium otium join <invite-code>   # store credentials (…/otium-join.json, 0600)
negotium serve otium --port 7777    # canonical node + sidecar; add --relay <url> for NAT workers
negotium otium leave                # remove the stored credentials
```

Implements otium's peer protocol v1: `ptk_` token verification against
central, provision → hidden mirror topics, `PeerTurnRequest` execution with
durable exactly-once request claims, and event backflow with contiguous
`seq` ordering (≤5 retries then hard-block — never skips). Proven E2E
against an unmodified otium hub with a real claude turn.

Every user topic belongs to exactly one surface — `terminal`, `telegram` or
`otium` — for its whole life, and only the `otium` ones are visible here. There
is no publish/withdraw switch and no `accessMode` field: the hub discovers the
`otium` surface over the Runtime Gateway and projects it, never receiving a copy
of the transcript. The adapter's own `bind` / `share` / `private` surface, which
did copy messages into the hub's store, was removed — see D-1 in
`docs/OTIUM-NODE-ARCHITECTURE.md` and S-1/S-4 in
`docs/SURFACE-SESSION-SEPARATION.md`.

Mirror topics have explicit `visibility: hidden`, independent of surface and of
the `isSubagent` execution flag. They are internal worker replicas for an
Otium-owned room.

Shared execution context is implemented, but generic local-message projection
and history backfill into the Otium hub are not: the current hub event endpoint
is scoped to an active peer turn. The adapter therefore declares
`transcript: full`, `historyBackfill: false`, and `externalAuthors: relayed` in
the adapter SDK v2 contract.

One canonical Node owns turns, MCP, Cron, and inbox workers. Otium, Telegram,
and Terminal are independent clients/sidecars of that Node:

```bash
negotium serve otium  # Otium sidecar
negotium telegram     # another shell
negotium terminal     # another shell; may be repeated
```

`negotium serve otium` ensures the advertised singleton Node daemon and keeps
the Otium sidecar in the foreground. The sidecar owns the stable peer port
(`NEGOTIUM_PORT`, default 7777, or `--port`) and relay tunnel; the Node owns
the authenticated adapter-control endpoint and all runtime state. If the Node
restarts, the sidecar returns a clear 503 while it is unavailable and discovers
the replacement automatically. `negotium otium serve` remains a deprecated alias scheduled for
removal in a future cleanup release.

Relay mode uses the optional `relay` field in join credentials, or
`OTIUM_RELAY_URL`, with `serve --relay <http(s)/ws(s) URL>` taking precedence.
The worker dials the relay outbound with the cell secret and forwards the local
node's HTTP and WebSocket endpoints through relay protocol v1.

## Local experiment (no cloud)

`scripts/otium-experiment/hub-setup.ts` boots otium central-api + a hub runtime-api locally
with direct URLs (no relay), registers the cells, and prints an invite code;
`scripts/otium-experiment/run-e2e.ts` places a room on your node and round-trips a prompt.
See `scripts/otium-experiment/README.md`.

## Development

```bash
bun run --filter @negotium/adapter-otium check
bun test adapters/otium # token-free tests (fake central + fake hub)
```

## License

Apache-2.0
