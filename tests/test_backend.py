import json
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as appmod

TODAY = date(2026, 10, 22)  # a Thursday


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    monkeypatch.setattr(appmod, "SERVER_GNANI_KEY", "")
    monkeypatch.setattr(appmod, "SERVER_LLM_URL", "")
    monkeypatch.setattr(appmod, "SERVER_LLM_MODEL", "")
    monkeypatch.setattr(appmod, "ALLOW_PRIVATE_LLM", False)
    appmod._hits.clear()
    appmod._transport = None
    yield
    appmod._transport = None


client = TestClient(appmod.app)


# ---------------------------------------------------------------- dates

def test_resolve_due_variants():
    r = appmod.resolve_due
    assert r({"in_days": 5}, TODAY) == "2026-10-27"
    assert r({"in_days": 0}, TODAY) == "2026-10-22"
    assert r("2026-11-03", TODAY) == "2026-11-03"
    assert r("2026-11-03T10:00:00", TODAY) == "2026-11-03"
    assert r(3, TODAY) == "2026-10-25"
    assert r(None, TODAY) is None
    assert r("not a date", TODAY) is None
    assert r({"in_days": -2}, TODAY) is None
    assert r({"in_days": "x"}, TODAY) is None
    assert r("2026-10-01", TODAY) is None  # past dates are dropped
    assert r("2031-01-01", TODAY) is None  # absurdly far dates are dropped
    assert r(True, TODAY) is None


def test_parse_json_object_handles_fences_and_prose():
    assert appmod.parse_json_object('{"a": 1}') == {"a": 1}
    assert appmod.parse_json_object('```json\n{"a": 1}\n```') == {"a": 1}
    assert appmod.parse_json_object('Sure! Here you go: {"a": 1} Hope that helps') == {"a": 1}
    with pytest.raises(ValueError):
        appmod.parse_json_object("no json here")
    with pytest.raises(ValueError):
        appmod.parse_json_object("[1, 2]")


# ---------------------------------------------------------------- normalisation

def make_req(**kw):
    base = dict(
        transcript="x",
        today=TODAY.isoformat(),
        state={"projects": [{"name": "Course project", "kind": "course", "tasks": [{"id": "t_old", "title": "Review surveys", "due": None, "done": False}]}]},
        pending_questions=[{"id": "q_pending", "text": "What is the course project about?"}],
    )
    base.update(kw)
    return appmod.ExtractRequest(**base)


def test_normalize_dedupes_validates_and_resolves():
    obj = {
        "summary": "  Added things  ",
        "projects": [{"name": "AI Engineer prep", "kind": "PERSONAL", "stage": None}, {"name": "", "kind": "x"}, {"name": "Weird", "kind": "banana"}],
        "tasks": [
            {"title": "Review surveys", "project": "Course project"},  # already exists
            {"title": "Study system design", "project": "AI Engineer prep", "due": {"in_days": 5}, "priority": "HIGH", "suggested": True},
            {"title": "study system design", "project": "ai engineer prep"},  # duplicate within response
            {"title": "Old deadline", "project": "AI Engineer prep", "due": "2020-01-01", "priority": "urgent"},
            {"title": "", "project": "x"},
            {"title": "Loose task"},
        ],
        "updates": [
            {"task_id": "t_old", "action": "move", "due": {"in_days": 1}},
            {"task_id": "t_old", "action": "move"},  # move without a date is dropped
            {"task_id": "t_unknown", "action": "done"},  # unknown id is dropped
            {"task_id": "t_old", "action": "explode"},
        ],
        "questions": [{"text": "What kind of course project is it?", "options": ["Research", "Build", "Survey", "Other", "Extra"]}, {"text": ""}],
        "answered": ["q_pending", "q_made_up"],
    }
    out = appmod.normalize_result(obj, make_req(), TODAY)
    assert out["summary"] == "Added things"
    assert [p["kind"] for p in out["projects"]] == ["personal", "other"]
    titles = [t["title"] for t in out["tasks"]]
    assert titles == ["Study system design", "Old deadline", "Loose task", "Plan the next steps for Weird"]
    study = out["tasks"][0]
    assert study["due"] == "2026-10-27" and study["priority"] == "high" and study["suggested"] is True
    assert out["tasks"][1]["due"] is None and out["tasks"][1]["priority"] == "normal"
    assert out["tasks"][2]["project"] == "Inbox"
    assert out["updates"] == [{"task_id": "t_old", "action": "move", "due": "2026-10-23", "time": None}]
    assert len(out["questions"]) == 1 and out["questions"][0]["id"].startswith("q_")
    assert out["questions"][0]["options"] == ["Research", "Build", "Survey", "Other"]
    assert out["answered"] == ["q_pending"]


