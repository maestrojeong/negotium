# Wiki search evaluation for 0.2.18

This report records the adversarial retrieval evaluation used for the 0.2.18 Wiki memory and
search changes. The evaluator calls the production Wiki MCP implementation; it does not score a
separate search surrogate.

## Search tracks

The evaluator keeps three use cases independent because a good result means something different
for each one:

- **Topic routing** selects a single canonical persona or memory namespace. For example,
  `load my coding-style memory` should adopt the one matching topic, while a query that equally
  matches two topics should adopt neither.
- **Article retrieval** returns multiple evidence documents in relevance order. For example,
  `find the cache invalidation design` may return the primary design, implementation notes, and a
  related decision record, with the strongest evidence first.
- **Summary retrieval** finds session or topic summaries with temporal constraints. For example,
  `persona work summaries after June` should return only the matching summary family after the
  cutoff and order it appropriately.

Topic routing therefore emphasizes safe canonical selection and abstention. Article retrieval
emphasizes graded multi-document recall and ranking. Summary retrieval adds topic/session identity
and temporal interpretation.

## Dataset

The deterministic synthetic corpus contains:

- 1,900 documents, including 1,500 noise documents;
- 168 labeled queries split evenly into 84 development and 84 hidden queries;
- 28 topic, 28 article, and 28 summary queries in each split; and
- 21 adversarial categories, with four examples per category in each split.

The dataset digest is
`809a733e40deedd9615100591a14889216065bbe0bca031a455bed8392508599`.
There are no normalized query duplicates across the development and hidden splits. Hidden reports
contain aggregate metrics only, not queries, labels, expected keys, or returned keys.

Coverage includes:

- topic aliases, paraphrases, typo/spacing variants, near collisions, ambiguity, no-match cases,
  and authorization boundaries;
- article title families, body-only evidence, paraphrases, mixed-language queries, typos,
  unindexed documents, and stale index entries; and
- exact dates, before/after cutoffs, latest-record queries, mixed-language dates, session relevance,
  and within-topic temporal ordering.

## Development split: baseline and candidate

The baseline is repository HEAD `06941c3`. All tracks must independently pass their gates; a strong
article score cannot compensate for unsafe topic routing or weak temporal recall.

| Track and metric | Baseline | 0.2.18 candidate |
| --- | ---: | ---: |
| Topic top-1 accuracy | 0.375 | 1.000 |
| Topic selective accuracy | 0.214 | 1.000 |
| Topic ambiguity rejection | 0.000 | 1.000 |
| Topic no-match false-positive rate | 1.000 | 0.000 |
| Topic wrong adoptions | 22 | 0 |
| Topic authorization leaks | 4 | 0 |
| Article ideal top-1 accuracy | 0.429 | 1.000 |
| Article Recall@3 / Recall@5 | 1.000 / 1.000 | 1.000 / 1.000 |
| Article MRR | 1.000 | 1.000 |
| Article nDCG@5 | 0.850 | 1.000 |
| Article pairwise order accuracy | 0.500 | 1.000 |
| Summary ideal top-1 accuracy | 0.393 | 1.000 |
| Summary Recall@3 / Recall@5 | 0.762 / 0.762 | 1.000 / 1.000 |
| Summary MRR | 0.768 | 1.000 |
| Summary nDCG@5 | 0.693 | 1.000 |
| Summary pairwise order accuracy | 0.488 | 1.000 |

Article Precision@5 is `0.600` for both final splits because each query defines three relevant
documents and the metric uses five result slots; `3 / 5` is the designed maximum.

## Hidden split

The final candidate independently passed every topic, article, and summary gate on all 84 hidden
queries:

| Track | Result | Key aggregate metrics |
| --- | --- | --- |
| Topic | Pass | top-1, selective accuracy, coverage, ambiguity rejection, and adoption accuracy `1.000`; false-positive rate `0`; leaks and wrong adoptions `0` |
| Article | Pass | Recall@3, Recall@5, MRR, nDCG@5, ideal top-1, and pairwise order `1.000`; leaks `0` |
| Summary | Pass | Recall@3, Recall@5, MRR, nDCG@5, ideal top-1, pairwise order, and Precision@5 `1.000`; leaks `0` |

Adapter errors were zero on both splits.

## Scale and latency experiment

Search latency was measured separately from the relevance evaluation against the production Wiki
MCP implementation. The benchmark used deterministic synthetic Markdown only; it did not copy
filenames, text, or structure from a user Wiki. The previous full-scan implementation was measured
at commit `701947e`; the indexed candidate was measured from the `feat/wiki-index-sync` working
tree after the relevance behavior was held constant.

Each corpus contained 70% articles and 30% summaries. A long-lived in-memory MCP client issued ten
queries per track, with one first-track call and nine steady-state calls. Every query retrieved its
expected synthetic target. The reported latency is measured around the MCP tool call and excludes
adapter process startup.

### Indexed steady-state latency

