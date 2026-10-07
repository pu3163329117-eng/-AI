"""Version-positioned knowledge drafts; original wording, no auto-approval.

See docs/knowledge-base.md for editorial policy and measured coverage.
Importing this module does not generate a gloss for an unannotated character.
"""
from .knowledge_annotations_classics import ANNOTATIONS as CLASSICS
from .knowledge_annotations_other import ANNOTATIONS as OTHER
from .knowledge_annotations_short import ANNOTATIONS as SHORT
from .knowledge_annotations_tower import ANNOTATIONS as TOWER
from .knowledge_annotations_peach import ANNOTATIONS as PEACH
from .knowledge_annotations_teacher import ANNOTATIONS as TEACHER
from .knowledge_annotations_history import ANNOTATIONS as HISTORY
from .knowledge_annotations_boat import ANNOTATIONS as BOAT
from .knowledge_annotations_ma import ANNOTATIONS as MA
from .knowledge_annotations_pavilion import ANNOTATIONS as PAVILION
from .knowledge_annotations_xunzi import ANNOTATIONS as XUNZI
from .knowledge import locate_annotation
from .reading_context import reading_context_for
from unicodedata import category

ANNOTATIONS = [*CLASSICS, *(a for a in OTHER if a['source'] != '《岳阳楼记》'), *SHORT, *TOWER]


def add_uncovered(rows: list[dict]) -> None:
    """Fill uncovered word positions while preserving existing authored notes.

    Every incoming draft is validated, including already covered spans. We do
    not infer a meaning, overwrite earlier notes or turn a sentence into a word.
    """
    sources = {a['source'] for a in rows}
    contexts = {source: reading_context_for({'source': source, 'passage': ''}) for source in sources}
    covered: set[tuple[str, int, int]] = set()
    for a in ANNOTATIONS:
        if a['source'] not in sources:
            continue
        located = locate_annotation(contexts[a['source']], a)
        covered.update((a['source'], located['paragraph_index'], i) for i in range(located['start'], located['end']))
    for a in rows:
        located = locate_annotation(contexts[a['source']], a)
        paragraph = contexts[a['source']]['paragraphs'][located['paragraph_index']]
        positions = {(a['source'], located['paragraph_index'], i) for i in range(located['start'], located['end']) if category(paragraph[i])[0] in 'LN'}
        if not positions.issubset(covered):
            ANNOTATIONS.append(a)
            covered.update(positions)


add_uncovered(PEACH)
add_uncovered(TEACHER)
add_uncovered(HISTORY)
add_uncovered(BOAT)
add_uncovered(MA)
add_uncovered(PAVILION)
add_uncovered(XUNZI)
