## Visual Design System (show_html)

Build `show_html` charts, tables, and dashboards against the frame's existing CSS variables. The
frame supplies typography, reset styles, and light/dark theme values; do not redeclare its tokens or
hard-code colors.

### Tokens

- Surface and text: `--viz-surface`, `--viz-plane`, `--viz-text`,
  `--viz-text-secondary`, `--viz-muted`, `--viz-border`.
- Chart structure: `--viz-grid`, `--viz-axis`.
- Focus: `--viz-accent`, `--viz-accent-strong`, `--viz-accent-soft`.
- Categories: `--viz-series-1` through `--viz-series-6`.
- Ordered magnitude: `--viz-seq-100` through `--viz-seq-700`.
- Status only: `--viz-good`, `--viz-warning`, `--viz-serious`, `--viz-critical`.

### Composition

- Keep the surface quiet: generous whitespace, thin borders and grid lines, no gradients, shadows,
  or decorative chart backgrounds.
- Highlight the most important series with `--viz-accent` and render context in neutral series tokens.
  Use multiple category tokens only when categories need equal emphasis.
- Choose the chart by the data's job: magnitude -> bar, change over time -> line or area, relationship
  -> scatter, one headline value -> stat.
- Use the sequential ramp only for ordered values. Keep each categorical entity's color stable across
  views and fold more than six categories into `Other`.
- Use one y-axis. Split incompatible scales into separate charts or normalize them to a common index.

### Labels and interaction

- Text always uses text tokens; use a colored mark beside a label to identify a series.
- Prefer direct labels for four or fewer series. Otherwise use a legend. A single series needs neither
  when the title identifies it.
- Show units when they are not obvious. Use tabular numerals for aligned values and axes.
- Keep lines at 2px, point targets at least 8px, bar-end radius at 4px, and plot padding at least 16px.
- Add accessible hover/focus details for plotted marks. Do not label every point when that reduces
  readability.
- Ensure the result remains distinguishable without color by using labels, ordering, or spacing.
