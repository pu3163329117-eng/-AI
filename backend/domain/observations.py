"""Learning behavior provenance, never a closed-book capability measurement."""
from copy import deepcopy

ASSISTANCE_KINDS = ("WORD_MEANING", "HINT", "PRESET_EVIDENCE", "FEEDBACK", "RULE_CHECK")
STAGES = ("CORE", "TRANSFER")


def initial_trace():
    return {"schema_version": 1, "stages": {stage: {"attempt_count": 0, "assistance_kinds": [],
        "first_attempt": None, "validated": False} for stage in STAGES}}


def traced(snapshot):
    trace = snapshot.get("learning_trace")
    return isinstance(trace, dict) and trace.get("schema_version") == 1 and isinstance(trace.get("stages"), dict)


def record_assistance(snapshot, kind, events, selection=None):
    if kind not in ASSISTANCE_KINDS:
        raise ValueError("INVALID_ASSISTANCE_KIND")
    if not traced(snapshot):
        return
    trace = deepcopy(snapshot["learning_trace"])
    stage = snapshot["stage"]
    tracking = trace["stages"][stage]
    if kind not in tracking["assistance_kinds"]:
        tracking["assistance_kinds"].append(kind)
    snapshot["learning_trace"] = trace
    payload = {"schema_version": 1, "stage": stage, "kind": kind,
        "before_first_attempt": tracking["first_attempt"] is None}
    if selection:
        payload.update({key: selection[key] for key in ("paragraph_index", "start", "end", "token")})
    events.append({"type": "training.assistance_recorded", "payload": payload})


def record_attempt(before, after, answer, correct, rule_matched, validated, events):
    if not traced(before):
        return
    trace = deepcopy(after["learning_trace"])
    stage = before["stage"]
    tracking = trace["stages"][stage]
    tracking["attempt_count"] += 1
    if tracking["first_attempt"] is None:
        first = {"answer": answer, "correct": bool(correct), "evidence_rule_matched": bool(rule_matched),
            "assistance_status": "ASSISTED" if tracking["assistance_kinds"] else "NONE_RECORDED",
            "assistance_kinds": list(tracking["assistance_kinds"]), "reason_review_status": "UNREVIEWED",
            "source": before["source"], "text_version": before.get("reading_context", {}).get("text_version", "历史快照")}
        tracking["first_attempt"] = deepcopy(first)
        events.append({"type": "training.first_attempt_recorded", "payload": {"schema_version": 1,
            "stage": stage, "lesson_id": before.get("lesson", {}).get("id"), **first}})
    tracking["validated"] = tracking["validated"] or validated
    after["learning_trace"] = trace
    # The response reveals correctness or a clue; only subsequent attempts inherit it.
    record_assistance(after, "FEEDBACK", events)


def empty_stage_stats():
    group = {"count": 0, "correct_count": 0, "evidence_matched_count": 0, "accuracy": None}
    return {"observed_stages": 0, "unknown_stages": 0, "validated_stages": 0, "retry_validated_stages": 0,
        "first_no_recorded_assistance": deepcopy(group), "first_assisted": deepcopy(group)}


def aggregate(records):
    totals = empty_stage_stats()
    totals.update({stage: empty_stage_stats() for stage in STAGES})
    daily = {}
    for record in records:
        stage = totals[record["stage"]]
        groups = [totals, stage]
        if record["assistance_status"] == "UNKNOWN":
            for stats in groups:
                stats["unknown_stages"] += 1
            continue
        date = record["first_submitted_date"]
        day = daily.setdefault(date, {"date": date, "observed_stages": 0,
            "first_no_recorded_assistance_count": 0, "first_no_recorded_assistance_correct_count": 0,
            "first_assisted_count": 0, "first_assisted_correct_count": 0, "retry_validated_stages": 0})
        key = "first_assisted" if record["assistance_status"] == "ASSISTED" else "first_no_recorded_assistance"
        day["observed_stages"] += 1
        day[key + "_count"] += 1
        day[key + "_correct_count"] += int(record["first_correct"])
        for stats in groups:
            stats["observed_stages"] += 1
            stats["validated_stages"] += int(record["validated"])
            stats["retry_validated_stages"] += int(record["retry_completed"])
            stats[key]["count"] += 1
            stats[key]["correct_count"] += int(record["first_correct"])
            stats[key]["evidence_matched_count"] += int(record["first_evidence_rule_matched"])
        if record["retry_completed"] and record.get("validated_date"):
            completed_day = daily.setdefault(record["validated_date"], {"date": record["validated_date"], "observed_stages": 0,
                "first_no_recorded_assistance_count": 0, "first_no_recorded_assistance_correct_count": 0,
                "first_assisted_count": 0, "first_assisted_correct_count": 0, "retry_validated_stages": 0})
            completed_day["retry_validated_stages"] += 1
    for stats in [totals, *(totals[stage] for stage in STAGES)]:
        for key in ("first_no_recorded_assistance", "first_assisted"):
            group = stats[key]
            group["accuracy"] = round(group["correct_count"] / group["count"] * 100, 2) if group["count"] else None
    return totals, sorted(daily.values(), key=lambda day: day["date"])
