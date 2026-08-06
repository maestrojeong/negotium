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
MCP implementation at commit `701947e`. The benchmark used deterministic synthetic Markdown only;
it did not copy filenames, text, or structure from a user Wiki.

Each corpus contained 70% articles and 30% summaries. A long-lived in-memory MCP client issued ten
queries per track, with one first-track call and nine steady-state calls. Every query retrieved its
expected synthetic target. The reported latency is measured around the MCP tool call and excludes
adapter process startup.

### Steady-state p95 latency

| Total documents | Topic | Article | Summary | Process RSS |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.8 ms | 108 ms | 17 ms | 171 MiB |
| 2,000 | 1.0 ms | 219 ms | 112 ms | 174 MiB |
| 5,000 | 7.6 ms | 525 ms | 245 ms | 198 MiB |
| 10,000 | 3.4 ms | 1.06 s | 492 ms | 273 MiB |
| 20,000 | 5.6 ms | 2.06 s | 923 ms | 335 MiB |

Topic routing remains fast because a confident candidate can be resolved from the topic index.
Article and summary latency grows approximately linearly because those tracks scan and score all
Markdown files in the selected kind. The different article and summary slopes also reflect the
70/30 corpus split.

### First call per track

| Total documents | Article | Summary |
| ---: | ---: | ---: |
| 1,000 | 263 ms | 47 ms |
| 2,000 | 639 ms | 498 ms |
| 5,000 | 3.90 s | 1.81 s |
| 10,000 | 7.45 s | 5.45 s |
| 20,000 | 18.20 s | 9.56 s |

First-call measurements include initial filesystem reads, operating-system cache state, and JIT
effects, so they are more variable than steady-state measurements. They nevertheless show that
full document scans are not a scalable terminal architecture.

The 0.2.18 candidate prioritizes correctness and safe routing. A generic follow-up should preserve
Markdown as the source of truth while caching normalized document metadata and term frequencies per
Wiki root, invalidating internal writes immediately, and incrementally refreshing externally
changed files by identity, size, and modification time. Authorization must remain request-scoped
rather than being embedded in a shared corpus cache. An inverted index is appropriate only after
the snapshot cache is measured at larger scales.

## Algorithm changes exercised by the evaluation

- Query normalization handles punctuation, spacing, Korean/English mixtures, bounded typo
  tolerance, partial keys, and canonical plural forms.
- Topic routing applies authorization before selection, scores lifecycle-aware collisions,
  exposes near-tied candidates as ambiguous, and never adopts an ambiguous or unauthorized topic.
- Article retrieval verifies backing files, discards stale targets, and merges key, title, index
  description, and term-frequency body evidence instead of allowing a weak index hit to suppress
  document search.
- Summary retrieval filters by topic/session family, parses English and Korean date expressions,
  supports exact/latest/oldest and before/after constraints, and applies temporal ordering after
  index and document evidence are merged.
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

## Addendum: write-time indexing

The evaluation above measured an implementation that read the content directories during retrieval.
That cost grows with the size of the wiki, and rescanning was also being used to repair catalogs that
a two-step write had left incomplete.

Both problems are now addressed at the write boundary instead:

- `wiki_write` writes the document, its catalog row, and the derived body cache in one call. A
  document that no catalog knows about cannot be produced through the tool surface.
- Retrieval matches catalog rows first, then fills remaining slots from the derived cache. It never
  walks `articles/` or `summaries/`, so query cost no longer tracks corpus size.
- `.wiki-search-index.sqlite` stays a disposable cache: deleting it degrades retrieval to catalogs
  only, and `wiki_reindex` rebuilds it.
- `wiki_reindex` is the single scanning path and runs only when asked. It also reports documents that
  have no catalog row, which is the cheap invariant check that replaces scan-on-query repair.

Documents added outside `wiki_write` — dropped into a folder by hand — are deliberately invisible to
retrieval until a reindex. That is the accepted trade for removing per-query discovery.
