# Karyam (కార్యం)

A voice-first to-do app. "Karyam" means task or work in Telugu. Tap the mic and say what's on your plate, in any mix of languages, stammering and
rambling included. Karyam turns it into projects, tasks and due dates, and asks you a question out loud when
something is unclear. You answer by voice too.

Built on [Gnani AI](https://www.gnani.ai) Prisma (speech to text) and Timbre (text to speech) for the
Great Indian AI Internship Challenge. Open source (MIT). Your plan stays in your browser.

```
mic → Prisma (STT) → language model → projects / tasks / dates / questions
                                              │
            you hear the question ← Timbre (TTS) ←┘   (answer by voice, repeat)
```

## What it does

- Say "course project" and it files it under a course project, then asks what kind it is.
- Say "personal project" or job prep and it makes a personal folder with a few editable starter tasks
  (dashed, marked "suggested", with Keep and Skip). It only suggests from topics you named.
- "Within 5 days" becomes a real date. The server resolves relative dates, not the model.
- "Move the survey task to tomorrow" and "done with the assignment" update existing tasks.
- Every change can be undone. Everything is editable.

## Run it

```bash
python3 -m pip install -r requirements.txt
cp .env.example .env        # then open .env and add your keys (or add them later in Settings)
bash start.sh               # Windows: start.bat
```

`start.sh` picks a free port starting at 8765 (it never stops anything else you have running) and opens
the page. The mic needs `localhost` or https.

Open **Settings** and add:

1. Your Gnani API key (from <https://app.gnani.ai>), and the language you speak.
2. A language model: any OpenAI-compatible chat endpoint (base URL, model, key). For a model served locally,
   for example Evon with vLLM, start the server with `ALLOW_PRIVATE_LLM_HOSTS=1`.

No model yet? You can still record, and the transcript can be added to an Inbox as one task.

Keys are stored in your browser and sent only to your Karyam server, which forwards them and stores nothing.
Instead of typing keys into the browser, you can set them on the server:

| Variable | Purpose |
| --- | --- |
| `GNANI_API_KEY` | Gnani key used when the browser sends none |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | Language model used when the browser sends none |
| `ALLOW_PRIVATE_LLM_HOSTS=1` | Allow `localhost` / private model servers (off by default, see below) |
| `RATE_LIMIT_PER_HOUR` | Per-IP limit when the server's own keys are used (default 60) |
| `GNANI_BASE_URL` | Override the Gnani API host (default `https://api.vachana.ai`) |

## It's an assistant, not just a list

Talk to it the way you'd talk to a person who works for you:

- **It answers.** "What's due today?" or "what's left for the assignment?" gets a short spoken answer from your own plan.
  Karyam never makes up tasks; if it doesn't know, it says so.
- **It remembers.** Say "my exams start 12 November" or "I study best at night". Facts show under "What I remember" on the
  Talk page, can be forgotten with one click, and are used to personalise replies. Tasks never go in there.
- **It repeats things.** "Every day at 8 take my medicine", "every weekday standup", "every Monday review". A repeating task
  rolls to its next day when you tick it or when its reminder fires.
- **It briefs you.** The "Brief me" button speaks today's items, what is overdue and what is coming, built from your plan
  without calling a model, so it always works.
- **Conversation log.** The last turns are kept, so "make it 6 pm" works as a follow-up.

## Reminders

Reminders fire while Karyam is open in a browser tab (pin the tab): a banner, a browser notification and, if you
want, a spoken reminder with a snooze button. Your plan is saved in your browser's storage, so use the same address
each time (`localhost` and `127.0.0.1` are different places to a browser). **Copy as Markdown** exports it.

## If you host a public demo

- Use a server-held key only with `RATE_LIMIT_PER_HOUR` set, or one viral post can use up your credits.
  People who bring their own key are not limited.
- Serve over https (browsers require it for the microphone).
- Client-supplied model URLs must be public https hosts. Private and loopback addresses are rejected so the
  server can't be used to reach internal services. Behind a reverse proxy the rate limiter sees the proxy's
  IP, so rate-limit at the proxy as well.
- Don't put real phone numbers, Aadhaar, PAN or recorded calls into demos. Use synthetic data.

## How the pieces fit

- `frontend/` is a plain-JS app with no build step. `logic.js` holds the testable logic (state merging,
  dates, WAV encoding, recording segmentation). `app.js` is the UI.
- Gnani's REST speech-to-text takes clips up to 60 seconds, so recordings are cut into clips of about 20
  to 28 seconds at a pause (or at the cap), transcribed in order, and joined. Silent clips are skipped so
  they don't spend credits.
- `backend/app.py` has four endpoints: `/api/transcribe`, `/api/tts`, `/api/extract`, `/api/health`.
  `/api/extract` holds the planning prompt and validates everything the model returns: unknown task ids,
  past dates, duplicates, bad kinds and oversized lists are dropped.

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q                    # backend + stress/abuse tests, ~5 s, no network
node --test tests/logic.test.mjs       # page logic: fuzzing, 5,000-task plans, damaged saved data
playwright install chromium
python -m pytest tests/e2e -q          # real headless browser against a real server (~2 min)
```

What the stress tests cover: 300 simultaneous requests, rate-limit exactness under load, oversized and chunked
bodies, garbage JSON, 5,000 random model replies, Gnani or model outages, 100 simultaneous saves, corrupt
state files, damaged browser storage, script injection in model output, double-submits, and phone-width layouts.
Nothing in the suite talks to real Gnani or a real model, so do one real-key run yourself before posting.

## Known gaps

- Plan quality depends on the language model you connect. The tests use canned model output to check the
  wiring and validation, so try `examples/ramble.txt` with your own model and tune the prompt in
  `backend/app.py` (`SYSTEM_PROMPT`).
- The speech language setting is one language at a time. English / Hinglish mix uses `en-IN`; for Telugu
  choose `te-IN`. Output script follows that choice.
- Timbre is in beta, and voice names for each language are in Gnani's voice catalog. Change the voice in
  Settings.
- Plans live in one browser, with no sync between devices yet.
