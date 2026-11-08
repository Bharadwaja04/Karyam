"""Stress, fuzz and abuse tests for the backend.

These push the code with load, garbage and hostile input, and check it stays up, answers with a sane
status, and never leaks a 500. They run in a few seconds with fake upstream services (no real Gnani,
no real model), so they test Karyam's own robustness, not the providers'.
"""
import asyncio
import json
import random
import re
import threading
import time
from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from backend import app as appmod

TODAY = date(2026, 10, 22)
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
LLM_HEADERS = {"X-LLM-Base-Url": "http://localhost:9999/v1", "X-LLM-Model": "m", "X-LLM-Key": "k"}
GOOD_REPLY = {"summary": "ok", "reply": "Done.", "projects": [{"name": "P", "kind": "work"}],
              "tasks": [{"title": "T", "project": "P", "due": {"in_days": 2}}], "questions": []}


@pytest.fixture(autouse=True)
def reset(monkeypatch):
    monkeypatch.setattr(appmod, "SERVER_GNANI_KEY", "")
    monkeypatch.setattr(appmod, "SERVER_LLM_URL", "")
    monkeypatch.setattr(appmod, "SERVER_LLM_MODEL", "")
    monkeypatch.setattr(appmod, "ALLOW_PRIVATE_LLM", True)
    monkeypatch.setattr(appmod, "RATE_LIMIT_PER_HOUR", 60)
    appmod._hits.clear()
    appmod._transport = None
    yield
    appmod._transport = None


def llm_transport(reply, delay=0.0, status=200):
    async def handler(request: httpx.Request) -> httpx.Response:
        if delay:
            await asyncio.sleep(delay)
        content = reply if isinstance(reply, str) else json.dumps(reply)
        return httpx.Response(status, json={"choices": [{"message": {"content": content}}]})
    return httpx.MockTransport(handler)


def body(**kw):
    base = {"transcript": "assignment due in 2 days", "today": "2026-10-22", "state": {}, "pending_questions": []}
    base.update(kw)
    return base


def client():
    return TestClient(appmod.app, raise_server_exceptions=False)


# ------------------------------------------------------------------ load

