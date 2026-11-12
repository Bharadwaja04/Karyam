"""Karyam backend: a small stateless proxy between the browser and Gnani's speech APIs
(plus any OpenAI-compatible LLM). It stores nothing. API keys come from the browser
(your own keys) or from environment variables on the server.
"""
from __future__ import annotations

import ipaddress
import json
import os
import re
import socket
import time
import uuid
from datetime import date, datetime, time as dtime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from .envfile import load_env

load_env()  # keys can live in a .env file next to the app; must run before the settings below are read

from fastapi import FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

GNANI_BASE = os.getenv("GNANI_BASE_URL", "https://api.vachana.ai").rstrip("/")
SERVER_GNANI_KEY = os.getenv("GNANI_API_KEY", "")
SERVER_LLM_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
SERVER_LLM_KEY = os.getenv("LLM_API_KEY", "")
SERVER_LLM_MODEL = os.getenv("LLM_MODEL", "")
ALLOW_PRIVATE_LLM = os.getenv("ALLOW_PRIVATE_LLM_HOSTS", "0") == "1"
# Only applies when the server's own keys are used. People who bring their own key are not limited.
RATE_LIMIT_PER_HOUR = int(os.getenv("RATE_LIMIT_PER_HOUR", "60"))
MAX_AUDIO_BYTES = 6 * 1024 * 1024

STT_LANGS = {"bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN", "ml-IN", "mr-IN", "pa-IN", "ta-IN", "te-IN"}
TTS_LANGS = STT_LANGS | {"auto", "hi-en"}
TTS_MODELS = {"timbre-v2.5", "timbre-v3.0"}
KINDS = {"personal", "course", "assignment", "work", "other"}
PRIORITIES = {"high", "normal", "low"}
REPEATS = {"daily", "weekdays", "weekly"}

# Tests replace this with an httpx.MockTransport.
_transport: httpx.AsyncBaseTransport | None = None

app = FastAPI(title="Karyam", docs_url=None, redoc_url=None)


def make_client(timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, transport=_transport)


# ---------------------------------------------------------------- limits & keys

MAX_TRACKED_CLIENTS = 20_000
_hits: dict[str, list[float]] = {}


def check_rate(request: Request, using_server_key: bool) -> None:
    if not using_server_key or RATE_LIMIT_PER_HOUR <= 0:
        return
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    window = [t for t in _hits.get(ip, []) if now - t < 3600]
    if len(window) >= RATE_LIMIT_PER_HOUR:
        raise HTTPException(429, "Hourly limit reached for the shared key. Add your own key in Settings.")
    window.append(now)
    _hits.pop(ip, None)  # re-insert so the dict stays ordered oldest-first
    _hits[ip] = window
    while len(_hits) > MAX_TRACKED_CLIENTS:  # forget the longest-quiet client (the dict is oldest-first)
        del _hits[next(iter(_hits))]


def resolve_gnani_key(header_key: str | None) -> tuple[str, bool]:
    key = (header_key or "").strip()
    if key:
        return key, False
    if SERVER_GNANI_KEY:
        return SERVER_GNANI_KEY, True
    raise HTTPException(401, "No Gnani API key. Add yours in Settings.")


def gnani_error(r: httpx.Response) -> HTTPException:
    message = ""
    try:
        message = (r.json().get("error") or {}).get("message", "")
    except Exception:
        message = r.text[:200]
    if r.status_code == 403:
        message = message or "Gnani rejected the key. Check the key and your remaining credits."
        return HTTPException(403, message)
    if r.status_code == 429:
        return HTTPException(429, message or "Gnani rate limit reached. Wait a moment and retry.")
    if r.status_code == 400:
        return HTTPException(400, message or "Gnani could not process this request.")
    return HTTPException(502, message or f"Gnani returned {r.status_code}.")


# ---------------------------------------------------------------- health

@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "server_gnani_key": bool(SERVER_GNANI_KEY),
        "server_llm": bool(SERVER_LLM_URL and SERVER_LLM_MODEL),
    }


# ---------------------------------------------------------------- speech to text