# ---------------------------------------------------------------- /api/extract

CANNED = {
    "summary": "Set up your week.",
    "projects": [
        {"name": "AI Engineer prep", "kind": "personal"},
        {"name": "Course project", "kind": "course", "stage": "Survey"},
        {"name": "Assignment", "kind": "assignment"},
    ],
    "tasks": [
        {"title": "Finish assignment", "project": "Assignment", "due": {"in_days": 5}, "priority": "high"},
        {"title": "Review ML fundamentals", "project": "AI Engineer prep", "suggested": True},
        {"title": "Study system design", "project": "AI Engineer prep", "suggested": True},
        {"title": "Check survey responses", "project": "Course project"},
    ],
    "questions": [{"text": "What kind of course project is this?", "project": "Course project", "options": ["Research", "Build"]}],
}


def llm_handler(captured):
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "```json\n" + json.dumps(CANNED) + "\n```"}}]})

    return handler


def test_extract_end_to_end_with_mock_llm(monkeypatch):
    monkeypatch.setattr(appmod, "ALLOW_PRIVATE_LLM", True)
    seen: list[httpx.Request] = []
    appmod._transport = httpx.MockTransport(llm_handler(seen))
    r = client.post(
        "/api/extract",
        headers={"X-LLM-Base-Url": "http://localhost:9999/v1", "X-LLM-Model": "evon", "X-LLM-Key": "k"},
        json={"transcript": "uh so today I have an assignment, within 5 days...", "today": "2026-10-22", "state": {}, "pending_questions": []},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tasks"][0]["due"] == "2026-10-27"
    assert body["questions"][0]["text"].startswith("What kind")
    # the prompt carries today's date with weekday and the transcript
    sent = json.loads(seen[0].content)
    assert sent["model"] == "evon"
    user = json.loads(sent["messages"][1]["content"])
    assert user["today"] == "2026-10-22 (Thursday)"
    assert "assignment" in user["transcript"]
    assert seen[0].headers["authorization"] == "Bearer k"


def test_extract_without_llm_configured_is_503():
    r = client.post("/api/extract", json={"transcript": "hi", "today": "2026-10-22"})
    assert r.status_code == 503
    assert "language model" in r.json()["detail"].lower()


def test_extract_rejects_private_llm_urls_by_default():
    r = client.post(
        "/api/extract",
        headers={"X-LLM-Base-Url": "http://127.0.0.1:8000/v1", "X-LLM-Model": "m"},
        json={"transcript": "hi", "today": "2026-10-22"},
    )
    assert r.status_code == 400
    r = client.post(
        "/api/extract",
        headers={"X-LLM-Base-Url": "https://169.254.169.254/v1", "X-LLM-Model": "m"},
        json={"transcript": "hi", "today": "2026-10-22"},
    )
    assert r.status_code == 400


def test_extract_bad_llm_output_is_502(monkeypatch):
    monkeypatch.setattr(appmod, "ALLOW_PRIVATE_LLM", True)
    appmod._transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"choices": [{"message": {"content": "sorry, I can't"}}]}))
    r = client.post(
        "/api/extract",
        headers={"X-LLM-Base-Url": "http://localhost:1/v1", "X-LLM-Model": "m"},
        json={"transcript": "hi", "today": "2026-10-22"},
    )
    assert r.status_code == 502


def test_extract_retries_without_response_format(monkeypatch):
    monkeypatch.setattr(appmod, "ALLOW_PRIVATE_LLM", True)
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        calls.append("response_format" in body)
        if "response_format" in body:
            return httpx.Response(400, text="unsupported parameter: response_format")
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"summary": "ok"})}}]})

    appmod._transport = httpx.MockTransport(handler)
    r = client.post("/api/extract", headers={"X-LLM-Base-Url": "http://localhost:1/v1", "X-LLM-Model": "m"}, json={"transcript": "hi", "today": "2026-10-22"})
    assert r.status_code == 200 and calls == [True, False]


# ---------------------------------------------------------------- /api/transcribe

def test_transcribe_requires_key():
    r = client.post("/api/transcribe", files={"audio": ("a.wav", b"RIFF", "audio/wav")}, data={"language_code": "en-IN"})
    assert r.status_code == 401


