from datetime import datetime, timezone

from backend.main import _local_calendar_date


def test_sqlite_naive_utc_completion_rolls_into_local_next_day():
    assert _local_calendar_date(datetime(2026, 10, 7, 16, 5)).isoformat() == '2026-10-08'
    assert _local_calendar_date(datetime(2026, 10, 7, 15, 59)).isoformat() == '2026-10-07'


def test_aware_utc_and_sqlite_naive_share_calendar_date():
    value = datetime(2026, 10, 7, 18, 30)
    assert _local_calendar_date(value) == _local_calendar_date(value.replace(tzinfo=timezone.utc))
    assert _local_calendar_date(None) is None
