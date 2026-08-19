# Migration 0.5.8 - the prompt stops naming tools the room does not have

`0.5.8` is a prompt-correctness release. No contract change, no data migration,
no behaviour change for a room that already grants `visualTools` and
`fileDeliveryTools`. Upgrade if you run any **default-deny** surface — Telegram,
a headless host, or a gateway that mints capabilities selectively.

## The prompt contradicted the tool list

Two bullets in the shared `## Tool notes` block named a capability-gated tool
unconditionally:

- "Sending files: use the file-delivery tool…"
- "Visual output …: use **the visual tool below**…"

Both were injected into every room, including rooms where neither tool is
registered. So a Telegram or headless turn was told to reach for a tool that
does not exist, and pointed at a "below" section that `buildRuntimeToolSection`
does not render without the capability. The `visualSection` sitting directly
beside them was already gated correctly; only these two leaked, because they
lived in `_shared-tools.md` rather than in the gated builder.

The practical cost is a model that either apologizes for a missing tool or
invents a call, in exactly the rooms least able to display the result.

They now render from the same flags that gate the tools, through a
`{{CAPABILITY_TOOL_NOTES}}` placeholder. The placeholder is appended to the end
of the preceding line rather than occupying one of its own, so a room that
grants nothing gets no blank gap in the bullet list.

Nothing to do on upgrade. If you embed Negotium and call the prompt builders
directly, keep passing `visualTools`/`fileDeliveryTools` as you already do —
these bullets now follow those flags instead of ignoring them.

## `publish_html` can still be absent on a granted node, and now says so

This is a documentation and observability fix, not a behaviour change.

`RUNTIME-GATEWAY-CONTRACT.md` claimed `visualTools` alone gates
`publish_html`/`unpublish_html`. It does not. The node builds those tools from
its **own** `NEGOTIUM_SNIPPETS_API_URL`, which the gateway's capability cannot
supply because it is node configuration. A node without one grants the visual
tools and silently omits the publish tools, so the same room offers a different
tool surface depending on which host executed the turn.

The contract now states the real rule, and the node logs a warning when it drops
the tools:

```
negotium MCP: visual tools granted but publish_html omitted;
set NEGOTIUM_SNIPPETS_API_URL on this node to match a hub that has one
```

**Action:** if your gateway has a snippet backend, set
`NEGOTIUM_SNIPPETS_API_URL` on every node behind it. Otherwise expect
`publish_html` to come and go with placement.

The underlying split — that a capability cannot carry the backend — is
deliberately not fixed here. Forwarding the URL over the contract would restore
"same room, same tools" by construction, but it widens the node's trust surface
by making it POST user HTML to a caller-supplied endpoint. That is a contract
change and belongs in its own release.

## Capability inheritance is now tested where it matters

`0.5.7` made adapter-less turns — `triggerTopicAiTurn` for tell/ask, cron,
subagent reports, and config-change auto-continue — inherit the grant the room's
adapter last recorded. Its tests covered only the **write** side, that the row is
recorded. Nothing covered the **read** side, which is what actually decides
whether a scheduled job gets `show_html`.

That resolution was inline in `startAiTurn` and unreachable from a test. It is
now `resolveTurnToolCapabilities(topicId, params)`, exported from
`#runtime/turn-runner` — a pure move, same semantics:

- absence inherits, so an adapter-less turn picks up the room's grant;
- an explicit `false` refuses and is **not** overridden by a stale grant;
- the two capabilities resolve independently;
- a later ungranting turn revokes for adapter-less turns too.

Reverting the inheritance now fails the new test while the two `0.5.7` tests stay
green, which is the gap this closes.
