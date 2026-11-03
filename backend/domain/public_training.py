"""Allowlisted beta learner responses, never a replacement for stored snapshots."""
from copy import deepcopy

PUBLIC_FIELDS = frozenset({
    'stage', 'state', 'state_version', 'source', 'passage', 'variable', 'question', 'choices',
    'selected_answer', 'evidence_selected', 'deferred', 'hint_level', 'hint', 'feedback',
    'transfer_ready', 'summary_ready', 'summary', 'completed', 'reading_context',
    'context_selection', 'reasoning_graph', 'learning_trace', 'lesson', 'profile_id',
})


def learner_training_response(payload: dict) -> dict:
    snapshot = payload.get('session')
    if not isinstance(snapshot, dict):
        return payload
    result = dict(payload)
    result['session'] = {key: deepcopy(value) for key, value in snapshot.items() if key in PUBLIC_FIELDS}
    # The UI contract retains a text field, but a learner never needs the private
    # preset evidence-matching rule to read or select their own original evidence.
    result['session']['evidence'] = ''
    return result
