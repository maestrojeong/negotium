---
name: wiki
description: >-
  Wiki memory system — persistent, compounding shared knowledge base.
  Use when the user says "wiki init", "wiki query", "wiki lint",
  "wiki topic-brief", or asks about managing the long-term knowledge base.
argument-hint: init | query <question> | lint | topic-brief <topicName> | remove
---

# Wiki Memory System

Persistent, compounding knowledge base stored in the shared Otium workspace at `wiki/`.
Session summaries are written directly by the wiki-archiver on session close.
Topic briefs are shared by topic and injected at session start for lightweight context.

## Paths

```
STATE_ROOT     = ${OTIUM_STATE_DIR:-apps/runtime-api/.otium}
WORKSPACE_ROOT = ${OTIUM_WORKSPACE_DIR:-$STATE_ROOT/workspace}
WIKI_ROOT      = $WORKSPACE_ROOT/wiki
```

## Directory Layout

```
wiki/
  summaries/              -- session summaries (written by wiki-archiver on session close)
  articles/               -- manually curated concept pages (cross-topic knowledge)
  queries/                -- filed query answers
  topic/                  -- per-topic lightweight briefs (injected at session start)
  skills/                 -- reusable wiki-managed skills
  article-index.md        -- catalog of articles + session summaries (read this FIRST)
  topic-index.md          -- catalog of topic briefs
  skill-index.md          -- catalog of skills
  log.md                  -- append-only operation log
```

## How data flows

```
Session ends
  → wiki-archiver (LLM)
      → saves summary to wiki/summaries/<date>-<topic>.md  (via save_wiki_entry MCP)
      → updates wiki/topic/<topic>.md                (topic brief, via Write)

Session starts
  → wiki/topic/<topicName>.md injected into system prompt (300-600 tokens)

On-demand deep search
  → wiki_query MCP tool searches wiki/summaries/ + articles/
```

## Operations

```
wiki init
wiki query "What design decisions were made for the outbox refactor?"
wiki lint
wiki topic-brief dev
wiki remove
```

---

## `init`

Create the shared wiki scaffold.

### Steps

1. **Check if wiki already exists:**
   If `WIKI_ROOT/` exists and contains `article-index.md` or `topic-index.md`, abort:
   "Wiki already exists at `WIKI_ROOT`. Use `wiki remove` first."

2. **Create directory structure:**
   ```bash
   mkdir -p WIKI_ROOT/summaries
   mkdir -p WIKI_ROOT/articles
   mkdir -p WIKI_ROOT/queries
   mkdir -p WIKI_ROOT/topic
   ```

3. **Write `WIKI_ROOT/article-index.md`** and **`WIKI_ROOT/topic-index.md`** using the templates below.

4. **Write `WIKI_ROOT/log.md`** using the **log.md template** below.

5. **Print:**
   ```
   Wiki initialized at WIKI_ROOT.
   Sessions will auto-populate wiki/summaries/ via wiki-archiver on close.
   Use `wiki topic-brief <topicName>` to create a topic brief manually.
   ```

---

## `query <question>`

Answer a question using wiki knowledge, with citations.

### Steps

1. **Find relevant pages:**
   - Read `WIKI_ROOT/article-index.md` and `WIKI_ROOT/topic-index.md` first.
   - Search `WIKI_ROOT/summaries/*.md` and `WIKI_ROOT/articles/*.md` by keyword match.
   - If a `topic` hint is available, prefer pages with matching `topic` frontmatter.

2. **Read all relevant pages.** Follow one level of `[[wikilinks]]` if targets look relevant.

3. **Synthesize answer** with `[[wikilinks]]` as citations. Format rules:
   - **Default:** prose with inline wikilink citations.
   - **If question contains "table":** markdown table with wikilink citations.

4. **File the answer** to `WIKI_ROOT/queries/<slug>.md` using `query-output` schema. Always file.

5. **Ask:** "Promote this answer to `articles/<slug>.md` as a concept page? (y/n)"
   - If yes: move from `queries/` to `articles/`, update frontmatter `status: filed` → `promoted`,
     append to `log.md`.

