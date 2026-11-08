"""Real-browser stress tests. A headless Chromium drives the actual page against a real Karyam server;
Gnani and the language model are replaced by a small fake server so the tests need no keys and no network.

Run:  pip install playwright && playwright install chromium && python3 -m pytest tests/e2e -q
"""
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sync_api = pytest.importorskip("playwright.sync_api")
ROOT = Path(__file__).resolve().parents[2]

MODE = {"llm": "ok"}  # ok | error | slow | xss | junk
OK = {"summary": "Added.", "reply": "Done, I added it.", "projects": [{"name": "School", "kind": "study"}],
      "tasks": [{"title": "Finish assignment", "project": "School", "due": {"in_days": 2}, "time": "17:00"}], "questions": []}
XSS = {"summary": "x", "reply": "<img src=x onerror=window.__xss=1>", "projects": [{"name": "<script>window.__xss=2</script>"}],
       "tasks": [{"title": "<img src=x onerror=window.__xss=3>", "project": "<b onmouseover=window.__xss=4>P</b>"}], "questions": []}


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.path == "/stt/v3":
            out, ct, code = json.dumps({"success": True, "transcript": "assignment due in two days"}).encode(), "application/json", 200
        elif self.path == "/api/v1/tts/inference":
            out, ct, code = b"ID3x", "audio/mpeg", 200
        elif self.path == "/v1/chat/completions":
            mode = MODE["llm"]
            if mode == "slow":
                time.sleep(1.5)
            if mode == "error":
                out, ct, code = b'{"error":{"message":"model overloaded"}}', "application/json", 500
            else:
                body = {"xss": XSS, "junk": "total nonsense, not json"}.get(mode, OK)
                content = body if isinstance(body, str) else json.dumps(body)
                out, ct, code = json.dumps({"choices": [{"message": {"content": content}}]}).encode(), "application/json", 200
        else:
            out, ct, code = b"{}", "application/json", 404
        self.send_response(code)
        self.send_header("content-type", ct)
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@pytest.fixture(scope="module")
def site():
    fake_port, app_port = free_port(), free_port()
    fake = ThreadingHTTPServer(("127.0.0.1", fake_port), Fake)
    threading.Thread(target=fake.serve_forever, daemon=True).start()
    env = {**os.environ, "KARYAM_NO_DOTENV": "1", "GNANI_API_KEY": "k", "GNANI_BASE_URL": f"http://127.0.0.1:{fake_port}",
           "LLM_BASE_URL": f"http://127.0.0.1:{fake_port}/v1", "LLM_API_KEY": "k", "LLM_MODEL": "m", "ALLOW_PRIVATE_LLM_HOSTS": "1", "RATE_LIMIT_PER_HOUR": "0"}
    env.pop("KARYAM_LOCAL", None)
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--port", str(app_port), "--log-level", "warning"], cwd=ROOT, env=env)
    url = f"http://127.0.0.1:{app_port}/"
    for _ in range(60):
        try:
            socket.create_connection(("127.0.0.1", app_port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.2)
    yield url
    proc.terminate()
    fake.shutdown()


@pytest.fixture(scope="module")
def browser():
    with sync_api.sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture()
def page(browser, site):
    MODE["llm"] = "ok"
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.set_default_timeout(8000)
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.site = site
    yield pg
    ctx.close()


def boot(pg, storage=None):
    pg.goto(pg.site)
    if storage is not None:
        pg.evaluate("s => { localStorage.setItem('karyam.state.v1', s); }", storage)
        pg.reload()
    pg.wait_for_selector("#typeInput", state="attached", timeout=8000)
    pg.wait_for_timeout(2800)  # the opening animation


def say(pg, text, wait=900):
    pg.fill("#typeInput", text)
    pg.click("#typeForm button")
    pg.wait_for_timeout(wait)


def tasks_in_storage(pg):
    return pg.evaluate("JSON.parse(localStorage.getItem('karyam.state.v1')||'{}').tasks||[]")


def test_a_normal_sentence_becomes_a_task_that_survives_reload(page):
    boot(page)
    say(page, "assignment due in two days")
    assert any("Finish assignment" == t["title"] for t in tasks_in_storage(page))
    page.reload()
    page.wait_for_timeout(3000)
    page.click("#navPlan")
    assert "Finish assignment" in page.inner_text("#board")
    assert not page.errors


@pytest.mark.parametrize("garbage", [
    "{ not json", "null", "42", '"text"', "[]", '{"projects": 5, "tasks": "x"}',
    '{"projects":[null,1,{"id":"p"}],"tasks":[{"id":"t","projectId":"nope"}],"chat":[7,null]}',
    json.dumps({"projects": [{"id": "p", "name": "x" * 100000}], "tasks": [], "memory": [{"text": 5}]}),
])
def test_damaged_saved_data_never_breaks_the_page(page, garbage):
    boot(page, garbage)
    page.click("#navPlan")
    page.wait_for_timeout(300)
    assert not page.errors, page.errors
    page.click("#navTalk")
    say(page, "assignment due in two days")  # and it still works afterwards
    assert any(t["title"] == "Finish assignment" for t in tasks_in_storage(page))


def test_a_huge_plan_still_opens_quickly(page):
    tasks = [{"id": f"t{i}", "projectId": f"p{i % 40}", "title": f"Task number {i}", "due": f"2026-12-{(i % 28) + 1:02d}", "at": "09:00", "done": i % 4 == 0, "priority": "normal"} for i in range(2500)]
    projects = [{"id": f"p{i}", "name": f"Project {i}", "kind": "work"} for i in range(40)]
    boot(page, json.dumps({"projects": projects, "tasks": tasks}))
    t0 = time.perf_counter()
    page.click("#navPlan")
    page.wait_for_selector("#projectGrid *")
    elapsed = time.perf_counter() - t0
    assert elapsed < 4, f"{elapsed:.1f}s to open a 2,500-task plan"
    assert not page.errors


def test_ten_quick_submissions_do_not_duplicate_or_crash(page):
    boot(page)
    page.fill("#typeInput", "assignment due in two days")
    # Ten submits in the same instant (a double-click, a held Enter key, a flaky touchscreen).
    page.evaluate("() => { for (let i = 0; i < 10; i++) document.getElementById('typeForm').requestSubmit(); }")
    page.wait_for_timeout(3000)
    titles = [t["title"] for t in tasks_in_storage(page)]
    assert titles.count("Finish assignment") == 1, titles
    assert not page.errors


@pytest.mark.parametrize("mode", ["error", "junk"])
def test_when_the_model_fails_the_user_sees_a_plain_message_and_can_retry(page, mode):
    boot(page)
    MODE["llm"] = mode
    say(page, "assignment due in two days", wait=1800)
    status = page.inner_text("#status") + page.inner_text("#toast")
    assert status.strip(), "no message shown"
    assert "Traceback" not in status and "undefined" not in status and "[object" not in status
    MODE["llm"] = "ok"
    say(page, "assignment due in two days", wait=1500)
    assert any(t["title"] == "Finish assignment" for t in tasks_in_storage(page))
    assert not page.errors


def test_slow_model_shows_progress_and_blocks_double_sends(page):
    boot(page)
    MODE["llm"] = "slow"
    say(page, "assignment due in two days", wait=300)
    assert page.is_disabled("#typeForm button") or "…" in page.inner_text("#status") or page.inner_text("#status").strip()
    page.wait_for_timeout(2500)
    assert len(tasks_in_storage(page)) == 1


def test_script_in_model_output_is_shown_as_text_and_never_runs(page):
    boot(page)
    MODE["llm"] = "xss"
    say(page, "assignment due in two days", wait=1500)
    page.click("#navPlan")
    page.hover("#board *")
    page.wait_for_timeout(500)
    assert page.evaluate("window.__xss") is None
    assert page.locator("#board img, #chatLog img, #projectGrid img, #board script").count() == 0


@pytest.mark.parametrize("size", [(360, 740), (390, 844), (768, 1024)])
def test_no_sideways_scrolling_on_phones_and_tablets(browser, site, size):
    ctx = browser.new_context(viewport={"width": size[0], "height": size[1]})
    ctx.set_default_timeout(8000)
    pg = ctx.new_page()
    pg.site = site
    boot(pg)
    say(pg, "assignment due in two days")
    for route in ("#navTalk", "#navPlan"):
        pg.click(route)
        pg.wait_for_timeout(500)
        assert pg.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), f"{route} overflows at {size}"
    ctx.close()


