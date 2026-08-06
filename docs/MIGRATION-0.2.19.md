# Migration 0.2.19 — one wiki write tool

`0.2.19` replaces the two wiki write tools with a single `wiki_write` and gives summaries their own
catalog. Upgrade a hub and its workers together: an Otium hub still on `0.2.18` will call a tool the
worker no longer exposes.

## Removed and added tools

| Before (`≤ 0.2.18`) | After (`0.2.19`) |
| --- | --- |
| `save_wiki_entry(topic, content)` | `wiki_write(kind="summary", topic, content, description)` |
| `save_topic_brief(topic, content)` | `wiki_write(kind="topic", topic, content, description)` |
| raw `Write` into `wiki/articles/` | `wiki_write(kind="article", slug, section, content, description)` |
| — | `wiki_reindex()` |

`index_upsert` survives with a narrower contract: it corrects the description or section of an entry
that already exists and refuses to create a row for a document that was never written. Use
`wiki_write` to create entries.

`description` is now required on every write and is validated: it must be non-empty and is collapsed
to a single line. A write with no description fails rather than producing a catalog row that says
nothing.

## Why

Writing a document and indexing it used to be two separate calls, and the archiver held a raw
`Write` tool for articles. Skipping the second call left a document that no catalog knew about, and
retrieval could not find it. `wiki_write` performs both writes in one call and reports a partial
write as an error, so the tool surface — not prompt discipline — is what keeps documents and
catalogs in step.

## New catalog layout

```
wiki/
  summaries/<date>-<topic>.md   -> summary-index.md   (new)
  articles/<slug>.md            -> article-index.md
  topic/<topic>.md              -> topic-index.md
  .wiki-search-index.sqlite     -> derived body-search cache
```

Summaries previously shared `article-index.md`. Existing `[[summaries/...]]` rows are **not**
relocated automatically in this release: move them into `summary-index.md` once, or leave them and
run `wiki_reindex` to see which documents lack a row in their owning catalog.

## Retrieval no longer scans the wiki

`wiki_query` matches catalog rows first and fills the remainder from the derived SQLite index. It no
longer reads every file under `articles/` and `summaries/`, so query cost stops tracking corpus size.
The write path keeps the index current.

Two consequences to plan for:

- A document added outside `wiki_write` — dropped into a folder by hand — is invisible to retrieval
  until `wiki_reindex` runs. This is deliberate: per-query discovery was removed.
- Deleting `.wiki-search-index.sqlite` is safe. Catalog retrieval keeps working and `wiki_reindex`
  refills the bodies. Note that a query recreates the file empty, so the file existing does not by
  itself mean the cache is populated.

## Upgrade steps

1. Upgrade the worker and any Otium hub that talks to it in the same window.
2. Restart the runtime so the new tool list is served.
3. Run `wiki_reindex` once per wiki. It reports `<n> rows for <n> documents` per catalog and names
   any document missing a row.
4. If you carry summaries in `article-index.md` from an earlier release, move those rows into
   `summary-index.md`.

## Agents that write the wiki

The bundled archiver prompt no longer has a `Write` tool. Custom agents that wrote wiki files
directly must switch to `wiki_write`; a file written by any other means will not be indexed.