@app.post("/api/transcribe")
async def transcribe(
    request: Request,
    audio: UploadFile = File(...),
    language_code: str = Form("en-IN"),
    x_gnani_key: str | None = Header(None),
) -> dict[str, str]:
    key, server_key = resolve_gnani_key(x_gnani_key)
    if language_code not in STT_LANGS:
        raise HTTPException(400, f"Unsupported language code: {language_code}")
    data = await audio.read()
    if not data:
        raise HTTPException(400, "Empty audio.")
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio clip too large. Clips should be under 60 seconds.")
    check_rate(request, server_key)
    try:
        async with make_client(60) as c:
            r = await c.post(
                f"{GNANI_BASE}/stt/v3",
                headers={"X-API-Key-ID": key},
                data={"language_code": language_code, "format": "transcribe"},
                files={"audio_file": (audio.filename or "clip.wav", data, audio.content_type or "audio/wav")},
            )
    except httpx.HTTPError:
        raise HTTPException(502, "Could not reach Gnani speech-to-text.")
    if r.status_code != 200:
        raise gnani_error(r)
    try:
        payload = r.json()
        transcript = payload.get("transcript", "") if isinstance(payload, dict) else ""
    except ValueError:
        raise HTTPException(502, "Gnani sent a reply Karyam could not read. Try again in a moment.")
    return {"transcript": str(transcript or "").strip()}


# ---------------------------------------------------------------- text to speech

class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    voice: str = "Poorvi"
    model: str = "timbre-v2.5"
    language: str = "auto"
    speed: float = 1.0