| Total documents | Topic p95 | Article p50 / p95 | Summary p50 / p95 | Process RSS |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.4 ms | 1.6 / 2.3 ms | 4.3 / 5.6 ms | 132 MiB |
| 2,000 | 0.7 ms | 2.4 / 5.8 ms | 4.1 / 5.0 ms | 143 MiB |
| 5,000 | 0.5 ms | 2.5 / 4.7 ms | 4.3 / 5.0 ms | 168 MiB |
| 10,000 | 0.4 ms | 2.6 / 4.9 ms | 4.7 / 6.0 ms | 212 MiB |
| 20,000 | 0.4 ms | 2.8 / 6.5 ms | 4.3 / 5.1 ms | 285 MiB |

At 20,000 documents, article p95 improved from `2.06 s` to `6.5 ms` (about `317x`) and summary p95
improved from `923 ms` to `5.1 ms` (about `181x`). Every benchmark query still retrieved its
expected target.

### Initial index build

| Total documents | First indexed query |
| ---: | ---: |
| 1,000 | 0.91 s |
| 2,000 | 2.32 s |
| 5,000 | 7.96 s |
| 10,000 | 17.10 s |
| 20,000 | 44.38 s |

The harness queries articles first, so that call pays for building the shared article-and-summary
index; whichever indexed query arrives first in production pays the same one-time cost. Initial
construction reads every source document, normalizes it, and writes the derived database. This is
the principal remaining scale limitation. Repeated queries do not reopen source Markdown.

### Index and synchronization design

- Markdown remains the source of truth. `.wiki-search-index.sqlite` is a private, rebuildable cache
  with mode `0600`; it stores normalized document text and an FTS5 term index.
- `article-index.md` remains the human-readable catalog for both articles and source summaries.
  Missing files receive generated rows, generated metadata is refreshed after changes, and manual
  descriptions and sections take precedence. Stale rows remain as tombstones and cannot return a
  missing document.
- Explicit article and summary queries rank matching catalog keys and descriptions first. If the
  synchronized catalog supplies enough candidates for the requested limit, retrieval stops there;
  otherwise the SQLite body/date index fills the remaining result set. Summaries intentionally
  share `article-index.md` rather than maintaining a second Markdown catalog.
- Article and summary source files are read only during initial construction or when path, size, or
  modification time changes. A successful `wiki_query` retrieves and reranks candidates from the
  derived index; `wiki_read` opens only the selected source document.
- Summary rows carry parsed date and family metadata. Date-range candidate selection and latest or
  oldest ordering use database indexes on `(kind, date)` and `(kind, family, date)` before the
  normal relevance scorer applies topic/session constraints.
- Internal Wiki writes invalidate the catalog signal immediately. New, deleted, or renamed files
  are detected through directory modification times. An external in-place content edit that does
  not touch the catalog can be visible up to five seconds later.
- A failed root, subdirectory, or file-stat inventory marks that synchronization pass incomplete.
  Missing rows are then retained from the prior derived generation, and every readable source
  scope is scanned alongside indexed candidates until a complete inventory succeeds.
- Schema mismatch or SQLite corruption removes only the derived database and rebuilds it. If the
  derived index is temporarily unavailable, retrieval falls back to the source scan so correctness
  is preferred over latency.

## Algorithm changes exercised by the evaluation

- Query normalization handles punctuation, spacing, Korean/English mixtures, bounded typo
  tolerance, partial keys, and canonical plural forms.
- Topic routing applies authorization before selection, scores lifecycle-aware collisions,
  exposes near-tied candidates as ambiguous, and never adopts an ambiguous or unauthorized topic.
- Article retrieval verifies backing files, discards stale targets, and merges key, title, index
  description, and indexed body evidence instead of allowing a weak catalog hit to suppress
  document search.
- Summary retrieval filters by topic/session family, parses English and Korean date expressions,
  supports exact/latest/oldest and before/after constraints, and uses date-indexed candidate
  selection before deterministic temporal ordering.
- FTS exact-token candidates are preferred. Key/title trigram candidates are built lazily only when
  exact-token retrieval has no candidates, avoiding an eager fuzzy-index memory and startup cost.
- Stable tie-breaking keeps repeated runs deterministic.

## Repository verification

The candidate also passed the focused Wiki tests, the full core test suite, the workspace build,
Biome, `git diff --check`, release consistency checks for 0.2.18, package dry-run, and packed-install
smoke tests. The smoke test verified declaration/runtime parity for 22 public subpaths.

## Interpretation and limitations

The corpus is synthetic and targets known retrieval and safety failure classes. Perfect scores mean
that the implementation satisfies these deterministic regression cases; they do not establish
perfect performance for arbitrary real-world language or future corpora. Production feedback and
new failure cases should extend the evaluator rather than be inferred from these results.

The derived index duplicates source text, so disk usage grows with the Wiki. Initial construction
is synchronous and expensive at tens of thousands of documents, metadata freshness depends on
filesystem timestamp/size signals, and FTS token retrieval is still followed by the existing
precise scorer rather than a semantic embedding model. A future release should move cold rebuilds
to an explicit prebuild or background maintenance path and add production-shaped latency traces.
