# @negotium/adapter-otium

Attach a [negotium](https://github.com/maestrojeong/negotium) node to an
[otium](https://github.com/maestrojeong/otium) workspace as a **worker node**:
the workspace issues an invite code, the node joins, and rooms placed on the
node execute their agent turns locally — messages, tool activity, and visuals
flow back into the workspace UI.

```bash
npm install --global @negotium/cli
negotium otium join <invite-code>   # store credentials (…/otium-join.json, 0600)
negotium otium serve --port 7777    # must match the worker cell's direct baseUrl
negotium otium bindings             # inspect internal/shared transports
negotium otium share <host-topic-id> <local-topic-id> --user <user-id>
negotium otium private <local-topic-id> --user <user-id>
```

Implements otium's peer protocol v1: `ptk_` token verification against
central, provision → hidden mirror topics, `PeerTurnRequest` execution with
durable exactly-once request claims, and event backflow with contiguous
`seq` ordering (≤5 retries then hard-block — never skips). Proven E2E
against an unmodified otium hub with a real claude turn.

The hub may also bind an Otium room to an existing Negotium topic through
`/api/v1/peer/bind`. That shared binding preserves the local topic's agent,
history, tasks, and identity instead of creating a mirror. Unbinding removes
only the peer mapping and never deletes the local topic.

User topics have an independent `accessMode`: `private` is available through
Terminal and Telegram only, while `shared` may also be addressed and bound by
Otium. Local creation defaults to private. `share` explicitly publishes an
owner's visible topic and binds an Otium room; `private` removes all Otium
bindings for that topic without deleting its local history.

Mirror topics have explicit `visibility: hidden`, independent of access mode
and the `isSubagent` execution flag. They are internal worker replicas for an
Otium-owned room, not a user-facing access mode.

Shared execution context is implemented, but generic local-message projection
and history backfill into the Otium hub are not: the current hub event endpoint
is scoped to an active peer turn. The adapter therefore declares
`transcript: full`, `historyBackfill: false`, and `externalAuthors: relayed` in
the adapter SDK v2 contract.

Otium, Telegram, and Terminal share SQLite state but run independently:

```bash
negotium start otium
negotium start telegram  # another shell
negotium start terminal  # another shell; may be repeated
```

Otium holds a state-directory singleton lease and owns a stable loopback node port
(`NEGOTIUM_PORT`, default 7777, or `--port`). The integration
mounts through negotium's plugin chain
(`registerNodeRequestHandler`) — negotium core knows nothing about otium.

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