@app.post("/api/tts")
async def tts(body: TTSRequest, request: Request, x_gnani_key: str | None = Header(None)) -> Response:
    key, server_key = resolve_gnani_key(x_gnani_key)
    if body.model not in TTS_MODELS:
        raise HTTPException(400, "Unsupported TTS model.")
    if body.language not in TTS_LANGS:
        raise HTTPException(400, "Unsupported TTS language.")
    if not re.fullmatch(r"[A-Za-z]{2,24}", body.voice):
        raise HTTPException(400, "Invalid voice name.")
    check_rate(request, server_key)
    payload = {
        "text": body.text,
        "voice": body.voice,
        "model": body.model,
        "language": body.language,
        "speed": min(1.15, max(0.85, body.speed)),
        "audio_config": {"sample_rate": 24000, "container": "mp3", "bitrate": "64k"},
    }
    try:
        async with make_client(60) as c:
            r = await c.post(
                f"{GNANI_BASE}/api/v1/tts/inference",
                headers={"X-API-Key-ID": key, "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.HTTPError:
        raise HTTPException(502, "Could not reach Gnani text-to-speech.")
    if r.status_code != 200:
        raise gnani_error(r)
    return Response(content=r.content, media_type="audio/mpeg")


# ---------------------------------------------------------------- planning (LLM)

SYSTEM_PROMPT = """You are the planning engine of Karyam, a voice-first to-do app.
The user speaks naturally. They may speak in any mix of languages (English, Hindi, Telugu, Tamil and others), stammer, repeat themselves and change their mind mid-sentence. You receive the speech transcript, today's date, the user's current projects and tasks, and any questions the app asked earlier that are still unanswered.

Return ONLY one JSON object. No prose, no markdown.

LANGUAGE: Whatever language the user speaks, write EVERYTHING you output in English only (project names, task titles, details, questions, options, reply, summary, remember). Translate non-English speech into natural English. Never output Telugu, Hindi or any other script. Keep proper names and technical terms as they are.

Rules:
1. Ignore fillers, repetition and false starts. Extract only what the user needs to do, plus facts about their plans.
2. Group work into projects. Reuse an existing project when the user clearly means it (match by meaning, not exact words); otherwise create one. kind is one of: personal, course, assignment, work, other. "Personal project" and self-driven goals such as job preparation are kind "personal". Coursework projects are "course". A single deliverable with a deadline is "assignment".
3. Write task titles as short action phrases in English. Keep technical terms as spoken (AI/ML, system design).
4. Dates: "due" is null, an ISO date "YYYY-MM-DD", {"in_days": N} or {"in_minutes": N}. "Within 5 days" is {"in_days": 5}. "Tomorrow" is {"in_days": 1}. "In 10 minutes" is {"in_minutes": 10}; "in 2 hours" is {"in_minutes": 120}. Work out weekdays from today's date. Never invent a deadline the user did not state or clearly imply.
4b. Times: when the user names a time of day ("at 5 pm", "by 9 in the morning", "remind me at 6:30"), set "time" to 24-hour "HH:MM" and set "due" to that day (today if the time is still ahead of "now", otherwise tomorrow, unless they said another day). "Remind me to X" is a task with a reminder; use the time they gave. With no time given, leave "time" null.
5. For a personal learning or preparation project, you may add up to 5 starter tasks with "suggested": true, built only from topics the user named (for example, they said AI/ML and system design). Do not invent resources, links or courses. Everything else has "suggested": false.
6. Ask a question only when a missing detail blocks organising the work (for example "course project" with no idea what it is). Ask at most 2, short, in English, with up to 4 short "options" when answers are predictable. Do not ask what you can infer. Do not repeat a question that is answered or still pending.
7. If the transcript answers a pending question, put its id in "answered" and apply the information (add tasks, set stage, add details).
8. If the user changes or finishes an existing task ("move X to tomorrow", "done with X"), add an entry to "updates" using the task_id of the best match. Do not create a new task for it.
9. Never duplicate a task that already exists.
10. Every project you create must come with at least one task. A single deliverable such as "assignment due in 5 days" is a task ("Finish assignment", due {"in_days": 5}) inside a project.
11. Recurring: if the user says something repeats ("every day at 8", "every Monday", "on weekdays"), set the task's "repeat" to "daily", "weekdays" or "weekly" and give the first occurrence in "due" and "time". Never invent repetition.
12. "reply" is what you say back out loud: one or two short, friendly sentences in English. Answer questions about their plan ("what's due today?", "what's left for the assignment?") using ONLY the projects and tasks provided; never invent items; if you don't know, say so. Name at most three items, then "and N more". Acknowledge what you did ("Done, I'll remind you at 5."). Do not repeat a question you are also putting in "questions".
13. "remember" holds durable personal facts or preferences the user states for you to keep ("my exams start 12 November", "I study best at night"): short sentences, at most 3, never tasks, never anything already in "memory". Use "memory" to personalise replies and planning.
14. "summary" is one short sentence in English saying what you did.

JSON shape:
{
  "summary": string,
  "projects": [{"name": string, "kind": string, "stage": string|null, "details": string|null}],
  "tasks": [{"title": string, "project": string, "due": null|"YYYY-MM-DD"|{"in_days": int}|{"in_minutes": int}, "time": null|"HH:MM", "repeat": null|"daily"|"weekdays"|"weekly", "priority": "high"|"normal"|"low", "suggested": boolean}],
  "updates": [{"task_id": string, "action": "done"|"move"|"delete", "due": null|"YYYY-MM-DD"|{"in_days": int}|{"in_minutes": int}, "time": null|"HH:MM"}],
  "questions": [{"text": string, "project": string|null, "options": [string]}],
  "answered": [string],
  "reply": string,
  "remember": [string]
}"""


class ExtractRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=8000)
    today: str
    now: str | None = None  # the user's local time, "YYYY-MM-DDTHH:MM"
    memory: list[str] = Field(default_factory=list)  # facts the user asked Karyam to remember
    history: list[dict[str, Any]] = Field(default_factory=list)  # the last few chat turns
    state: dict[str, Any] = Field(default_factory=dict)
    pending_questions: list[dict[str, Any]] = Field(default_factory=list)


def clean(value: Any, limit: int) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()[:limit]


def as_list(value: Any, limit: int) -> list[Any]:
    """Models and clients sometimes send an object, a number or a string where a list belongs."""
    return value[:limit] if isinstance(value, list) else []


def parse_json_object(text: str) -> dict[str, Any]:
    t = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.IGNORECASE).strip()
    try:
        obj = json.loads(t)
    except json.JSONDecodeError:
        start, end = t.find("{"), t.rfind("}")
        if start == -1 or end <= start:
            raise ValueError("no JSON object found")
        obj = json.loads(t[start : end + 1])
    if not isinstance(obj, dict):
        raise ValueError("JSON is not an object")
    return obj


def resolve_due(value: Any, today: date) -> str | None:
    """Turn the model's due value into an ISO date, or None. Past dates are dropped."""
    result: date | None = None
    if isinstance(value, dict) and "in_days" in value:
        try:
            n = int(value["in_days"])
        except (TypeError, ValueError):
            return None
        if 0 <= n <= 365:
            result = today + timedelta(days=n)
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if 0 <= int(value) <= 365:
            result = today + timedelta(days=int(value))
    elif isinstance(value, str) and value.strip():
        try:
            result = date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    if result is None or result < today or result > today + timedelta(days=730):
        return None
    return result.isoformat()