def test_two_tabs_do_not_corrupt_each_other(browser, site):
    ctx = browser.new_context()
    ctx.set_default_timeout(8000)
    a, b = ctx.new_page(), ctx.new_page()
    a.site = b.site = site
    boot(a)
    boot(b)
    say(a, "assignment due in two days")
    MODE["llm"] = "ok"
    say(b, "assignment due in two days")
    saved = a.evaluate("JSON.parse(localStorage.getItem('karyam.state.v1'))")
    assert isinstance(saved["tasks"], list) and len(saved["tasks"]) >= 1
    a.reload()
    a.wait_for_timeout(2500)
    ctx.close()


# ---------------------------------------------------------------- first-run experience

def test_example_phrase_chip_works_in_one_tap(page):
    boot(page)
    page.locator(".chip", has_text="Assignment due Friday").click()
    page.wait_for_timeout(1500)
    assert any(t["title"] == "Finish assignment" for t in tasks_in_storage(page))
    assert not page.errors


def test_test_connection_button_reports_both_services(page):
    boot(page)
    page.click("#settingsBtn")
    page.click("#testConn")
    page.wait_for_selector("#testResult li.ok, #testResult li.bad")
    page.wait_for_timeout(500)
    rows = page.locator("#testResult li").all_inner_texts()
    assert len(rows) == 2 and all("OK" not in r or "works" in r or "replied" in r for r in rows)
    assert page.locator("#testResult li.ok").count() == 2  # the fake services accept everything


