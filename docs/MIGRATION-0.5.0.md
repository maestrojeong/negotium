# Migration 0.5.0 - chronological decision graph and Browser.rs 0.1.23

`0.5.0` changes the Terminal decision-graph rendering and pins a new Browser.rs release. No manual
data migration is required.

## Changes

- The Terminal decision graph now renders decisions in chronological order. Decisions that are not
  connected by a `causedBy` path previously rendered in nondeterministic order, because ELK's layered
  layout can resequence causally disconnected components. A dashed `sequence` edge now threads each
  disconnected component onto the chronological spine so the graph reads top-to-bottom in time order
  without implying a causal relationship.
- Decision cards are capped at a narrower width so graphs with a handful of nodes stay within a
  typical terminal width, and the graph legend glyphs match the real node status icons.
- Browser.rs is pinned to `v0.1.23` (the release tested with this Negotium version).

## Rollout

Upgrade the `negotium` package and restart the node. Upgrade `@negotium/adapter-sdk` to `0.5.0` only
in projects that import the public adapter SDK directly.

The Browser.rs binary is re-downloaded and verified against the new SHA-256 digests on the next
install or `postinstall` run.
