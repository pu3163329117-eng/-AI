"""Read-only audit of declared knowledge drafts, exact offsets and coverage.

Run ``python -m backend.scripts.knowledge_audit --require-complete``. It does
not initialize, edit, migrate or seed the local learner database.
"""
from __future__ import annotations

import argparse
import json
from collections import Counter
from unicodedata import category

from backend.db.knowledge import current_corpus
from backend.domain.knowledge import locate_annotation
from backend.domain.knowledge_annotations import ANNOTATIONS


def audit() -> dict:
    corpus = current_corpus()
    covered = set()
    keys = set()
    counts = Counter()
    for annotation in ANNOTATIONS:
        source = annotation["source"]
        located = locate_annotation(corpus[source], annotation)
        key = (source, located["paragraph_index"], located["start"], located["end"], located["sense_key"])
        if key in keys:
            raise ValueError(f"duplicate occurrence/sense: {key}")
        keys.add(key)
        counts[source] += 1
        covered.update((source, located["paragraph_index"], index) for index in range(located["start"], located["end"]))
    documents = []
    for source, context in sorted(corpus.items()):
        positions = [(source, p, i) for p, text in enumerate(context["paragraphs"]) for i, char in enumerate(text) if category(char)[0] in "LN"]
        missing = [dict(paragraph_index=p, start=i, token=context["paragraphs"][p][i]) for name, p, i in positions if (name, p, i) not in covered]
        documents.append(dict(source=source, extent=context["extent"], indexed_positions=len(positions),
            annotated_positions=len(positions) - len(missing), annotations=counts[source], missing=missing))
    return dict(documents=documents, totals=dict(documents=len(documents), annotations=len(ANNOTATIONS),
        indexed_positions=sum(d["indexed_positions"] for d in documents),
        annotated_positions=sum(d["annotated_positions"] for d in documents),
        missing_positions=sum(len(d["missing"]) for d in documents)))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-complete", action="store_true", help="Fail if any letter/number position lacks a word annotation.")
    args = parser.parse_args()
    result = audit()
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.require_complete and result["totals"]["missing_positions"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
