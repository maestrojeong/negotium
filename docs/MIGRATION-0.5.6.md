# Migration 0.5.6 - gateway-minted visual and file capabilities

`0.5.6` lets a runtime gateway grant the visual and file-delivery tools to the turns it submits.

The runtime MCP has always been default-deny for `show_html`, `show_mermaid`, `show_image`,
`show_video`, `publish_html`, and the file-delivery tools: `buildNegotiumMcpServer` registers them
only when its context carries `visualTools` / `fileDeliveryTools`, because only an adapter that
renders a visual panel and a chat file surface knows whether the output would be displayed or
silently dropped.

`submitRuntimeGatewayTurn` had no way to say so. It writes the durable turn request, and the turn
worker builds the runtime MCP from that request's `execution`, so every turn arriving over
`POST /turns` had the tools stripped — while the prompt built for the same turn still advertised
them. An agent in a mapped room was told to call `show_html` and then handed an MCP without it.

`POST /turns` now accepts two optional booleans:

```jsonc
{
  "v": 1,
  "topicId": "...",
  "userId": "local",
  "text": "draw me a chart",
  "clientMessageId": "...",
  "visualTools": true,        // grants show_* and publish_html
  "fileDeliveryTools": true   // grants send_file / send_files
}
```

Both remain **default-deny**: omitting them behaves exactly as before, so a gateway with no visual
panel needs no change. They describe the calling adapter rather than the message, so they are
excluded from the idempotency payload hash — an adapter that starts sending them does not turn
in-flight `clientMessageId`s into `409`s.

`show_png`, the pre-rename alias of `show_image`, is registered and intercepted on the node for the
first time in this release. It rides the same `visualTools` gate, so it stays invisible to hosts
that grant nothing. Previously a session that had learned the old name could call a tool the node
did not have.

## Reading back what a node produced

Granting the capability is only half of making the tool work. A turn in a mapped room runs on the
node, so it renders into *that* node's visual store and delivers files into *that* node's upload
directory. A host that owns the room but not the execution has nothing to serve, and the ids it
receives resolve to nothing locally.

Two reads close that gap:

- `GET /topics/<id>/visuals/<vizId>` returns the visual in a portable shape.
- `GET /topics/<id>/files/<fileId>?user=<userId>` returns bytes the node holds for that room.

A host is expected to **copy** what it receives into its own store and serve it from there, rather
than proxy panel loads back to the node: a copy keeps working when the node is offline, and the
host's own access control stays in charge of who can see the room. Media file ids and delivered
attachment ids belong to the node, so a copying host re-uploads them under ids of its own.

Both are addressed through the owning room on purpose. Every mapped room executes as the same
`local` principal, so a file ACL keyed on the caller's user id authorizes nothing across
workspaces; the topic in the path is what applies `topicInRequestScope` (M-8).

## Capabilities the room remembers

A capability describes the surface a room is rendered on, but only a user turn arrives from an
adapter. Turns started by `triggerTopicAiTurn` — session-comm tell/ask, config-change
auto-continue, cron, subagent reports — have no adapter, and previously ran with no tools at all,
so a scheduled job could not draw into a panel that was sitting in front of the user.

The grant is now recorded on the room by the turns that carry it, and inherited by the turns that
do not. Absence defers; an explicit `false` still means no, so adapters that state their
capabilities outright are unaffected. It is recorded rather than derived from `topic.surface`
deliberately: deriving would grant tools to any host serving an `otium` room, including one too old
to carry a node's output back to its panel.

No data migration is required. Upgrade the embedding runtime to `negotium@0.5.6` and pass
`visualTools` / `fileDeliveryTools` on turn submission if the host renders those surfaces — and
copy node-produced visuals and files into its own store before showing them.

Adapters that expose `publish_html` should note that it needs a snippet backend in addition to the
capability: `createPublishHtmlToolDefinitions` returns no tools unless `NEGOTIUM_SNIPPETS_API_URL`
(or `SNIPPETS_API_URL`) is set, or an `apiUrl` is passed explicitly. Granting `visualTools` alone
is not enough to make it appear.