6. **Append to `WIKI_ROOT/log.md`:**
   ```
   ## [YYYY-MM-DD] query | <question-slug>
   Answered question. Referenced N pages. Filed to queries/<slug>.md.
   ```

---

## `topic-brief <topicName>`

Generate or update a lightweight topic summary at `WIKI_ROOT/topic/<topicName>.md`.
This file is injected at session start.

### Steps

1. **Find topic-relevant pages:**
   - Scan `WIKI_ROOT/summaries/*.md` for pages where frontmatter `topic: <topicName>` matches.
   - Also check `WIKI_ROOT/articles/*.md` with matching topic.

2. **Synthesize a concise brief** (target: 300–600 tokens):
   ```markdown
   ---
   topic: {topicName}
   updated: YYYY-MM-DD
   type: topic-brief
   ---

   # {topicName} 토픽 브리프

   {1-2 line description}

   ## 최근 작업 ({date})
   - key point 1
   - key point 2

   ## 현재 상태
   - ongoing context

   ## wiki_query 힌트
   `wiki_query("...")`, `wiki_query("...")`
   ```

3. **Write** to `WIKI_ROOT/topic/<topicName>.md` (overwrite if exists).

4. **Append to `WIKI_ROOT/log.md`:**
   ```
   ## [YYYY-MM-DD] topic-brief | <topicName>
   Generated/updated topic brief. N pages referenced.
   ```

---

## `lint`

Audit wiki integrity and fix issues.

### Steps

1. **Read all files** in `WIKI_ROOT/summaries/`, `WIKI_ROOT/articles/`, `WIKI_ROOT/queries/`.

2. **Report and fix:**

   | Check | Action |
   |-------|--------|
   | **Orphan articles** (no inbound links) | List. Suggest linking from related pages. |
   | **Dead links** (`[[wikilinks]]` → nonexistent) | Create stub pages. |
   | **Index drift** | Compare `article-index.md` / `topic-index.md` vs actual files. Add missing, remove dead. |
   | **Old topic briefs** (updated >7d ago) | Flag. Suggest `wiki topic-brief <topic>`. |

3. **Suggest growth opportunities:**
   - 3–5 questions the wiki cannot yet answer
   - 2–3 sources that would strengthen the wiki

4. **Append to `WIKI_ROOT/log.md`:**
   ```
   ## [YYYY-MM-DD] lint | N issues found, M fixed
   <summary>
   ```

---

## `remove`

Delete the wiki and all its contents.

### Steps

1. **Confirm with user:** List directory contents and ask:
   "This will permanently delete the wiki at `WIKI_ROOT`. Proceed? (y/n)"

2. **Remove:**
   ```bash
   rm -rf WIKI_ROOT
   ```

---

## Frontmatter Schemas

### concept / person / decision (articles/)

```yaml
---
date: YYYY-MM-DD
tags: [domain]
type: concept          # concept | person | decision
topic: topicName       # optional — omit if cross-topic
status: active         # active | stale | draft
---
```

### source-summary (summaries/ — session summaries written by wiki-archiver)

```yaml
---
date: YYYY-MM-DD
type: source-summary
topic: topicName
tags: []
---
```

### query-output (queries/)

```yaml
---
date: YYYY-MM-DD
type: query
question: "The original question"
topic: topicName       # optional
informed-by:
  - "[[article-1]]"
status: filed          # filed | promoted
---
```

---

## Integration Notes

### wiki-archiver (automatic)
On session close, `src/core/prompts/agents/wiki-archiver.md` runs and:
1. Reads the session archive `.jsonl`
2. Calls `mcp__wiki__save_wiki_entry(topic, content)` → saves to `wiki/summaries/<date>-<topic>.md` (file naming + dedup handled by MCP)
3. Updates `wiki/articles/<slug>.md` via Write tool (create or merge)
4. Updates `wiki/topic/<topic>.md` (topic brief) via Write tool

No manual `ingest` or `compile` needed — summaries/ is populated automatically.

### Session Start Inject
`wiki/topic/<topicName>.md` is injected into the system prompt (300-600 tokens).
If the brief doesn't exist, no memory is injected (run `wiki topic-brief <name>` to create one).

### On-Demand Query
Use `wiki_query` MCP tool for deep search across summaries/ + articles/.
