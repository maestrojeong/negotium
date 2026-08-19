# Migration 0.5.7 - media visuals readable over the gateway

`0.5.7` fixes a defect in `0.5.6`: `show_image`, `show_png`, and `show_video`
produced no panel in a mapped room, while `show_html`, `show_mermaid`, and
`send_file` worked. Anyone on `0.5.6` who grants `visualTools` should upgrade.

The gateway read added in `0.5.6` authorized with `nodeFileStore.allows`, which
requires the caller to be the principal that stored the file. Callers do not
agree on who owns a file:

- `send_file` stores with `{ ownerUserId, topicId }`.
- A media visual resolved from `file_path` goes through
  `resolveVisualMediaInput`, which stores with `{ topicId }` and no owner.

So the read refused every media visual — silently, because a visual a host
cannot copy is deliberately dropped rather than announced with a URL that would
404 inside the panel. The symptom was a missing card, with nothing in the logs.

Ownership was never the property the gateway needed. M-8 asks that a caller not
reach another workspace's bytes by knowing a UUID, which is *room membership*.
`NodeFileStore.belongsToTopic(fileId, topicId)` now expresses exactly that, and
who may then read is left to `response`, which applies the file's own
visibility/owner/participant rules. `allows` is unchanged and keeps its owner
condition, which is correct for the upload path it was written for.

No contract change, no data migration: the route, its shape, and its
workspace-scoping behaviour are the same. Upgrade the node to `negotium@0.5.7`
and restart it — the node builds its handler from its own code, so a hub alone
cannot fix this.

## Verifying it on a real node

`bun run smoke:gateway-readback` runs a node against an isolated state dir and
drives both reads over real HTTP, including a file stored without an owner and
the cross-room denials. It is the check that would have caught this: the unit
tests stub the client, so nothing exercised the node's own authorization.