def test_transcribe_forwards_to_gnani():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, json={"success": True, "transcript": " నమస్తే hello "})

    appmod._transport = httpx.MockTransport(handler)
    r = client.post(
        "/api/transcribe",
        headers={"X-Gnani-Key": "secret"},
        files={"audio": ("clip.wav", b"RIFFdata", "audio/wav")},
        data={"language_code": "te-IN"},
    )
    assert r.status_code == 200
    assert r.json() == {"transcript": "నమస్తే hello"}
    req = seen[0]
    assert str(req.url) == "https://api.vachana.ai/stt/v3"
    assert req.headers["x-api-key-id"] == "secret"
    assert b'name="language_code"' in req.content and b"te-IN" in req.content
    assert b'name="format"' in req.content and b"transcribe" in req.content
    assert b'name="audio_file"' in req.content


def test_transcribe_validation_and_error_mapping():
    h = {"X-Gnani-Key": "k"}
    r = client.post("/api/transcribe", headers=h, files={"audio": ("a.wav", b"x", "audio/wav")}, data={"language_code": "xx-XX"})
    assert r.status_code == 400
    r = client.post("/api/transcribe", headers=h, files={"audio": ("a.wav", b"", "audio/wav")}, data={"language_code": "en-IN"})
    assert r.status_code == 400
    appmod._transport = httpx.MockTransport(
        lambda req: httpx.Response(403, json={"success": False, "error": {"type": "FORBIDDEN", "message": "No credits left"}})
    )
    r = client.post("/api/transcribe", headers=h, files={"audio": ("a.wav", b"x", "audio/wav")}, data={"language_code": "en-IN"})
    assert r.status_code == 403 and r.json()["detail"] == "No credits left"


# ---------------------------------------------------------------- /api/tts

def test_tts_payload_and_response():
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(200, content=b"ID3fakeaudio", headers={"content-type": "audio/mpeg"})

    appmod._transport = httpx.MockTransport(handler)
    r = client.post("/api/tts", headers={"X-Gnani-Key": "k"}, json={"text": "Kya aap batayenge?", "speed": 3})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/mpeg" and r.content == b"ID3fakeaudio"
    sent = json.loads(seen[0].content)
    assert str(seen[0].url) == "https://api.vachana.ai/api/v1/tts/inference"
    assert sent["model"] == "timbre-v2.5" and sent["voice"] == "Poorvi" and sent["language"] == "auto"
    assert sent["speed"] == 1.15  # clamped to the documented maximum
    assert sent["audio_config"]["container"] == "mp3"


@pytest.mark.parametrize("patch", [{"language": "klingon"}, {"model": "other"}, {"voice": "../etc"}, {"text": ""}])
def test_tts_rejects_bad_input(patch):
    body = {"text": "hi", **patch}
    r = client.post("/api/tts", headers={"X-Gnani-Key": "k"}, json=body)
    assert r.status_code in (400, 422)


# ---------------------------------------------------------------- shared-key rate limit

def test_rate_limit_only_applies_to_server_key(monkeypatch):
    monkeypatch.setattr(appmod, "SERVER_GNANI_KEY", "shared")
    monkeypatch.setattr(appmod, "RATE_LIMIT_PER_HOUR", 2)
    appmod._transport = httpx.MockTransport(lambda req: httpx.Response(200, json={"transcript": "ok"}))
    send = lambda headers: client.post("/api/transcribe", headers=headers, files={"audio": ("a.wav", b"x", "audio/wav")}, data={"language_code": "en-IN"})
    assert send({}).status_code == 200
    assert send({}).status_code == 200
    assert send({}).status_code == 429
    assert send({"X-Gnani-Key": "mine"}).status_code == 200  # own key is never limited


def test_health_and_static_index():
    assert client.get("/api/health").json()["ok"] is True
    page = client.get("/")
    assert page.status_code == 200 and "Karyam" in page.text


def test_normalize_accepts_bare_strings():
    from datetime import date
    from backend.app import normalize_result, ExtractRequest
    req = ExtractRequest(transcript="x", today="2026-10-22", state={"projects": [], "tasks": []}, pending_questions=[])
    out = normalize_result({"projects": ["Personal project"], "tasks": ["Read a paper"]}, req, date(2026, 10, 22))
    assert out["projects"][0]["name"] == "Personal project"
    assert out["tasks"][0]["title"] == "Read a paper" and out["tasks"][0]["project"] == "Inbox"


