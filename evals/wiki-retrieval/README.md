# Wiki Search Evaluator v3

Deterministic evaluation of this repository's `wiki_query` implementation against the write-time
architecture introduced in `0.2.19`. The harness drives the real MCP server in-process and only ever
reads from `packages/`; it never writes outside this directory.

The generated corpus and reports are **not committed** — `generate_dataset.py` is deterministic from
a fixed seed, so 1,296 fixture files would be redundant history. `expected-digest.txt` is committed
instead, and `audit_dataset.py` fails when the regenerated corpus does not match it. That is what
catches fixtures being mutated in place, which is how the previous evaluator was silently
contaminated.

## Why the previous evaluator was replaced

It was built for an architecture where retrieval discovered documents by scanning the content
directories. Measuring `0.2.19` with it produced `1.000` on almost every metric across both splits,
which was not a result — it was a broken instrument. Three specific defects:

| Defect | Consequence |
| --- | --- |
| `precision_at_5` divided by 5 while every query had exactly 3 relevant documents | Hard-capped at `0.6`; every implementation sat on the cap, hiding all differences |
| The `unindexed` category assumed "absent from the catalog" implied "hard to find" | `wiki_reindex` puts every on-disk document in the body index, so the gate passes by construction |
| `checksums.sha256` covered the harness and reports but not the corpus | A tool run rewrote `article-index.md`, adding 24 `unindexed-*` rows with descriptions generated from the bodies. The contamination went unnoticed |

All three are fixed here. v3 also refuses to gate what the design cannot do, instead of pretending.

## Design

**Scenarios.** What a query can find now depends on how the document entered the wiki, so fixtures
are labeled per scenario and the adapter is launched once per scenario.

| Scenario | State | Asserts |
| --- | --- | --- |
| `indexed` | `wiki_reindex` run once | Everything on disk is retrievable, tombstones are not |
| `fresh` | derived cache deleted, never rebuilt | Catalog retrieval still answers; body-only documents must **not** be found |

**Negative fixtures are first class.** A query labeled `expect: "empty"` is scored for restraint:
returning anything at all is a false positive, and returning the specific document that must stay
hidden is counted separately as a leak. `tombstone` and `body_only_fresh` exist only to be missed.

**Normalised precision.** `precision_at_5_normalised = |relevant ∩ top5| / min(5, |relevant|)`, so a
three-document query can reach `1.0`.

**Gated vs. known limitations.** `paraphrase` and `crosslingual` queries share no token with their
target by construction — a lexical ranker cannot solve them without embeddings. They are measured
and reported but never gated, because a permanently red suite carries no signal. `--baseline`
protects them from silent regression instead: a metric may not fall more than `0.05` below the
recorded baseline.

## Tracks and categories

| Track | Gated categories | Ungated | Negative |
| --- | --- | --- | --- |
| `article` | `graded_family`, `typo`, `body_only`, `catalog_cold` | `paraphrase`, `crosslingual` | `tombstone`, `body_only_fresh` |
| `summary` | `recency`, `date_exact`, `range_before`, `body_only` | `paraphrase` | `tombstone`, `body_only_fresh` |
| `topic` | `exact_key`, `description`, `ambiguous` | — | `no_match`, `authorization` |

`graded_family` includes a lexical decoy that shares the target's title tokens; it is tracked as
`penalised_in_top3` rather than a hard failure. Each track is gated independently with no
cross-track compensation.

## Reproduce

```sh
cd evals/wiki-retrieval
python3 generate_dataset.py     # deterministic; writes dataset/
python3 audit_dataset.py        # balance, leakage, fixture wiring, digest

python3 evaluate.py --split dev --baseline baseline.json \
  --adapter "bun mcp_adapter.ts --scenario={scenario}" --output-dir reports/dev

python3 evaluate.py --split hidden --baseline baseline.json \
  --adapter "bun mcp_adapter.ts --scenario={scenario}" --output-dir reports/hidden
```

The adapter defaults to this repository and `dataset/corpus`; pass `--repo` to measure a different
checkout, which is how two implementations are compared on identical fixtures.

The `{scenario}` placeholder is required; the evaluator substitutes it per scenario. Rejection is
exit status `2`; adapter or fixture failures raise. Regenerating the dataset is idempotent for a
fixed seed, so a digest mismatch in `audit_dataset.py` means the fixtures were mutated.

## Baseline — negotium 0.2.19

`baseline.json` records the dev-split measurement of `b5fd632` plus release prep. Update it in the
same commit as any deliberate retrieval change, and state why in the message.

| Track | Metric | dev | hidden |
| --- | --- | --- | --- |
| article | Recall@3 (gated) | 0.958 | 0.917 |
| article | nDCG@5 (gated) | 0.993 | — |
| article | paraphrase + crosslingual Recall@3 | 0.000 | 0.000 |
| summary | Recall@3 (gated) | 1.000 | 1.000 |
| summary | temporal pairwise order | 1.000 | 1.000 |
| topic | top-1 / ambiguity rejection | 1.000 | 1.000 |
| all | restraint FPR, hidden-document leaks | 0.0 / 0 | 0.0 / 0 |

Both splits pass every gate, and the two splits differ (`0.958` vs `0.917`), so the suite still has
headroom to move — that is the property v2 had lost.

The `0.000` on semantic categories is the honest ceiling of a lexical ranker: FTS tokens plus
key/title/description scoring cannot bridge "roll back the deployment" to "revert a release", or an
English body to a Korean query. Closing that needs embeddings, which the current design does not
have. It is recorded so the cost of adding them can be measured.

## Known gaps in this evaluator

- The corpus is synthetic. Noise documents are generated from a small vocabulary, so absolute
  difficulty is lower than a real wiki with 129 dense articles.
- `wiki_write` contract violations (missing description, path traversal, `index_upsert` inventing a
  row) are covered by repository unit tests, not here. This evaluator only measures retrieval.
- The `fresh` scenario deletes the cache but does not simulate a partial cache, which is the state a
  crash between the document write and the index write would leave.
