#!/usr/bin/env python3
"""Run one split across both scenarios and write independent track reports.

Differences from v2 that change how a number should be read:

* `precision_at_5` is normalised by `min(5, |relevant|)`, so a query with three
  relevant documents can reach 1.0. In v2 the same query was capped at 0.6 and
  every implementation sat on that ceiling, which hid real differences.
* Queries labeled `expect: "empty"` are scored for restraint. Returning anything
  is a false positive, and returning the specific document that must stay hidden
  is counted separately as a leak.
* Fixtures are grouped by scenario. The adapter is launched once per scenario so
  `indexed` and `fresh` states are never mixed in one process.
"""

from __future__ import annotations

import argparse
import json
import math
import shlex
import statistics
import subprocess
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def dcg(ids: list[str], relevance: dict[str, int], k: int) -> float:
    return sum(
        (2 ** relevance.get(doc, 0) - 1) / math.log2(rank + 2)
        for rank, doc in enumerate(ids[:k])
    )


def positive_metrics(rows: list[tuple[dict, dict]]) -> dict:
    """Ranking quality over queries that must return something."""
    recall3, recall5, ndcg5, reciprocal, precision5, top1, pairwise = ([] for _ in range(7))
    leaks = penalised = errors = 0
    for label, output in rows:
        found = output.get("results", [])
        rel = label["relevance"]
        relevant = set(rel)
        leaks += len(set(found) & set(label.get("forbidden", [])))
        penalised += len(set(found[:3]) & set(label.get("penalised", [])))
        errors += int(bool(output.get("error")))
        recall3.append(len(relevant & set(found[:3])) / len(relevant))
        recall5.append(len(relevant & set(found[:5])) / len(relevant))
        ideal = [doc for doc, _ in sorted(rel.items(), key=lambda item: (-item[1], item[0]))]
        ndcg5.append(dcg(found, rel, 5) / dcg(ideal, rel, 5))
        rank = next((i + 1 for i, doc in enumerate(found) if doc in relevant), None)
        reciprocal.append(0.0 if rank is None else 1.0 / rank)
        # Normalised: a query with three relevant documents can reach 1.0.
        precision5.append(len(relevant & set(found[:5])) / min(5, len(relevant)))
        top1.append(float(bool(found) and found[0] == ideal[0]))
        pairs = total = 0
        positions = {doc: i for i, doc in enumerate(found)}
        for better in relevant:
            for worse in relevant:
                if rel[better] <= rel[worse]:
                    continue
                total += 1
                if better in positions and (worse not in positions or positions[better] < positions[worse]):
                    pairs += 1
        pairwise.append(pairs / total if total else top1[-1])
    return {
        "recall_at_3": mean(recall3),
        "recall_at_5": mean(recall5),
        "ndcg_at_5": mean(ndcg5),
        "mrr": mean(reciprocal),
        "precision_at_5_normalised": mean(precision5),
        "ideal_top1_accuracy": mean(top1),
        "pairwise_order_accuracy": mean(pairwise),
        "authorization_leaks": leaks,
        "penalised_in_top3": penalised,
        "adapter_errors": errors,
        "query_count": len(rows),
    }


def restraint_metrics(rows: list[tuple[dict, dict]]) -> dict:
    """Restraint over queries that must return nothing."""
    if not rows:
        return {"query_count": 0, "false_positive_rate": 0.0, "hidden_document_leaks": 0, "adapter_errors": 0}
    false_positives = sum(bool(output.get("results")) for _, output in rows)
    leaks = sum(
        len(set(output.get("results", [])) & set(label.get("penalised", []) + label.get("forbidden", [])))
        for label, output in rows
    )
    return {
        "query_count": len(rows),
        "false_positive_rate": false_positives / len(rows),
        "hidden_document_leaks": leaks,
        "adapter_errors": sum(bool(output.get("error")) for _, output in rows),
    }


