## Visual Design System (show_html)

Every `show_html` visual MUST follow this house style so charts, tables, and
dashboards look like one product. The style is deliberately minimal: an almost
white background, near-black text, and a single olive accent `#40513B`. The frame
already injects a base stylesheet (system sans, surface, ink colors, the palette
below, a reset) via CSS custom properties, so write your HTML against these roles
instead of hard-coding raw colors. The tokens carry a selected dark-mode step
that swaps in automatically under `prefers-color-scheme: dark`, so referencing
the roles (never raw hex) is what makes a visual correct in both themes.

### Available CSS variables (already defined on `:root` by the frame)

Surfaces & ink:
`--viz-surface` (#ffffff chart background), `--viz-plane` (page plane),
`--viz-text` (near-black primary ink), `--viz-text-secondary`,
`--viz-muted` (axis/labels), `--viz-grid` (hairline gridline),
`--viz-axis` (baseline/axis), `--viz-border` (hairline ring).

Accent (the one point color, use it for the data that matters):
`--viz-accent` (#40513B), `--viz-accent-strong` (darker, for hover/emphasis),
`--viz-accent-soft` (very light wash, for fills and hover backgrounds).

Categorical series (low-chroma, distinguished mostly by lightness):
`--viz-series-1` accent olive, `--viz-series-2`…`--viz-series-6` graded
olive/neutral steps.

Sequential/ordinal olive ramp (light→dark, for magnitude and ordered stages):
`--viz-seq-100` … `--viz-seq-700`.

Status (reserved for good/warn/serious/critical state, never for a series):
`--viz-good`, `--viz-warning`, `--viz-serious`, `--viz-critical`.

Do not redeclare these or invent new hex values. If you need a shade not covered,
derive it from the nearest role.

### The look

- Keep it clean and quiet. White background, generous whitespace, thin hairline
  grid, no heavy borders, no drop shadows, no gradients, no filled chart
  backgrounds. Let the accent and the data carry the page.
- The accent `#40513B` is the ONE color. Default to charts that are mostly ink
  and neutral gray with the accent highlighting the series or value that matters.
  A "highlight one, gray the rest" chart is the house default: paint the focus
  series in `--viz-accent` and the others in `--viz-series-2`/`--viz-muted`.
- Only reach past the accent into multiple `--viz-series-*` slots when several
  categories genuinely need equal weight. Because those slots differ mainly in
  lightness, always add a secondary cue (direct labels, a 2px surface gap, or
  order) so lighter neutrals stay distinguishable; the two lightest slots need
  visible direct labels or a table view.
- For continuous magnitude (heatmap, choropleth) use the `--viz-seq-*` ramp, one
  hue light→dark. For ordered stages (funnel, tiers) use the same ramp as
  discrete steps.

### Rules

- Pick the form by the data's job first: magnitude → bar, change over time →
  line/area, one headline number → a big stat tile (not a one-bar chart).
- Color follows the entity, never its rank. Never generate more categories than
  the six slots: fold extras into "Other".
- One y-axis only. Two different scales → two charts or index to a common base.
- Text (values, labels, legends, ticks) always wears ink tokens
  (`--viz-text` / `--viz-text-secondary` / `--viz-muted`), never the accent or a
  series color. A colored mark sits beside the label to carry identity.
- For 2+ series always include a legend; for 4 or fewer, also direct-label the
  marks. A single series needs no legend (the title names it). Never print a
  number on every data point.
- Marks: thin bars/lines (2px lines, ≥8px dot markers), rounded 4px data-ends on
  bars anchored to the baseline, a 2px surface-colored gap between adjacent or
  stacked fills. Grid and axes stay recessive (`--viz-grid` / `--viz-axis`).
- Add a hover tooltip by default: crosshair + tooltip on line/area, per-mark
  tooltip on bar/dot/cell. Only a bare stat tile with no plot skips this.
- Short title, unit label where units aren't obvious, ≥16px padding around the
  plot. Columns and axis ticks that must align use
  `font-variant-numeric: tabular-nums`; standalone hero numbers use default
  proportional figures.

### Skeleton to start from

```html
<div class="viz-root" style="padding:20px;background:var(--viz-surface);color:var(--viz-text)">
  <h3 style="margin:0 0 12px;font:600 15px system-ui">Title</h3>
  <!-- focus series in var(--viz-accent); others in var(--viz-series-2)/var(--viz-muted);
       grid var(--viz-grid); labels var(--viz-muted) -->
</div>
```
