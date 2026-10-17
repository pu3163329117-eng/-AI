"""Disposable UI QA server. Temporary DB, synthetic key, mock vendor only.

Run separately on 8001 with a QA frontend on 5174. Never use as a deployment.
"""
import os
from pathlib import Path
from tempfile import TemporaryDirectory


def main():
    qa_output = Path(__file__).resolve().parents[2] / "output"
    qa_output.mkdir(exist_ok=True)
    qa_directory = TemporaryDirectory(prefix="wenyan-browser-qa-", dir=qa_output)
    qa_database_url = "sqlite:///" + (Path(qa_directory.name) / "qa.db").as_posix()
    os.environ["WENYAN_DATABASE_URL"] = qa_database_url
    import json
    import httpx2 as httpx
    import uvicorn
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    import backend.db.session as database
    database.engine.dispose()
    # Concurrent UI reads need separate connections, not a shared StaticPool
    # connection. This remains separate from the user's learning database.
    database.engine = create_engine(qa_database_url, connect_args={"check_same_thread": False})
    database.SessionLocal = sessionmaker(bind=database.engine, expire_on_commit=False)
    from fastapi.middleware.cors import CORSMiddleware
    from backend.main import app
    from backend import ai_routes
    from backend.ai.settings import AISettings
    from backend.ai.deepseek import DeepSeekProvider
    from backend.ai.preview import PreviewRuntime

    def response(request):
        data = json.loads(json.loads(request.content)["messages"][1]["content"])
        # Synthetic HTTP result for UI coverage, not semantic accuracy.
        output = {"label": "PARTIALLY_CORRECT", "score": .5, "confidence": .8,
                  "evidence_quality": .5, "matched_rubric_items": ["cite"],
                  "misconception_codes": [], "evidence_ids": [data["visible_evidence"][0]["id"]],
                  "next_action_recommendation": "RETRY_REASONING"}
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": json.dumps(output)}}]})

    ai_routes.load_settings = lambda: AISettings(True, "minimal_learning", "deepseek-flash", "qa-not-a-real-key")
    ai_routes.runtime = PreviewRuntime(lambda settings: DeepSeekProvider(settings, transport=httpx.MockTransport(response)))
    app.dependency_overrides[ai_routes.local_preview_only] = lambda: None
    app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:5174"], allow_methods=["*"], allow_headers=["*"])
    try:
        uvicorn.run(app, host="127.0.0.1", port=8001)
    finally:
        database.engine.dispose()
        qa_directory.cleanup()


if __name__ == "__main__":
    main()