def topic_metrics(rows: list[tuple[dict, dict]]) -> dict:
    selectable = [pair for pair in rows if pair[0].get("outcome") == "selected"]
    ambiguous = [pair for pair in rows if pair[0].get("outcome") == "ambiguous"]
    restrained = [pair for pair in rows if pair[0].get("outcome") == "no_match"]
    selected_outputs = [pair for pair in rows if pair[1].get("outcome") == "selected"]
    correct = sum(out.get("canonical") == label.get("canonical") for label, out in selectable)
    selected_correct = sum(
        label.get("outcome") == "selected" and out.get("canonical") == label.get("canonical")
        for label, out in selected_outputs
    )
    wrong = sum(
        out.get("outcome") == "selected" and out.get("canonical") != label.get("canonical")
        for label, out in rows
    )
    abstain = sum(label.get("outcome") == "selected" and out.get("outcome") != "selected" for label, out in rows)
    return {
        "top1_accuracy": correct / len(selectable) if selectable else 0.0,
        "selective_accuracy": selected_correct / len(selected_outputs) if selected_outputs else 0.0,
        "coverage": sum(out.get("outcome") == "selected" for _, out in selectable) / len(selectable) if selectable else 0.0,
        "ambiguity_rejection": sum(out.get("outcome") == "ambiguous" for _, out in ambiguous) / len(ambiguous) if ambiguous else 0.0,
        "restraint_false_positive_rate": sum(bool(out.get("results")) for _, out in restrained) / len(restrained) if restrained else 0.0,
        "authorization_leaks": sum(
            len(set(out.get("results", [])) & set(label.get("forbidden", []))) for label, out in rows
        ),
        "wrong_selections": wrong,
        "abstentions_on_selectable": abstain,
        "weighted_routing_loss": (5 * wrong + abstain) / len(rows) if rows else 0.0,
        "adapter_errors": sum(bool(out.get("error")) for _, out in rows),
        "query_count": len(rows),
    }


# Categories the lexical design claims to serve. Aggregate gates are computed
# over these only.
SUPPORTED = {
    "graded_family", "typo", "body_only", "catalog_cold",
    "recency", "date_exact", "range_before",
    "exact_key", "description", "ambiguous",
}
# Categories that cannot be solved by lexical matching: the query shares no token
# with the target. They are measured and reported, never gated, because gating
# them would keep the suite permanently red without telling anyone anything new.
KNOWN_LIMITATIONS = {"paraphrase", "crosslingual"}

GATES = {
    "article": lambda m, r: {
        "recall_at_3_gte_0_70": m["recall_at_3"] >= 0.70,
        "ndcg_at_5_gte_0_70": m["ndcg_at_5"] >= 0.70,
        "mrr_gte_0_75": m["mrr"] >= 0.75,
        "normalised_precision_gte_0_70": m["precision_at_5_normalised"] >= 0.70,
        "restraint_fpr_lte_0_10": r["false_positive_rate"] <= 0.10,
        "hidden_document_zero_leaks": r["hidden_document_leaks"] == 0,
        "adapter_zero_errors": m["adapter_errors"] + r["adapter_errors"] == 0,
    },
    "summary": lambda m, r: {
        "recall_at_3_gte_0_70": m["recall_at_3"] >= 0.70,
        "ndcg_at_5_gte_0_70": m["ndcg_at_5"] >= 0.70,
        "mrr_gte_0_75": m["mrr"] >= 0.75,
        "temporal_pairwise_order_gte_0_70": m["pairwise_order_accuracy"] >= 0.70,
        "restraint_fpr_lte_0_10": r["false_positive_rate"] <= 0.10,
        "hidden_document_zero_leaks": r["hidden_document_leaks"] == 0,
        "adapter_zero_errors": m["adapter_errors"] + r["adapter_errors"] == 0,
    },
}


def report(track: str, positives: list, negatives: list, split: str, baseline: dict | None) -> dict:
    supported = [pair for pair in positives if pair[0]["category"] in SUPPORTED]
    limited = [pair for pair in positives if pair[0]["category"] in KNOWN_LIMITATIONS]
    if track == "topic":
        metrics = topic_metrics(supported + negatives)
        gates = {
            "top1_accuracy_gte_0_80": metrics["top1_accuracy"] >= 0.80,
            "selective_accuracy_gte_0_90": metrics["selective_accuracy"] >= 0.90,
            "coverage_gte_0_75": metrics["coverage"] >= 0.75,
            "ambiguity_rejection_gte_0_75": metrics["ambiguity_rejection"] >= 0.75,
            "restraint_fpr_lte_0_10": metrics["restraint_false_positive_rate"] <= 0.10,
            "authorization_zero_leaks": metrics["authorization_leaks"] == 0,
            "wrong_selections_zero": metrics["wrong_selections"] == 0,
            "adapter_zero_errors": metrics["adapter_errors"] == 0,
        }
        restraint = {}
    else:
        metrics = positive_metrics(supported)
        restraint = restraint_metrics(negatives)
        gates = GATES[track](metrics, restraint)

    # Measured but ungated. A baseline comparison is what protects these from
    # silent regression, since their absolute level is expected to be low.
    limitations = positive_metrics(limited) if limited else {}
    if baseline and limitations:
        previous = baseline.get(track, {}).get("known_limitations", {})
        gates["known_limitations_not_regressed"] = all(
            limitations.get(key, 0.0) >= previous.get(key, 0.0) - 0.05
            for key in ("recall_at_3", "ndcg_at_5", "mrr")
        )

    per_category: dict[str, dict] = {}
    grouped: dict[str, list] = defaultdict(list)
    for pair in positives:
        grouped[pair[0]["category"]].append(pair)
    for category, pairs in sorted(grouped.items()):
        per_category[category] = (
            topic_metrics(pairs) if track == "topic" else positive_metrics(pairs)
        )
    negative_grouped: dict[str, list] = defaultdict(list)
    for pair in negatives:
        negative_grouped[pair[0]["category"]].append(pair)
    for category, pairs in sorted(negative_grouped.items()):
        per_category[category] = restraint_metrics(pairs)

    failures = []
    for label, out in positives + negatives:
        found = out.get("results", [])
        if label.get("expect") == "empty":
            bad = bool(found)
        elif track == "topic":
            bad = out.get("outcome") != label.get("outcome") or (
                label.get("outcome") == "selected" and out.get("canonical") != label.get("canonical")
            )
        else:
            bad = not found or found[0] not in label["relevance"]
        bad = bad or bool(out.get("error")) or bool(set(found) & set(label.get("forbidden", [])))
        if bad:
            failure = {"id": label["id"], "category": label["category"], "result_count": len(found)}
            if split == "dev":
                failure.update({"query": label["query"], "expected": label, "observed": out})
            failures.append(failure)

    return {
        "schema_version": 3,
        "track": track,
        "split": split,
        "gated_categories": sorted({pair[0]["category"] for pair in supported}),
        "metrics": metrics,
        "restraint": restraint,
        "known_limitations": limitations,
        "per_category": per_category,
        "gates": gates,
        "accepted": all(gates.values()),
        "failed_queries": failures,
    }