def test_300_concurrent_extract_requests_all_succeed():
    appmod._transport = llm_transport(GOOD_REPLY, delay=0.05)

    async def run():
        transport = httpx.ASGITransport(app=appmod.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
            start = time.perf_counter()
            times = []

            async def one():
                t0 = time.perf_counter()
                r = await c.post("/api/extract", headers=LLM_HEADERS, json=body())
                times.append(time.perf_counter() - t0)
                return r.status_code

            codes = await asyncio.gather(*[one() for _ in range(300)])
            return codes, time.perf_counter() - start, sorted(times)

    codes, total, times = asyncio.run(run())
    assert set(codes) == {200}
    assert total < 10, f"300 requests took {total:.1f}s"
    print(f"\n300 concurrent extract: total {total:.2f}s, p50 {times[150]*1000:.0f} ms, p95 {times[285]*1000:.0f} ms")


def test_rate_limit_is_exact_under_concurrency(monkeypatch):
    monkeypatch.setattr(appmod, "RATE_LIMIT_PER_HOUR", 50)
    monkeypatch.setattr(appmod, "SERVER_LLM_URL", "http://localhost:9999/v1")
    monkeypatch.setattr(appmod, "SERVER_LLM_MODEL", "m")
    appmod._transport = llm_transport(GOOD_REPLY, delay=0.01)

    async def run():
        transport = httpx.ASGITransport(app=appmod.app, client=("1.2.3.4", 1))
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost") as c:
            rs = await asyncio.gather(*[c.post("/api/extract", json=body()) for _ in range(200)])
            return [r.status_code for r in rs]

    codes = asyncio.run(run())
    assert codes.count(200) == 50 and codes.count(429) == 150


class FakeReq:
    def __init__(self, ip):
        self.client = type("C", (), {"host": ip})()


def test_rate_limit_memory_stays_bounded_with_many_clients():
    for i in range(60_000):
        appmod.check_rate(FakeReq(f"10.{i // 65536}.{(i // 256) % 256}.{i % 256}"), True)
    assert len(appmod._hits) <= 25_000, f"remembered {len(appmod._hits)} clients"


# ------------------------------------------------------------------ oversized and malformed input

def test_oversized_json_bodies_are_rejected_without_crashing():
    c = client()
    big = body(transcript="x" * 100, state={"junk": "y" * (3 * 1024 * 1024)})
    assert c.post("/api/extract", headers=LLM_HEADERS, json=big).status_code == 413
    assert c.post("/api/tts", headers={"X-Gnani-Key": "k"}, json={"text": "a" * 2_000_000}).status_code in (413, 422)


def test_oversized_audio_is_rejected_before_it_is_read_into_memory():
    c = client()
    r = c.post("/api/transcribe", headers={"X-Gnani-Key": "k"}, files={"audio": ("a.wav", b"\0" * (30 * 1024 * 1024), "audio/wav")}, data={"language_code": "en-IN"})
    assert r.status_code == 413


def test_chunked_upload_without_content_length_is_still_capped():
    c = client()

    def chunks():
        for _ in range(40):
            yield b"x" * (512 * 1024)  # 20 MB total, no Content-Length header

    r = c.post("/api/extract", headers={**LLM_HEADERS, "Content-Type": "application/json"}, content=chunks())
    assert r.status_code == 413


@pytest.mark.parametrize("content,ctype", [
    (b"", "application/json"),
    (b"{not json", "application/json"),
    (b"null", "application/json"),
    (b"[]", "application/json"),
    (b'{"transcript": 5, "today": 7}', "application/json"),
    (b'{"transcript": "hi", "today": "2026-13-45"}', "application/json"),
    (b"\x00\xff\xfe binary", "application/json"),
    (b"transcript=hi", "application/x-www-form-urlencoded"),
    (b"hello", "text/plain"),
])
def test_garbage_requests_never_cause_a_500(content, ctype):
    r = client().post("/api/extract", headers={**LLM_HEADERS, "Content-Type": ctype}, content=content)
    assert 400 <= r.status_code < 500, (r.status_code, r.text[:200])


def test_deeply_nested_state_does_not_crash():
    appmod._transport = llm_transport(GOOD_REPLY)
    nested = "[" * 5000 + "]" * 5000
    raw = ('{"transcript":"hi","today":"2026-10-22","state":{"projects":' + nested + '},"pending_questions":[]}').encode()
    r = client().post("/api/extract", headers={**LLM_HEADERS, "Content-Type": "application/json"}, content=raw)
    assert r.status_code < 500


def test_hostile_state_shapes_do_not_crash():
    appmod._transport = llm_transport(GOOD_REPLY)
    c = client()
    for state in [
        {"projects": {"a": 1}}, {"projects": 5}, {"projects": "abc"}, {"projects": [None, 1, "x", [], {"tasks": 7}]},
        {"projects": [{"name": "A", "tasks": {"x": 1}}]}, {"projects": [{"tasks": [{"id": {"a": 1}, "title": 5}]}]},
        {"projects": [{"name": "A", "tasks": [{"id": "t1", "title": "x", "due": {"huge": "y" * 50000}}]}]},
    ]:
        r = c.post("/api/extract", headers=LLM_HEADERS, json=body(state=state))
        assert r.status_code == 200, (state, r.status_code, r.text[:200])


def test_unicode_edge_cases_in_transcript():
    appmod._transport = llm_transport(GOOD_REPLY)
    c = client()
    for text in ["నమస్తే 🙏 hello", "مرحبا بالعالم", "a​b‏c", "é" * 500, "😀" * 2000, "line1\nline2\ttab", "\u0000nul"]:
        r = c.post("/api/extract", headers=LLM_HEADERS, json=body(transcript=text))
        assert r.status_code in (200, 400, 422), (text[:10], r.status_code)


# ------------------------------------------------------------------ the model and Gnani misbehave

@pytest.mark.parametrize("raw", [
    "", "   ", "null", "[]", "42", '"just a string"', "{", '{"tasks": [', "```", "```json\n```",
    "\x00\x01\x02", "I am sorry, I cannot do that.", '{"tasks": "oops", "projects": 5, "updates": {"a": 1}}',
    "{" * 20000, '{"a":' * 5000, "x" * 3_000_000,
])
def test_garbage_model_replies_become_200_or_502_never_500(raw):
    appmod._transport = llm_transport(raw)
    r = client().post("/api/extract", headers=LLM_HEADERS, json=body())
    assert r.status_code in (200, 502), (r.status_code, r.text[:200])


@pytest.mark.parametrize("make", [
    lambda req: (_ for _ in ()).throw(httpx.ReadTimeout("slow", request=req)),
    lambda req: (_ for _ in ()).throw(httpx.ConnectError("down", request=req)),
    lambda req: httpx.Response(500, text="boom"),
    lambda req: httpx.Response(429, json={"error": {"message": "slow down"}}),
    lambda req: httpx.Response(401, json={"error": {"message": "bad key"}}),
    lambda req: httpx.Response(200, text="<html>captive portal</html>"),
    lambda req: httpx.Response(200, json={"unexpected": True}),
    lambda req: httpx.Response(200, content=b""),
])
def test_language_model_failures_are_mapped_to_clear_errors(make):
    appmod._transport = httpx.MockTransport(make)
    r = client().post("/api/extract", headers=LLM_HEADERS, json=body())
    assert r.status_code in (401, 502), (r.status_code, r.text[:200])
    assert r.json()["detail"]


@pytest.mark.parametrize("make", [
    lambda req: (_ for _ in ()).throw(httpx.ReadTimeout("slow", request=req)),
    lambda req: httpx.Response(200, text="<html>not json</html>"),
    lambda req: httpx.Response(200, json=["a list"]),
    lambda req: httpx.Response(200, json={"transcript": None}),
    lambda req: httpx.Response(500, text="boom"),
    lambda req: httpx.Response(403, json={"error": {"message": "no credits"}}),
    lambda req: httpx.Response(502, content=b"\xff\xfe"),
])
def test_gnani_stt_failures_never_cause_a_500(make):
    appmod._transport = httpx.MockTransport(make)
    r = client().post("/api/transcribe", headers={"X-Gnani-Key": "k"}, files={"audio": ("a.wav", b"RIFFxxxx", "audio/wav")}, data={"language_code": "te-IN"})
    assert r.status_code in (200, 403, 502), (r.status_code, r.text[:200])


@pytest.mark.parametrize("make", [
    lambda req: (_ for _ in ()).throw(httpx.ConnectError("down", request=req)),
    lambda req: httpx.Response(500, text="boom"),
    lambda req: httpx.Response(200, content=b""),
    lambda req: httpx.Response(403, json={"error": {"message": "no credits"}}),
])
def test_gnani_tts_failures_never_cause_a_500(make):
    appmod._transport = httpx.MockTransport(make)
    r = client().post("/api/tts", headers={"X-Gnani-Key": "k"}, json={"text": "hello"})
    assert r.status_code in (200, 403, 502), (r.status_code, r.text[:200])


# ------------------------------------------------------------------ fuzzing the cleaner

def junk(rng, depth=0):
    kinds = ["none", "int", "float", "bool", "str", "bigint", "list", "dict", "emoji", "long"]
    k = rng.choice(kinds if depth < 3 else kinds[:6])
    if k == "none": return None
    if k == "int": return rng.randint(-10**6, 10**6)
    if k == "bigint": return rng.randint(10**30, 10**40)
    if k == "float": return rng.choice([0.5, -1.0, float("inf"), float("-inf"), 1e308])
    if k == "bool": return rng.random() < 0.5
    if k == "str": return rng.choice(["", "x", "2026-10-30", "25:61", "daily", "done", "move", "t_1", "open_app", "  spaced   out  ", "<b>x</b>"])
    if k == "emoji": return "😀నమస్తే" * rng.randint(1, 5)
    if k == "long": return "z" * rng.randint(200, 3000)
    if k == "list": return [junk(rng, depth + 1) for _ in range(rng.randint(0, 6))]
    return {rng.choice(["name", "title", "project", "due", "time", "repeat", "kind", "text", "options", "id", "task_id", "action", "in_days", "in_minutes", "url", "query"]): junk(rng, depth + 1) for _ in range(rng.randint(0, 5))}


def fuzz_object(rng):
    keys = ["projects", "tasks", "updates", "questions", "answered", "remember", "reply", "summary"]
    return {k: junk(rng) for k in keys if rng.random() < 0.85}


def test_normalize_result_survives_5000_random_model_outputs(monkeypatch):
    rng = random.Random(1234)
    req = appmod.ExtractRequest(transcript="x", today="2026-10-22", now="2026-10-22T10:00", memory=["a fact"],
                                state={"projects": [{"name": "Known", "tasks": [{"id": "t_1", "title": "Old", "done": False}]}]},
                                pending_questions=[{"id": "q_1", "text": "?"}])
    for i in range(5000):
        obj = fuzz_object(rng)
        out = appmod.normalize_result(obj, req, TODAY)
        assert len(out["tasks"]) <= 41 and len(out["projects"]) <= 12 and len(out["questions"]) <= 2
        assert len(out["remember"]) <= 3 and len(out["reply"]) <= 400
        for t in out["tasks"]:
            assert 0 < len(t["title"]) <= 120 and 0 < len(t["project"]) <= 60
            assert t["due"] is None or (ISO.match(t["due"]) and t["due"] >= "2026-10-22")
            assert t["time"] is None or (HHMM.match(t["time"]) and t["due"])
            assert t["repeat"] in (None, "daily", "weekdays", "weekly")
            assert t["priority"] in ("high", "normal", "low")
        for u in out["updates"]:
            assert u["task_id"] == "t_1" and u["action"] in ("done", "move", "delete")
        for q in out["questions"]:
            assert q["id"].startswith("q_") and len(q["text"]) <= 200 and len(q["options"]) <= 4
        assert all(a == "q_1" for a in out["answered"])
        json.dumps(out)  # must always be serialisable