def test_empty_project_gets_placeholder_task():
    from datetime import date
    from backend.app import normalize_result, ExtractRequest
    req = ExtractRequest(transcript="x", today="2026-10-22", state={"projects": [], "tasks": []}, pending_questions=[])
    out = normalize_result({"projects": [{"name": "Assignment", "kind": "assignment"}], "tasks": []}, req, date(2026, 10, 22))
    assert [t["project"] for t in out["tasks"]] == ["Assignment"] and out["tasks"][0]["suggested"] is True


def _req(now="2026-10-22T19:23"):
    from backend.app import ExtractRequest
    return ExtractRequest(transcript="x", today="2026-10-22", now=now, state={"projects": [], "tasks": []}, pending_questions=[])


def test_in_minutes_and_bare_time_resolve_from_client_clock():
    from datetime import date
    from backend.app import normalize_result
    obj = {"tasks": [
        {"title": "Call mom", "project": "Personal", "due": {"in_minutes": 10}},
        {"title": "Gym", "project": "Personal", "time": "21:00"},
        {"title": "Standup", "project": "Work", "time": "09:30"},
        {"title": "Bad", "project": "Work", "time": "25:99"},
    ]}
    t = {x["title"]: x for x in normalize_result(obj, _req(), date(2026, 10, 22))["tasks"]}
    assert (t["Call mom"]["due"], t["Call mom"]["time"]) == ("2026-10-22", "19:33")
    assert (t["Gym"]["due"], t["Gym"]["time"]) == ("2026-10-22", "21:00")
    assert (t["Standup"]["due"], t["Standup"]["time"]) == ("2026-10-23", "09:30")
    assert t["Bad"]["due"] is None and t["Bad"]["time"] is None


def test_in_minutes_crosses_midnight():
    from datetime import date
    from backend.app import normalize_result
    out = normalize_result({"tasks": [{"title": "Late", "project": "P", "due": {"in_minutes": 60}}]}, _req("2026-10-22T23:30"), date(2026, 10, 22))
    assert (out["tasks"][0]["due"], out["tasks"][0]["time"]) == ("2026-10-23", "00:30")


def test_reply_remember_and_repeat_are_validated():
    from datetime import date
    from backend.app import normalize_result, ExtractRequest
    req = ExtractRequest(transcript="x", today="2026-10-22", now="2026-10-22T19:23", memory=["I study at night"],
                         state={"projects": [], "tasks": []}, pending_questions=[])
    obj = {
        "reply": "  Done, I'll remind you at 8.  ",
        "remember": ["I study at night", "Exams start 12 Nov", "exams start 12 nov", "", "a", "b", "c"],
        "tasks": [
            {"title": "Medicine", "project": "Health", "time": "08:00", "repeat": "daily"},
            {"title": "Yoga", "project": "Health", "time": "07:00", "repeat": "hourly"},
            {"title": "Someday", "project": "Health", "repeat": "daily"},
        ],
    }
    out = normalize_result(obj, req, date(2026, 10, 22))
    assert out["reply"] == "Done, I'll remind you at 8."
    assert out["remember"] == ["Exams start 12 Nov", "a", "b"]
    by = {t["title"]: t for t in out["tasks"]}
    assert by["Medicine"]["repeat"] == "daily" and by["Yoga"]["repeat"] is None and by["Someday"]["repeat"] is None


# ---------------------------------------------------------------- selftest (the "Test connection" button)

def test_selftest_reports_each_service_separately(monkeypatch):
    monkeypatch.setattr(appmod, "ALLOW_PRIVATE_LLM", True)
    def handler(request):
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(200, json={"choices": [{"message": {"content": '{"ok": true}'}}]})
        return httpx.Response(403, json={"error": {"message": "out of credits"}})
    appmod._transport = httpx.MockTransport(handler)
    r = client.post("/api/selftest", headers={"X-Gnani-Key": "k", "X-LLM-Base-Url": "http://localhost:9/v1", "X-LLM-Model": "m"})
    body = r.json()
    assert r.status_code == 200
    assert body["llm"]["ok"] is True
    assert body["gnani"]["ok"] is False and "credits" in body["gnani"]["message"]


def test_selftest_with_nothing_configured_explains_what_is_missing():
    body = client.post("/api/selftest").json()
    assert body["llm"]["ok"] is False and "Settings" in body["llm"]["message"]
    assert body["gnani"]["ok"] is False and "Settings" in body["gnani"]["message"]
