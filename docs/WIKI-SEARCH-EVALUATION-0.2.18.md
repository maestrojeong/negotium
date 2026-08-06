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
