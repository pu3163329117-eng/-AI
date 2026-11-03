"""Synthetic file SQLite reconnection and release contract regression."""
from uuid import uuid4
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session
from backend.db.models import CommandReceipt, TrainingEvent, TrainingSession
from backend.db.session import Base, get_db
from backend.main import app
from backend.release_tests.test_reasoning_graph import snapshot

def test_release_contract_and_receipt_survive_database_reconnection(tmp_path):
    path = tmp_path / "synthetic.sqlite"
    url = "sqlite:///" + path.as_posix()
    engine = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    db = Session(engine)
    state = snapshot()
    session_id = str(uuid4())
    db.add(TrainingSession(id=session_id, state_version=1, snapshot=state))
    db.commit()
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app, headers={'X-Wenyan-Training-Contract': 'guided-v1'})
    route = f"/api/v1/training/sessions/{session_id}"
    request = {"type":"SAVE_REASONING", "expected_state_version":1, "payload":{"paragraph_index":0, "start":1, "end":4, "reason":"合成理由", "conclusion":state["correct_answer"]}}
    try:
        client.headers.pop("X-Wenyan-Training-Contract")
        rejected = client.post(route + "/commands", json=request, headers={"Idempotency-Key":"no-header"})
        assert rejected.status_code == 409
        assert db.scalar(select(func.count()).select_from(CommandReceipt)) == 0
        assert db.scalar(select(func.count()).select_from(TrainingEvent)) == 0
        client.headers["X-Wenyan-Training-Contract"] = "guided-v1"
        first = client.post(route + "/commands", json=request, headers={"Idempotency-Key":"persist-once"})
        assert first.status_code == 200
        expected = first.json()
        client.close()
        app.dependency_overrides.pop(get_db, None)
        db.close()
        engine.dispose()
        engine = create_engine(url, connect_args={"check_same_thread": False})
        db = Session(engine)
        app.dependency_overrides[get_db] = lambda: db
        client = TestClient(app, headers={'X-Wenyan-Training-Contract': 'guided-v1'})
        assert client.post(route + "/commands", json=request, headers={"Idempotency-Key":"persist-once"}).json() == expected
        assert client.post(route + "/commands", json=request, headers={"Idempotency-Key":"stale-different"}).status_code == 409
        assert client.get(route).json()["session"]["reasoning_graph"] == expected["session"]["reasoning_graph"]
        assert len(client.get(route + "/reasoning").json()["records"]) == 1
        assert db.scalar(select(func.count()).select_from(CommandReceipt)) == 1
        assert db.scalar(select(func.count()).select_from(TrainingEvent).where(TrainingEvent.type == "training.reasoning_saved")) == 1
    finally:
        client.close()
        app.dependency_overrides.pop(get_db, None)
        db.close()
        engine.dispose()
