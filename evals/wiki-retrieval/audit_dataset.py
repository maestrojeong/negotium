#!/usr/bin/env python3
"""Audit split balance, leakage, fixture wiring, and corpus integrity.

The previous evaluator's checksum file covered the harness and the reports but
not the corpus, so a tool run against the fixtures silently rewrote them and the
next evaluation measured a contaminated dataset. This audit closes that hole.

The generated corpus is not committed — it is deterministic from the seed — so
integrity is anchored on `expected-digest.txt`, which is. A digest mismatch means
either the fixtures were mutated in place or the generator changed; the second
case is a deliberate edit and the file is updated in the same commit.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATASET = ROOT / "dataset"
CORPUS = DATASET / "corpus"


def normalise(text: str) -> str:
    return " ".join(re.sub(r"[^0-9a-z가-힣]+", " ", text.lower()).split())


def corpus_digest() -> str:
    digest = hashlib.sha256()
    for path in sorted(CORPUS.rglob("*")):
        if path.is_file() and path.name != ".wiki-search-index.sqlite":
            digest.update(path.relative_to(CORPUS).as_posix().encode())
            digest.update(path.read_bytes())
    for path in (DATASET / "public/dev.jsonl", DATASET / "private/hidden.jsonl"):
        digest.update(path.read_bytes())
    return digest.hexdigest()


def catalog_keys(path: Path, namespace: str) -> set[str]:
    if not path.exists():
        return set()
    return set(re.findall(rf"\[\[{namespace}/([^\]]+)\]\]", path.read_text()))


def main() -> None:
    manifest = json.loads((DATASET / "manifest.json").read_text())
    expected_path = ROOT / "expected-digest.txt"
    expected = expected_path.read_text().strip() if expected_path.exists() else None
    dev = [json.loads(line) for line in (DATASET / "public/dev.jsonl").read_text().splitlines()]
    hidden = [json.loads(line) for line in (DATASET / "private/hidden.jsonl").read_text().splitlines()]

    article_rows = catalog_keys(CORPUS / "article-index.md", "articles")
    summary_rows = catalog_keys(CORPUS / "summary-index.md", "summaries")
    article_files = {p.stem for p in (CORPUS / "articles").glob("*.md")}
    summary_files = {p.stem for p in (CORPUS / "summaries").glob("*.md")}

    problems: list[str] = []

    # Balance: every category must hold the same count in both splits.
    dev_categories = Counter(row["category"] for row in dev)
    hidden_categories = Counter(row["category"] for row in hidden)
    if dev_categories != hidden_categories:
        problems.append(f"split imbalance: {dev_categories} vs {hidden_categories}")

    # Leakage: no normalised query may appear in both splits.
    overlap = {normalise(r["query"]) for r in dev} & {normalise(r["query"]) for r in hidden}
    if overlap:
        problems.append(f"query overlap across splits: {sorted(overlap)[:5]}")

    # Fixture wiring must match what each category asserts.
    for row in dev + hidden:
        keys = [doc.split(":", 1)[1] for doc in row["relevance"]]
        penalised = [doc.split(":", 1)[1] for doc in row.get("penalised", [])]
        category = row["category"]
        if category == "body_only":
            for key in keys:
                pool = article_rows if row["track"] == "article" else summary_rows
                if key in pool:
                    problems.append(f"{row['id']}: body_only target {key} must have no catalog row")
        if category == "tombstone":
            for key in penalised:
                files = article_files if row["track"] == "article" else summary_files
                rows = article_rows if row["track"] == "article" else summary_rows
                if key in files:
                    problems.append(f"{row['id']}: tombstone {key} must have no document")
                if key not in rows:
                    problems.append(f"{row['id']}: tombstone {key} must keep its catalog row")
        if category == "catalog_cold":
            for key in keys:
                if key not in article_rows:
                    problems.append(f"{row['id']}: catalog_cold target {key} needs a catalog row")
        if row.get("expect") == "empty" and row["relevance"]:
            problems.append(f"{row['id']}: expect=empty must carry no relevance labels")
        if row.get("expect") == "results" and not row["relevance"]:
            problems.append(f"{row['id']}: expect=results needs at least one relevant document")

    # Every declared scenario must actually be exercised.
    scenarios = Counter(row["scenario"] for row in dev + hidden)
    for scenario in ("indexed", "fresh"):
        if scenarios.get(scenario, 0) == 0:
            problems.append(f"scenario {scenario} has no queries")

    digest = corpus_digest()
    if expected and digest != expected:
        problems.append(
            f"corpus digest {digest} does not match the committed expected digest {expected}: "
            "the fixtures were mutated, or the generator changed and expected-digest.txt needs updating"
        )
    report = {
        "corpus_digest_matches_manifest": digest == manifest["sha256"],
        "corpus_digest_matches_committed_expectation": expected is None or digest == expected,
        "recomputed_corpus_digest": digest,
        "manifest_digest": manifest["sha256"],
        "committed_expected_digest": expected,
        "categories_per_split": dict(sorted(dev_categories.items())),
        "queries_per_scenario": dict(sorted(scenarios.items())),
        "documents": {"articles": len(article_files), "summaries": len(summary_files)},
        "catalog_rows": {"articles": len(article_rows), "summaries": len(summary_rows)},
        "rows_without_document": sorted(article_rows - article_files)[:10],
        "documents_without_row": sorted(article_files - article_rows)[:10],
        "problems": problems,
        "checks": [
            "Both splits hold identical category counts.",
            "No normalised query appears in both splits.",
            "body_only targets carry no catalog row; tombstones carry a row and no document.",
            "expect=empty fixtures declare no relevance; expect=results declare at least one.",
            "Corpus digest is recomputed and compared with the manifest and with expected-digest.txt.",
        ],
    }
    print(json.dumps(report, indent=2, ensure_ascii=False, sort_keys=True))
    raise SystemExit(1 if problems or not report["corpus_digest_matches_manifest"] else 0)


if __name__ == "__main__":
    main()
