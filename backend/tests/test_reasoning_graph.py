from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from backend.db.models import CommandReceipt, TrainingEvent, TrainingSession
from backend.db.session import Base, get_db
from backend.domain.training import DEFAULT_LESSON_CONTENT, _evidence_rule_matches, apply_command, initial_snapshot
from backend.main import app


def snapshot():
    content = deepcopy(DEFAULT_LESSON_CONTENT)
    content.update(source='测试篇', passage='𠀀从师学。后从军。', variable='从', evidence='师学', correct_answer='跟从求教')
    content['reading_context'] = {'paragraphs': [content['passage']], 'author': '测试', 'era': '测试', 'work_note': '测试', 'text_version': 'test-v1'}
    return initial_snapshot(content)


def save(state, **changes):
    payload = {'paragraph_index': 0, 'start': 1, 'end': 4, 'reason': '从后面的师学可见是跟从老师学习。', 'conclusion': state['correct_answer'], **changes}
    return apply_command(state, {'type': 'SAVE_REASONING', 'payload': payload})


def test_graph_positions_are_frozen_and_do_not_grade_the_reason():
    before = snapshot()
    saved = save(before)
    graph = saved.snapshot['reasoning_graph']
    assert graph['evidence']['token'] == '从师学'
    assert graph['evidence']['start'] == 1 and graph['evidence']['end'] == 4
    assert graph['target'] == '从' and graph['text_version'] == 'test-v1'
    assert graph['reason_review_status'] == 'UNREVIEWED'
    assert graph['evidence_rule_matched'] and saved.snapshot['evidence_selected']
    assert not saved.snapshot['transfer_ready'] and not saved.snapshot['completed']
    assert 'reasoning_graph' not in before
    assert saved.events[0]['payload'] == graph
    accepted = apply_command(saved.snapshot, {'type': 'SUBMIT_ATTEMPT', 'payload': {'answer': graph['conclusion']}}).snapshot
    assert accepted['transfer_ready'] and '尚未人工审核' in accepted['feedback']
    with pytest.raises(ValueError, match='REASONING_STAGE_VALIDATED'):
        save(accepted)
    transferred = apply_command(accepted, {'type': 'CONTINUE_TO_TRANSFER'}).snapshot
    assert transferred['reasoning_graph'] is None and not transferred['evidence_selected']
    assert saved.events[0]['payload']['stage'] == 'CORE'


def test_arbitrary_evidence_and_different_conclusions_cannot_satisfy_rule():
    state = snapshot()
    saved = save(state, start=6, end=8).snapshot
    assert not saved['reasoning_graph']['evidence_rule_matched'] and not saved['evidence_selected']
    with pytest.raises(ValueError, match='REASONING_RECORD_REQUIRED'):
        apply_command(saved, {'type': 'SELECT_EVIDENCE'})
    attempt = apply_command(saved, {'type': 'SUBMIT_ATTEMPT', 'payload': {'answer': state['correct_answer']}}).snapshot
    assert not attempt['transfer_ready']
    other = next(choice for choice in state['choices'] if choice != state['correct_answer'])
    saved = save(state, conclusion=other).snapshot
    assert not apply_command(saved, {'type': 'SUBMIT_ATTEMPT', 'payload': {'answer': state['correct_answer']}}).snapshot['transfer_ready']


def test_enumerated_clues_need_every_fragment_not_literal_adjacency():
    assert _evidence_rule_matches('国、乡', '去国怀乡')
    assert _evidence_rule_matches('以书、余', '以书假余')
    assert _evidence_rule_matches('余、核舟一', '尝贻余核舟一')
    assert not _evidence_rule_matches('国、乡', '去国')


def test_all_sixteen_current_stages_can_select_real_evidence_under_80_codepoints():
    from backend.db.seed import SEEDS
    from backend.domain.reading_context import reading_context_for
    for lesson in SEEDS:
        for stage, content in lesson['contents'].items():
            paragraphs = reading_context_for(content)['paragraphs']
            assert any(_evidence_rule_matches(content['evidence'], paragraph[start:start + 80])
                for paragraph in paragraphs for start in range(len(paragraph))), (lesson['title'], stage)


@pytest.mark.parametrize('changes', [{'start': True}, {'end': 99}, {'start': 4, 'end': 5}, {'reason': '    '}, {'reason': '很短'}, {'reason': '字' * 2001}, {'conclusion': '任意伪造'}, {'reason': ['理由']}])
def test_invalid_graph_has_no_mutation(changes):
    state = snapshot(); original = deepcopy(state)
    with pytest.raises(ValueError):
        save(state, **changes)
    assert state == original


def test_reasoning_command_receipt_replay_refresh_and_history():
    engine = create_engine('sqlite:///:memory:', connect_args={'check_same_thread': False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    db = Session(engine)
    state = snapshot(); session_id = str(uuid4())
    db.add(TrainingSession(id=session_id, state_version=1, snapshot=state)); db.commit()
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    try:
        url = f'/api/v1/training/sessions/{session_id}'
        request = {'type': 'SAVE_REASONING', 'expected_state_version': 1, 'payload': {'paragraph_index': 0, 'start': 1, 'end': 4, 'reason': '测试理由尚未教师复核。', 'conclusion': state['correct_answer']}}
        first = client.post(url + '/commands', json=request, headers={'Idempotency-Key': 'graph-once'})
        assert first.status_code == 200
        assert client.post(url + '/commands', json=request, headers={'Idempotency-Key': 'graph-once'}).json() == first.json()
        assert client.post(url + '/commands', json=request, headers={'Idempotency-Key': 'graph-stale'}).status_code == 409
        assert client.get(url).json()['session']['reasoning_graph'] == first.json()['session']['reasoning_graph']
        records = client.get(url + '/reasoning').json()['records']
        assert len(records) == 1 and records[0]['graph']['reason_review_status'] == 'UNREVIEWED'
        assert db.scalar(select(func.count()).select_from(TrainingEvent)) == 1
        assert db.scalar(select(func.count()).select_from(CommandReceipt)) == 1
        assert client.get('/api/v1/training/sessions/absent/reasoning').status_code == 404
    finally:
        client.close(); app.dependency_overrides.pop(get_db, None); db.close(); engine.dispose()
