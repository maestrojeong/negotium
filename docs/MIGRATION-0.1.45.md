# Migration to 0.1.45

Version 0.1.45 reshapes the Wiki memory pipeline into an explicit
`archive → summary → brief` flow, turns the topic brief into an accumulated
persona, and makes the assistant's output language configurable. It also trims
and de-duplicates the session system prompts. No SQLite schema change is
required.

## Pipeline order: archive → summary → brief

The Wiki archiver now saves the immutable session summary first, then updates
the accumulated topic brief last, so the brief step can fold in everything the
session produced.

A new Wiki MCP tool authors the brief:

```text
save_topic_brief(topic, content)
```

It writes `wiki/topic/<title>.md` and mirrors `brief_md` into SQLite (partial
upsert — it leaves `latest_summary_md` / `summary_date` untouched).

`save_wiki_entry` now records only the latest summary (`latest_summary_md` +
`summary_date`) and *backfills* `brief_md` from an existing brief file when one
is present. It never authors a fresh brief and never overwrites an existing
`brief_md` with an empty value — this keeps the empty-session / no-substance
path (which skips `save_topic_brief`) from shadowing a valid legacy id-keyed
brief.

`save_topic_brief` is allowlisted on the canonical (`#General`) Wiki bridge, so
remote/placed archivers can persist briefs as well as summaries.

## Persona topic brief

`wiki/topic/<title>.md` now has two layers:

- **Persona** (accumulated, slow-moving): who the user is, preferred style,
  standing instructions, and recurring intent. The archiver folds each session's
  Preferences / Patterns / recurring Decisions into it and replaces a trait only
  when a new session explicitly supersedes it.
- **Recent Work / Current State** (volatile): refreshed every session.

## Configurable output language

Model-generated prose (topic/channel/manager replies and the archiver's
summaries, briefs, articles, and completion reply) now follows a global setting:

```text
NEGOTIUM_LANG        # e.g. English (default), Korean, ko
NEGOTIUM_MEMORY_LANG # optional: narrow the archiver to a different language
```

`NEGOTIUM_LANG` defaults to **English** and is only a fallback — the assistant
still mirrors whatever language the user writes in. Structural tokens
(frontmatter keys, slugs, index anchors, template section headings) always stay
in English. Fixed system chrome and degraded-path strings emitted directly by
code (e.g. the `#General` hub header) also stay English.

Session and archiver prompts are now English by default; set `NEGOTIUM_LANG` to
restore a localized default.

## Leaner session system prompts

The topic, channel, and manager system prompts were compressed and
de-duplicated (roughly −7 to −8% each) with no functional change:

- The shared Workspace / Uploaded Files / Tool notes block lives in one
  `sessions/_shared-tools.md` partial, injected into the topic and channel
  templates via `{{SHARED_TOOLS}}`.
- Per-tool capability hints were folded into a single `## Tool notes` list.
- Manager-only sections drop guidance already covered by the inherited tool
  notes, keeping cross-topic admin specifics.

No behavior changes: load-bearing constraints, tool names, and prohibitions were
preserved. Runtime-enforced facts that the agent cannot act on (e.g. cron
context rotation) were removed from the prompt.

## orchgraph 0.2.0 (terminal subagent graph)

The terminal adapter upgrades `orchgraph` 0.1.1 → 0.2.0 (backward-compatible;
`layoutTerminalGraph` is unchanged). The subagent graph now caches its laid-out
canvas by structural signature and re-renders live running states through the
new `renderTerminalCanvas` `nodeStates` overlay, so agent-state changes no
longer rerun ELK layout. Running nodes render with the 0.2.0 state glyph.

## Rollback

Rollback to 0.1.44 is safe. Briefs written by `save_topic_brief` remain plain
`wiki/topic/<title>.md` files and title-keyed SQLite rows that 0.1.44 reads
normally; 0.1.44 simply returns to authoring the brief inside its own archive
turn. Unset `NEGOTIUM_LANG` / `NEGOTIUM_MEMORY_LANG` to return to the previous
localized prompt defaults.