def test_erase_needs_two_clicks_and_then_wipes_everything(page):
    boot(page)
    say(page, "assignment due in two days")
    assert tasks_in_storage(page)
    page.click("#navTalk")
    page.click("#settingsBtn")
    page.click("#clearData")
    assert tasks_in_storage(page), "one click must not erase"
    page.click("#clearData")
    page.wait_for_timeout(300)
    assert tasks_in_storage(page) == []


def test_space_bar_starts_and_stops_talking_only_outside_text_fields(page):
    boot(page)
    page.evaluate("document.getElementById('mic').addEventListener('click', () => (window.__mic = (window.__mic || 0) + 1))")
    page.focus("#typeInput")
    page.keyboard.press("Space")
    assert page.evaluate("window.__mic || 0") == 0
    page.evaluate("document.activeElement.blur()")
    page.keyboard.press("Space")
    assert page.evaluate("window.__mic || 0") == 1


def test_setup_card_shows_when_nothing_is_configured(browser):
    # A second server with no keys at all: a brand-new user's first screen.
    port = free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("GNANI", "LLM_", "KARYAM_LOCAL"))}
    env.update(KARYAM_NO_DOTENV="1")
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "backend.app:app", "--port", str(port), "--log-level", "warning"], cwd=ROOT, env=env)
    try:
        for _ in range(60):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                break
            except OSError:
                time.sleep(0.2)
        ctx = browser.new_context()
        ctx.set_default_timeout(8000)
        pg = ctx.new_page()
        pg.goto(f"http://127.0.0.1:{port}/")
        pg.wait_for_timeout(3000)
        assert pg.is_visible("#setup")
        pg.click("#setupOpen")
        assert pg.is_visible("#settings")
        ctx.close()
    finally:
        proc.terminate()
