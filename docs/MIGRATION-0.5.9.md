# Migration 0.5.9 - show_video is removed

`0.5.9` removes the `show_video` runtime tool. **Breaking for any host that
registered it**, which in practice means a host granting `visualTools`.

## What goes

The tool only. A host that grants `visualTools` now sees `show_html`,
`show_mermaid`, `show_image` (and Otium's `show_png` alias) — no `show_video`.
Calling it returns an unknown-tool error like any other name that does not
exist.

Also gone from the public surface:

- `showVideoTool`, previously re-exported from `negotium/agent-helpers`
- `isVisualsShowVideoTool`

If you import either, delete the import. There is no replacement; a host that
still wants video in a panel can render its own `<video>` inside a `show_html`
document, which is a different and working path.

## What stays

Deliberately, the **creation** path is all that was removed:

- the `video` visual kind, its storage, and its render path are untouched, so a
  card a previous version stored keeps rendering. Those rows age out on their
  own under the 10-per-topic cap.
- `show_image` and the media pipeline the two tools shared are unchanged — the
  media read-back added in `0.5.7` and the file download path behave exactly as
  before. This is not a media rollback.
- the media CSP guidance from `0.5.8` still applies: a `show_html` visual may
  embed its own `<video>`, and an embedding host's renderer policy still needs
  a `media-src` for that to load.

## Why

It was the least-working tool in the set, and nobody was using it. Playback in
the reference Electron host only started working in `0.5.8`, saving the file
produced a uuid for a filename, and it never worked in a plain browser at all.
Carrying three fixes for an unused tool is worse than not having the tool.

## Upgrading

Nothing to do beyond removing any direct import of the two symbols above. No
data migration, no contract change beyond the capability list in
`RUNTIME-GATEWAY-CONTRACT.md`, which no longer names `show_video`.

Hosts that build their own tool list from `otiumVisualToolDefinitions` or
`visualToolDefinitions` get the removal automatically on upgrade. Remove the
matching dispatch **with** the upgrade rather than before it: dropping the
handler while an older package still registers the tool leaves the model able
to call something that silently renders nothing.