def run_adapter(template: str, scenario: str, labels: list[dict]) -> dict[str, dict]:
    command = template.replace("{scenario}", scenario)
    process = subprocess.Popen(
        shlex.split(command), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True,
    )
    assert process.stdin and process.stdout and process.stderr
    for label in labels:
        process.stdin.write(json.dumps(
            {"id": label["id"], "query": label["query"], "track": label["track"],
             "adopt": label["category"] == "exact_key"}, ensure_ascii=False) + "\n")
    process.stdin.close()
    outputs = [json.loads(line) for line in process.stdout if line.strip()]
    stderr = process.stderr.read()
    code = process.wait()
    if code or len(outputs) != len(labels):
        raise RuntimeError(
            f"adapter failed for scenario={scenario}: exit={code}, "
            f"expected={len(labels)}, got={len(outputs)}\n{stderr[-4000:]}"
        )
    return {row["id"]: row for row in outputs}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", choices=("dev", "hidden"), default="dev")
    parser.add_argument("--adapter", required=True, help="command containing a {scenario} placeholder")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, help="baseline.json to gate known limitations against")
    args = parser.parse_args()
    baseline = json.loads(args.baseline.read_text()) if args.baseline and args.baseline.exists() else None

    manifest = json.loads((ROOT / "dataset/manifest.json").read_text())
    label_path = ROOT / "dataset" / ("public/dev.jsonl" if args.split == "dev" else "private/hidden.jsonl")
    labels = [json.loads(line) for line in label_path.read_text().splitlines()]

    outputs: dict[str, dict] = {}
    for scenario in ("indexed", "fresh"):
        scoped = [label for label in labels if label["scenario"] == scenario]
        if scoped:
            outputs.update(run_adapter(args.adapter, scenario, scoped))

    args.output_dir.mkdir(parents=True, exist_ok=True)
    reports = {}
    for track in ("topic", "article", "summary"):
        rows = [(label, outputs[label["id"]]) for label in labels if label["track"] == track]
        positives = [pair for pair in rows if pair[0].get("expect") != "empty"]
        negatives = [pair for pair in rows if pair[0].get("expect") == "empty"]
        track_report = report(track, positives, negatives, args.split, baseline)
        track_report["dataset_sha256"] = manifest["sha256"]
        reports[track] = track_report
        (args.output_dir / f"{track}.json").write_text(
            json.dumps(track_report, indent=2, sort_keys=True, ensure_ascii=False) + "\n")

    run = {
        "schema_version": 3,
        "split": args.split,
        "dataset_sha256": manifest["sha256"],
        "tracks": {
            track: {"accepted": r["accepted"], "metrics": r["metrics"],
                    "restraint": r["restraint"], "known_limitations": r["known_limitations"],
                    "gated_categories": r["gated_categories"], "gates": r["gates"]}
            for track, r in reports.items()
        },
        "accepted": all(r["accepted"] for r in reports.values()),
        "aggregation_policy": "all tracks must independently pass; no compensation",
    }
    (args.output_dir / "run.json").write_text(json.dumps(run, indent=2, sort_keys=True) + "\n")
    print(json.dumps(run, indent=2, sort_keys=True))
    raise SystemExit(0 if run["accepted"] else 2)


if __name__ == "__main__":
    main()