def parse_now(value: str | None, today: date) -> datetime:
    try:
        return datetime.strptime((value or "")[:16], "%Y-%m-%dT%H:%M")
    except ValueError:
        return datetime.combine(today, dtime(9, 0))


def parse_time(value: Any) -> str | None:
    m = re.fullmatch(r"\s*(\d{1,2}):(\d{2})\s*", str(value or ""))
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return None
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def resolve_schedule(due: Any, time_value: Any, now: datetime, today: date) -> tuple[str | None, str | None]:
    """Return (ISO date, 'HH:MM') for a task or move. Handles 'in N minutes' and bare times."""
    if isinstance(due, dict) and "in_minutes" in due:
        try:
            n = int(due["in_minutes"])
        except (TypeError, ValueError):
            return None, None
        if 1 <= n <= 60 * 24 * 14:
            at = now + timedelta(minutes=n)
            return at.date().isoformat(), at.strftime("%H:%M")
        return None, None
    day, at = resolve_due(due, today), parse_time(time_value)
    if at and not day:
        # A bare time means the next time that clock reads: today if still ahead, else tomorrow.
        day = (today if at > now.strftime("%H:%M") else today + timedelta(days=1)).isoformat()
    return day, at


def compact_state(state: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for p in as_list(state.get("projects") if isinstance(state, dict) else None, 30):
        if not isinstance(p, dict):
            continue
        tasks = []
        for t in as_list(p.get("tasks"), 40):
            if isinstance(t, dict) and t.get("id") and isinstance(t["id"], (str, int)):
                tasks.append({"id": clean(t["id"], 60), "title": clean(t.get("title"), 120), "due": clean(t.get("due"), 10) or None, "time": clean(t.get("at"), 5) or None, "repeat": clean(t.get("repeat"), 10) or None, "done": bool(t.get("done"))})
        out.append({"name": clean(p.get("name"), 60), "kind": clean(p.get("kind"), 12), "stage": clean(p.get("stage"), 60), "tasks": tasks})
    return out


def normalize_result(obj: dict[str, Any], req: ExtractRequest, today: date) -> dict[str, Any]:
    if not isinstance(obj, dict):
        obj = {}
    now = parse_now(req.now, today)
    state_projects = compact_state(req.state)
    known_task_ids = {t["id"] for p in state_projects for t in p["tasks"]}
    existing = {(p["name"].lower(), t["title"].lower()) for p in state_projects for t in p["tasks"]}
    pending_ids = {str(q.get("id")) for q in req.pending_questions if isinstance(q, dict) and q.get("id")}

    projects = []
    for p in as_list(obj.get("projects"), 12):
        if isinstance(p, str):  # small models sometimes return bare names
            p = {"name": p}
        if not isinstance(p, dict):
            continue
        name = clean(p.get("name"), 60)
        if not name:
            continue
        kind = clean(p.get("kind"), 12).lower()
        projects.append({
            "name": name,
            "kind": kind if kind in KINDS else "other",
            "stage": clean(p.get("stage"), 60) or None,
            "details": clean(p.get("details"), 200) or None,
        })

    tasks, seen = [], set()
    for t in as_list(obj.get("tasks"), 40):
        if isinstance(t, str):
            t = {"title": t}
        if not isinstance(t, dict):
            continue
        title = clean(t.get("title"), 120)
        if not title:
            continue
        project = clean(t.get("project") or t.get("project_name"), 60) or "Inbox"
        key = (project.lower(), title.lower())
        if key in seen or key in existing:
            continue
        seen.add(key)
        priority = clean(t.get("priority"), 8).lower()
        due, at = resolve_schedule(t.get("due"), t.get("time"), now, today)
        tasks.append({
            "title": title,
            "project": project,
            "due": due,
            "time": at if due else None,
            "repeat": clean(t.get("repeat"), 10).lower() if due and clean(t.get("repeat"), 10).lower() in REPEATS else None,
            "priority": priority if priority in PRIORITIES else "normal",
            "suggested": bool(t.get("suggested")),
        })

    # A project with no tasks looks broken on screen. If the model left one empty, add a placeholder to keep or skip.
    with_tasks = {t["project"].lower() for t in tasks} | {p["name"].lower() for p in state_projects if p["tasks"]}
    for p in projects:
        if p["name"].lower() not in with_tasks and len(tasks) < 40:
            tasks.append({"title": f"Plan the next steps for {p['name']}", "project": p["name"], "due": None, "time": None, "repeat": None, "priority": "normal", "suggested": True})
            with_tasks.add(p["name"].lower())

    updates = []
    for u in as_list(obj.get("updates"), 20):
        if not isinstance(u, dict):
            continue
        task_id, action = str(u.get("task_id", "")), clean(u.get("action"), 8).lower()
        if task_id not in known_task_ids or action not in {"done", "move", "delete"}:
            continue
        due, at = resolve_schedule(u.get("due"), u.get("time"), now, today)
        if action == "move" and not due:
            continue
        updates.append({"task_id": task_id, "action": action, "due": due, "time": at if due else None})

    questions = []
    for q in as_list(obj.get("questions"), 2):
        if not isinstance(q, dict):
            continue
        text = clean(q.get("text"), 200)
        if not text:
            continue
        options = [clean(o, 40) for o in as_list(q.get("options"), 4) if clean(o, 40)]
        questions.append({
            "id": "q_" + uuid.uuid4().hex[:8],
            "text": text,
            "project": clean(q.get("project"), 60) or None,
            "options": options,
        })

    answered = [str(a) for a in as_list(obj.get("answered"), 20) if str(a) in pending_ids]
    known = {m.lower() for m in req.memory}
    remember = []
    for m in as_list(obj.get("remember"), 12):
        text = clean(m, 140)
        if text and text.lower() not in known and text.lower() not in {r.lower() for r in remember}:
            remember.append(text)
        if len(remember) == 3:
            break
    return {
        "reply": clean(obj.get("reply"), 400),
        "remember": remember,
        "summary": clean(obj.get("summary"), 160),
        "projects": projects,
        "tasks": tasks,
        "updates": updates,
        "questions": questions,
        "answered": answered,
    }


def validate_llm_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(400, "LLM base URL must start with http:// or https://")
    if ALLOW_PRIVATE_LLM:
        return
    if parsed.scheme != "https":
        raise HTTPException(400, "LLM base URL must use https.")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise HTTPException(400, "Could not resolve the LLM host.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            raise HTTPException(400, "LLM host must be public. For a local model server, set ALLOW_PRIVATE_LLM_HOSTS=1.")


def provider_message(r: httpx.Response) -> str:
    """Pull a short, human-readable reason out of an OpenAI-style error body."""
    try:
        err = r.json()
        err = err.get("error", err) if isinstance(err, dict) else err
        msg = err.get("message") if isinstance(err, dict) else str(err)
    except ValueError:
        msg = r.text
    return clean(msg or "", 160)


async def call_llm(base: str, key: str, model: str, messages: list[dict[str, str]]) -> str:
    url = f"{base}/chat/completions"
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    body: dict[str, Any] = {"model": model, "messages": messages, "temperature": 0.1, "response_format": {"type": "json_object"}}
    try:
        async with make_client(90) as c:
            r = await c.post(url, headers=headers, json=body)
            # Some servers reject JSON mode (or any extra field); retry once with a plain request.
            if r.status_code in (400, 422) and "response_format" in body:
                body.pop("response_format")
                r = await c.post(url, headers=headers, json=body)
    except httpx.HTTPError:
        raise HTTPException(502, "Could not reach the language model. Check the Base URL.")
    if r.status_code in (401, 403):
        raise HTTPException(401, f"The language model rejected the key. {provider_message(r)}".strip())
    if r.status_code == 404:
        raise HTTPException(502, f"Not found (404). Check the Base URL ends in /v1 (or the provider's path) and the model name is exact. {provider_message(r)}".strip())
    if r.status_code == 429:
        raise HTTPException(502, f"The language model is rate-limiting you (429). Wait a minute and retry. {provider_message(r)}".strip())
    if r.status_code != 200:
        raise HTTPException(502, f"The language model returned {r.status_code}. {provider_message(r)}".strip())
    try:
        content = r.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, ValueError, TypeError):
        raise HTTPException(502, "Unexpected response from the language model. Is the Base URL a chat-completions endpoint?")
    if not content:
        raise HTTPException(502, "The language model returned an empty reply. Try a non-reasoning model.")
    return content


def resolve_llm(url: str | None, key: str | None, model: str | None) -> tuple[str, str, str, bool]:
    client_base = (url or "").strip().rstrip("/")
    if client_base:
        validate_llm_url(client_base)
        return client_base, (key or "").strip(), (model or "").strip(), False
    base, srv_model = SERVER_LLM_URL, (model or "").strip() or SERVER_LLM_MODEL
    if not base or not srv_model:
        raise HTTPException(503, "No language model configured. Add one in Settings.")
    return base, SERVER_LLM_KEY, srv_model, True


@app.post("/api/selftest")
async def selftest(
    request: Request,
    x_gnani_key: str | None = Header(None),
    x_llm_base_url: str | None = Header(None),
    x_llm_key: str | None = Header(None),
    x_llm_model: str | None = Header(None),
) -> dict[str, Any]:
    """One tiny real call to each service, so a new user finds out in seconds what is not set up."""
    out: dict[str, Any] = {}
    try:
        base, key, model, server_llm = resolve_llm(x_llm_base_url, x_llm_key, x_llm_model)
        if not model:
            raise HTTPException(503, "No model name set. Add one in Settings.")
        check_rate(request, server_llm)
        await call_llm(base, key, model, [{"role": "user", "content": 'Reply with exactly {"ok": true}'}])
        out["llm"] = {"ok": True, "message": f"Language model replied ({model})."}
    except HTTPException as e:
        out["llm"] = {"ok": False, "message": str(e.detail)}
    try:
        await tts(TTSRequest(text="ok"), request, x_gnani_key)
        out["gnani"] = {"ok": True, "message": "Gnani key works."}
    except HTTPException as e:
        out["gnani"] = {"ok": False, "message": str(e.detail)}
    return out


@app.post("/api/extract")
async def extract(
    req: ExtractRequest,
    request: Request,
    x_llm_base_url: str | None = Header(None),
    x_llm_key: str | None = Header(None),
    x_llm_model: str | None = Header(None),
) -> dict[str, Any]:
    try:
        today = date.fromisoformat(req.today)
    except ValueError:
        raise HTTPException(400, "today must be YYYY-MM-DD")

    base, key, model, server_llm = resolve_llm(x_llm_base_url, x_llm_key, x_llm_model)
    check_rate(request, server_llm)

    return await run_extract(req, base, key, model, today)


async def run_extract(req: ExtractRequest, base: str, key: str, model: str, today: date) -> dict[str, Any]:
    user_payload = {
        "today": f"{today.isoformat()} ({today.strftime('%A')})",
        "now": parse_now(req.now, today).strftime("%Y-%m-%d %H:%M"),
        "memory": [clean(m, 140) for m in req.memory[:50]],
        "recent_conversation": [
            {"who": "user" if h.get("role") == "user" else "karyam", "text": clean(h.get("text"), 300)}
            for h in req.history[-6:]
            if isinstance(h, dict) and clean(h.get("text"), 300)
        ],
        "transcript": req.transcript.strip(),
        "projects": compact_state(req.state),
        "pending_questions": [
            {"id": str(q.get("id")), "text": clean(q.get("text"), 200)} for q in req.pending_questions[:4] if q.get("id")
        ],
    }
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
    ]
    raw = await call_llm(base, key, model, messages)
    try:
        obj = parse_json_object(raw)
    except ValueError:
        raise HTTPException(502, "The language model did not return valid JSON. Try again.")
    return normalize_result(obj, req, today)


# ---------------------------------------------------------------- static frontend

BODY_LIMITS = {"/api/transcribe": 8 * 1024 * 1024}
DEFAULT_BODY_LIMIT = 2_500_000


class BodyLimit:
    """Refuse oversized request bodies early, whether or not the client declares a Content-Length."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH"):
            return await self.inner(scope, receive, send)
        limit = BODY_LIMITS.get(scope["path"], DEFAULT_BODY_LIMIT)
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > limit:
            return await self._refuse(send)
        seen, started, too_big = 0, False, False

        async def counting_receive():
            nonlocal seen, too_big
            if too_big:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    too_big = True
                    return {"type": "http.disconnect"}
            return message

        async def tracking_send(message):
            nonlocal started
            if too_big:
                return
            started = True
            await send(message)

        try:
            await self.inner(scope, counting_receive, tracking_send)
        except Exception:
            if not too_big:
                raise
        if too_big and not started:
            await self._refuse(send)

    @staticmethod
    async def _refuse(send):
        body = b'{"detail":"That request is too large."}'
        await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


app.add_middleware(BodyLimit)


@app.middleware("http")
async def no_stale_frontend(request: Request, call_next):
    """Make browsers re-check the UI files on every load, so an update never runs against a cached old script."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
