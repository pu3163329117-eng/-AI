from backend.domain.training import apply_command, initial_snapshot


def test_wrong_attempt_event_keeps_submitted_answer_variable_and_stage():
    result = apply_command(
        initial_snapshot(),
        {"type": "SUBMIT_ATTEMPT", "payload": {"answer": "来自"}},
    )

    assert [event for event in result.events if event["type"] == "training.attempt_evaluated"] == [
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
    first = next(event for event in result.events if event["type"] == "training.first_attempt_recorded")
    assert first["payload"]["answer"] == "来自" and first["payload"]["correct"] is False
    assert first["payload"]["assistance_status"] == "NONE_RECORDED"
    feedback = next(event for event in result.events if event["type"] == "training.assistance_recorded")
    assert feedback["payload"]["kind"] == "FEEDBACK" and not feedback["payload"]["before_first_attempt"]
