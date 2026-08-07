#!/usr/bin/env python3
"""Build the v3 corpus and labeled splits deterministically.

v3 differs from v2 in three ways that matter for the write-time architecture:

1. Retrieval behaviour depends on how a document entered the wiki, so fixtures
   are labeled per scenario. `indexed` runs after `wiki_reindex`; `fresh` runs
   with no derived cache at all. A body-only document must be found in the first
   and must be absent in the second.
2. Negative fixtures are first class. Tombstoned rows and never-indexed
   documents carry `expect: "empty"`, so a run is penalised for inventing a hit
   rather than only for missing one.
3. Hard cases are handwritten instead of generated. Paraphrase and cross-lingual
   queries share no tokens with the target, which a lexical ranker cannot solve
   by construction. They exist to measure the real ceiling, not to be gamed.
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATASET = ROOT / "dataset"
CORPUS = DATASET / "corpus"
SEED = 20260806
# Noise volume is overridable so retrieval cost can be measured against corpus
# size. The labeled fixtures are unchanged, so scores stay comparable while the
# document count moves.
NOISE_SCALE = int(os.environ.get("WIKI_EVAL_NOISE_SCALE", "1"))
NOISE_ARTICLES = 420 * NOISE_SCALE
NOISE_SUMMARIES = 420 * NOISE_SCALE
NOISE_TOPICS = 300 * NOISE_SCALE

# Handwritten hard cases: the query shares no content token with the document.
PARAPHRASE = [
    ("roll back the deployment when the canary regresses", "revert a release after a bad staged rollout"),
    ("drop the lease before awaiting the terminal channel", "release ownership prior to blocking on completion"),
    ("collapse eight server processes into one runtime", "merge many daemons into a single host"),
    ("refuse the call when the secret round trip fails", "deny the request if credential exchange breaks"),
    ("keep the derived cache disposable and rebuildable", "make the generated store safe to throw away"),
    ("charge a wrong selection five times an abstention", "penalise a bad pick far more than declining"),
    ("read the archive in chunks until the notice stops", "page through the transcript to its end"),
    ("pin the schema version and reject anything else", "lock the layout revision and refuse mismatches"),
]

CROSSLANG = [
    ("credential rotation schedule for the broker", "브로커 자격 증명 교체 주기"),
    ("fail closed when the vault socket is unavailable", "볼트 소켓이 없을 때 차단 우선 동작"),
    ("single user state directory reorganisation", "단일 사용자 상태 디렉터리 재구성"),
    ("token usage accounting per topic", "토픽별 토큰 사용량 집계"),
    ("cancellation safe supervision of async tasks", "비동기 작업의 취소 안전 감시"),
    ("contract first porting without inventing authority", "권한을 발명하지 않는 계약 우선 이식"),
    ("stale row retained as a tombstone", "묘비로 남겨 두는 낡은 행"),
    ("body search index updated at write time", "쓰기 시점에 갱신되는 본문 검색 색인"),
]

TOPIC_WORDS = [
    "settlement", "retention", "ledger", "rollout", "quarantine", "escrow", "telemetry",
    "provisioning", "arbitration", "throttling", "reconciliation", "attestation",
]
NOUNS = ["cohort", "bundle", "window", "channel", "ledger", "queue", "shard", "lane"]
VERBS = ["reconcile", "expire", "replay", "drain", "seal", "rotate", "quarantine", "promote"]


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def article_doc(title: str, body: str, date: str = "2026-05-01") -> str:
    return f"---\ndate: {date}\ntype: concept\nstatus: active\n---\n\n# {title}\n\n{body}\n"


def summary_doc(topic: str, date: str, body: str) -> str:
    return f"---\ndate: {date}\ntype: source-summary\ntopic: {topic}\n---\n\n# {topic} — {date}\n\n{body}\n"


def topic_doc(name: str, body: str) -> str:
    return f"---\ntopic: {name}\ntype: topic-brief\n---\n\n# {name}\n\n## Persona\n- {body}\n"


def build() -> dict:
    rng = random.Random(SEED)
    if CORPUS.exists():
        shutil.rmtree(CORPUS)
    for sub in ("articles", "summaries", "topic", "skills", "archive"):
        (CORPUS / sub).mkdir(parents=True, exist_ok=True)

    article_rows: list[tuple[str, str, str]] = []  # (section, slug, description)
    summary_rows: list[tuple[str, str, str]] = []  # (slug, description, date)
    topic_rows: list[tuple[str, str]] = []
    labels: list[dict] = []
    allowed_topics: list[str] = []

    def add_article(slug: str, title: str, body: str, description: str | None, section="Reference", date="2026-05-01"):
        write(CORPUS / "articles" / f"{slug}.md", article_doc(title, body, date))
        if description is not None:
            article_rows.append((section, slug, description))

    def add_summary(slug: str, topic: str, date: str, body: str, description: str | None):
        write(CORPUS / "summaries" / f"{slug}.md", summary_doc(topic, date, body))
        if description is not None:
            summary_rows.append((slug, description, date))

    def add_topic(name: str, body: str, description: str, allowed=True):
        write(CORPUS / "topic" / f"{name}.md", topic_doc(name, body))
        topic_rows.append((name, description))
        if allowed:
            allowed_topics.append(name)

    # ---- noise -------------------------------------------------------------
    for i in range(NOISE_ARTICLES):
        word, noun, verb = rng.choice(TOPIC_WORDS), rng.choice(NOUNS), rng.choice(VERBS)
        slug = f"noise-article-{i:03d}"
        add_article(slug, f"Noise {word.title()} {noun.title()} {i}",
                    f"How to {verb} the {word} {noun} for cohort {i}. " * 3,
                    f"Noise {word} {noun} reference {i}")
    for i in range(NOISE_SUMMARIES):
        word = rng.choice(TOPIC_WORDS)
        date = f"2026-{rng.randint(1, 4):02d}-{rng.randint(1, 28):02d}"
        add_summary(f"{date}-noise-{i:03d}", f"noise-{i:03d}", date,
                    f"Routine {word} session {i} with no durable outcome. " * 3,
                    f"Routine {word} session {i}")
    for i in range(NOISE_TOPICS):
        add_topic(f"noise-topic-{i:03d}", f"Noise persona {i}", f"Noise topic brief {i}")

    # ---- article fixtures --------------------------------------------------
    for split, base in (("dev", 0), ("hidden", 4)):
        pre = "d" if split == "dev" else "h"

        # 1. graded family with a lexical decoy that must not outrank it
        for n in range(4):
            fam = f"{pre}-family-{n}"
            topic_phrase = f"{rng.choice(TOPIC_WORDS)} {rng.choice(NOUNS)} cohort {base + n}"
            grades = {}
            for role, grade, repeat in (("runbook", 3, 4), ("checklist", 2, 2), ("background", 1, 1)):
                slug = f"{fam}-{role}"
                add_article(slug, f"{fam.title()} {role.title()}",
                            f"{topic_phrase} " * repeat + f"Operational {role} for {topic_phrase}.",
                            f"{role.title()} for {topic_phrase}", section="Operations")
                grades[f"article:{slug}"] = grade
            decoy = f"{fam}-decoy"
            add_article(decoy, f"{fam.title()} Decoy",
                        f"Unrelated audit of the {rng.choice(NOUNS)} pipeline. Mentions {topic_phrase} only in passing once.",
                        f"Deprecated audit note for {fam}", section="Operations")
            labels.append({"id": f"{pre}-a-family-{n}", "track": "article", "category": "graded_family",
                           "scenario": "indexed", "query": topic_phrase, "relevance": grades,
                           "forbidden": [], "penalised": [f"article:{decoy}"], "expect": "results"})

        # 2. paraphrase: description is generic, body carries the meaning
        for n in range(4):
            body_phrase, query = PARAPHRASE[base + n]
            slug = f"{pre}-paraphrase-{n}"
            add_article(slug, f"Paraphrase Case {base + n}", f"{body_phrase}. " * 3,
                        "Operational notes", section="Reference")
            labels.append({"id": f"{pre}-a-para-{n}", "track": "article", "category": "paraphrase",
                           "scenario": "indexed", "query": query,
                           "relevance": {f"article:{slug}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})

        # 3. cross-lingual: Korean query, English body
        for n in range(4):
            body_phrase, query = CROSSLANG[base + n]
            slug = f"{pre}-crosslang-{n}"
            add_article(slug, f"Crosslang Case {base + n}", f"{body_phrase}. " * 3,
                        f"{body_phrase}", section="Reference")
            labels.append({"id": f"{pre}-a-cross-{n}", "track": "article", "category": "crosslingual",
                           "scenario": "indexed", "query": query,
                           "relevance": {f"article:{slug}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})

        # 4. typo in the query against an exact title
        for n in range(4):
            slug = f"{pre}-typo-{n}"
            phrase = f"quarantined {rng.choice(NOUNS)} escalation {base + n}"
            add_article(slug, phrase.title(), f"{phrase} handling. " * 3, phrase, section="Reference")
            typo = phrase.replace("quarantined", "quaranitned").replace("escalation", "escalaton")
            labels.append({"id": f"{pre}-a-typo-{n}", "track": "article", "category": "typo",
                           "scenario": "indexed", "query": typo,
                           "relevance": {f"article:{slug}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})

        # 5. body-only: no catalog row at all. Found after reindex, absent when fresh.
        for n in range(4):
            slug = f"{pre}-bodyonly-{n}"
            phrase = f"orphaned {rng.choice(TOPIC_WORDS)} marker {base + n}"
            add_article(slug, f"Body Only {base + n}", f"{phrase} appears only in the body. " * 3, None)
            labels.append({"id": f"{pre}-a-body-{n}", "track": "article", "category": "body_only",
                           "scenario": "indexed", "query": phrase,
                           "relevance": {f"article:{slug}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})
            labels.append({"id": f"{pre}-a-bodyfresh-{n}", "track": "article", "category": "body_only_fresh",
                           "scenario": "fresh", "query": phrase, "relevance": {}, "forbidden": [],
                           "penalised": [f"article:{slug}"], "expect": "empty"})

        # 6. tombstone: catalog row survives, document is gone
        for n in range(4):
            slug = f"{pre}-tombstone-{n}"
            phrase = f"withdrawn {rng.choice(TOPIC_WORDS)} directive {base + n}"
            article_rows.append(("Reference", slug, phrase))
            labels.append({"id": f"{pre}-a-tomb-{n}", "track": "article", "category": "tombstone",
                           "scenario": "indexed", "query": phrase, "relevance": {}, "forbidden": [],
                           "penalised": [f"article:{slug}"], "expect": "empty"})

        # 7. catalog-only retrieval must survive a cold cache
        for n in range(4):
            slug = f"{pre}-catalog-{n}"
            phrase = f"sealed {rng.choice(NOUNS)} charter {base + n}"
            add_article(slug, phrase.title(), f"{phrase} details. " * 3, phrase, section="Reference")
            labels.append({"id": f"{pre}-a-cold-{n}", "track": "article", "category": "catalog_cold",
                           "scenario": "fresh", "query": phrase,
                           "relevance": {f"article:{slug}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})

    # ---- summary fixtures --------------------------------------------------
    for split, base in (("dev", 0), ("hidden", 4)):
        pre = "d" if split == "dev" else "h"
        for n in range(4):
            name = f"{pre}-session-{n}"
            dates = ["2026-01-05", "2026-02-05", "2026-03-05"]
            grades = {}
            for idx, date in enumerate(dates):
                slug = f"{date}-{name}"
                add_summary(slug, name, date, f"{name} work log entry {idx}. " * 3, f"{name} session on {date}")
                grades[f"summary:{slug}"] = idx + 1  # newest is most relevant
            labels.append({"id": f"{pre}-s-recency-{n}", "track": "summary", "category": "recency",
                           "scenario": "indexed", "query": f"latest {name} session",
                           "relevance": grades, "forbidden": [], "penalised": [], "expect": "results"})
            labels.append({"id": f"{pre}-s-exact-{n}", "track": "summary", "category": "date_exact",
                           "scenario": "indexed", "query": f"{name} 2026-02-05",
                           "relevance": {f"summary:2026-02-05-{name}": 3}, "forbidden": [],
                           "penalised": [], "expect": "results"})
            labels.append({"id": f"{pre}-s-before-{n}", "track": "summary", "category": "range_before",
                           "scenario": "indexed", "query": f"{name} before 2026-03-05",
                           "relevance": {f"summary:2026-01-05-{name}": 2, f"summary:2026-02-05-{name}": 3},
                           "forbidden": [f"summary:2026-03-05-{name}"], "penalised": [], "expect": "results"})
        for n in range(4):
            body_phrase, query = PARAPHRASE[base + n]
            slug = f"2026-04-{10 + n:02d}-{pre}-spara-{n}"
            add_summary(slug, f"{pre}-spara-{n}", f"2026-04-{10 + n:02d}", f"{body_phrase}. " * 3, "Session notes")
            labels.append({"id": f"{pre}-s-para-{n}", "track": "summary", "category": "paraphrase",
                           "scenario": "indexed", "query": query,
                           "relevance": {f"summary:{slug}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})
        for n in range(4):
            slug = f"2026-04-{20 + n:02d}-{pre}-stomb-{n}"
            phrase = f"retracted {rng.choice(TOPIC_WORDS)} session {base + n}"
            summary_rows.append((slug, phrase, f"2026-04-{20 + n:02d}"))
            labels.append({"id": f"{pre}-s-tomb-{n}", "track": "summary", "category": "tombstone",
                           "scenario": "indexed", "query": phrase, "relevance": {}, "forbidden": [],
                           "penalised": [f"summary:{slug}"], "expect": "empty"})
        for n in range(4):
            slug = f"2026-04-{25 + n:02d}-{pre}-sbody-{n}"
            phrase = f"unlisted {rng.choice(TOPIC_WORDS)} handoff {base + n}"
            add_summary(slug, f"{pre}-sbody-{n}", f"2026-04-{25 + n:02d}", f"{phrase} only in body. " * 3, None)
            labels.append({"id": f"{pre}-s-body-{n}", "track": "summary", "category": "body_only",
                           "scenario": "indexed", "query": phrase,
                           "relevance": {f"summary:{slug}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})
            labels.append({"id": f"{pre}-s-bodyfresh-{n}", "track": "summary", "category": "body_only_fresh",
                           "scenario": "fresh", "query": phrase, "relevance": {}, "forbidden": [],
                           "penalised": [f"summary:{slug}"], "expect": "empty"})

    # ---- topic fixtures ----------------------------------------------------
    for split, base in (("dev", 0), ("hidden", 4)):
        pre = "d" if split == "dev" else "h"
        for n in range(4):
            key = f"{pre}-exact-{n}"
            add_topic(key, f"Owner of {key}", f"{key} persona brief")
            labels.append({"id": f"{pre}-t-exact-{n}", "track": "topic", "category": "exact_key",
                           "scenario": "indexed", "query": key, "outcome": "selected", "canonical": key,
                           "relevance": {f"topic:{key}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})
        for n in range(4):
            key = f"{pre}-desc-{n}"
            phrase = f"{rng.choice(TOPIC_WORDS)} governance programme {base + n}"
            add_topic(key, phrase, phrase)
            labels.append({"id": f"{pre}-t-desc-{n}", "track": "topic", "category": "description",
                           "scenario": "indexed", "query": phrase, "outcome": "selected", "canonical": key,
                           "relevance": {f"topic:{key}": 3}, "forbidden": [], "penalised": [],
                           "expect": "results"})
        for n in range(4):
            shared = f"{rng.choice(TOPIC_WORDS)} migration {base + n}"
            a, b = f"{pre}-amb-{n}-a", f"{pre}-amb-{n}-b"
            add_topic(a, shared, shared)
            add_topic(b, shared, shared)
            labels.append({"id": f"{pre}-t-amb-{n}", "track": "topic", "category": "ambiguous",
                           "scenario": "indexed", "query": shared, "outcome": "ambiguous",
                           "relevance": {f"topic:{a}": 1, f"topic:{b}": 1}, "forbidden": [],
                           "penalised": [], "expect": "results"})
        for n in range(4):
            labels.append({"id": f"{pre}-t-none-{n}", "track": "topic", "category": "no_match",
                           "scenario": "indexed",
                           "query": f"nonexistent {pre} programme {base + n} zzq",
                           "outcome": "no_match", "relevance": {}, "forbidden": [], "penalised": [],
                           "expect": "empty"})
        for n in range(4):
            key = f"{pre}-private-{n}"
            phrase = f"restricted {rng.choice(TOPIC_WORDS)} dossier {base + n}"
            add_topic(key, phrase, phrase, allowed=False)
            labels.append({"id": f"{pre}-t-auth-{n}", "track": "topic", "category": "authorization",
                           "scenario": "indexed", "query": phrase, "outcome": "no_match",
                           "relevance": {}, "forbidden": [f"topic:{key}"], "penalised": [],
                           "expect": "empty"})

    # ---- write catalogs ----------------------------------------------------
    sections: dict[str, list[str]] = {}
    for section, slug, description in article_rows:
        sections.setdefault(section, []).append(f"- [[articles/{slug}]] {description} (2026-05-01)")
    article_index = ["# Wiki Index — Articles", ""]
    for section in sorted(sections):
        article_index += [f"## {section}", ""] + sorted(sections[section]) + [""]
    write(CORPUS / "article-index.md", "\n".join(article_index))

    summary_index = ["# Wiki Index — Summaries", "", "## Session Summaries", ""]
    summary_index += sorted(f"- [[summaries/{slug}]] {desc} ({date})" for slug, desc, date in summary_rows)
    write(CORPUS / "summary-index.md", "\n".join(summary_index) + "\n")

    topic_index = ["# Wiki Index — Topics", "", "## Topic Briefs", ""]
    topic_index += sorted(f"- [[topic/{name}]] {desc} (2026-05-01)" for name, desc in topic_rows)
    write(CORPUS / "topic-index.md", "\n".join(topic_index) + "\n")

    write(CORPUS / "access.json", json.dumps(
        {"user": "evaluator", "allowed_topics": sorted(allowed_topics)}, indent=2) + "\n")

    dev = [row for row in labels if row["id"].startswith("d-")]
    hidden = [row for row in labels if row["id"].startswith("h-")]
    (DATASET / "public").mkdir(parents=True, exist_ok=True)
    (DATASET / "private").mkdir(parents=True, exist_ok=True)
    write(DATASET / "public/dev.jsonl", "".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in dev))
    write(DATASET / "private/hidden.jsonl", "".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in hidden))

    digest = hashlib.sha256()
    for path in sorted(CORPUS.rglob("*")):
        if path.is_file():
            digest.update(path.relative_to(CORPUS).as_posix().encode())
            digest.update(path.read_bytes())
    for path in (DATASET / "public/dev.jsonl", DATASET / "private/hidden.jsonl"):
        digest.update(path.read_bytes())

    manifest = {
        "schema_version": 3,
        "seed": SEED,
        "sha256": digest.hexdigest(),
        "documents": {
            "articles": len(list((CORPUS / "articles").glob("*.md"))),
            "summaries": len(list((CORPUS / "summaries").glob("*.md"))),
            "topic": len(list((CORPUS / "topic").glob("*.md"))),
        },
        "catalog_rows": {"article": len(article_rows), "summary": len(summary_rows), "topic": len(topic_rows)},
        "queries": {
            "dev": len(dev), "hidden": len(hidden),
            "by_scenario": {
                s: sum(1 for r in labels if r["scenario"] == s) for s in ("indexed", "fresh")
            },
        },
    }
    write(DATASET / "manifest.json", json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return manifest


if __name__ == "__main__":
    print(json.dumps(build(), indent=2, sort_keys=True))
