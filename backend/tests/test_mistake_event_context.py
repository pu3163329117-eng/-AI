from backend.domain.training import apply_command, initial_snapshot


def test_wrong_attempt_event_keeps_submitted_answer_variable_and_stage():
    result = apply_command(
        initial_snapshot(),
        {"type": "SUBMIT_ATTEMPT", "payload": {"answer": "来自"}},
    )

    assert result.events == [
        {
            "type": "training.attempt_evaluated",
            "payload": {
                "label": "WRONG_CONTEXT",
                "answer": "来自",
                "variable": "从",
                "stage": "CORE",
            },
        }
    ]
