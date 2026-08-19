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

No data migration is required. Upgrade the embedding runtime to `negotium@0.5.6` and pass
`visualTools` / `fileDeliveryTools` on turn submission if the host renders those surfaces.

Adapters that expose `publish_html` should note that it needs a snippet backend in addition to the
capability: `createPublishHtmlToolDefinitions` returns no tools unless `NEGOTIUM_SNIPPETS_API_URL`
(or `SNIPPETS_API_URL`) is set, or an `apiUrl` is passed explicitly. Granting `visualTools` alone
is not enough to make it appear.
