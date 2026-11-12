# Karyam: a voice-first personal assistant

**Solo entry:** Bharadwaja Vadali, PDM student, IIIT Hyderabad
**Built for:** Gnani.ai Great Indian AI Internship Challenge
**Code:** https://github.com/Bharadwaja04/Karyam (MIT licence, runs locally in a browser)

## The problem
People plan out loud: "tomorrow the DBMS assignment, then call Amma, oh and the gym, no wait, gym is Friday." Most to-do apps only accept clean, typed forms with a title, a date and a priority. They do not handle messy speech, corrections, or a mix of Telugu, Hindi and English in one breath. For students and young professionals in India who switch languages naturally, typing a structured task list is friction, so tasks stay in their heads and get forgotten.

## The solution
Karyam lets you tap the mic and ramble. It turns the speech into a clean, ordered plan and reads the plan back to you.

1. **Listen:** Gnani **Prisma** (speech to text) transcribes the recording. The user picks the language (Telugu, Hindi, English and seven more Indian languages are supported).
2. **Understand:** an LLM (Google Gemini, through an OpenAI-compatible endpoint) extracts tasks, due times, priorities and categories. It handles self-corrections, so "gym is Friday" overrides the earlier "gym tomorrow".
3. **Validate:** the server checks the model's output against a strict shape, so a malformed reply never breaks the app.
4. **Plan:** tasks reorder themselves by urgency and time. Overdue work rolls forward automatically.
5. **Speak:** Gnani **Timbre** (text to speech) reads the plan aloud, so the app can be used hands-free.
6. **Remind:** browser notifications fire for upcoming tasks while the tab is open.

## Why it is different
- Speech is the input, not an add-on. There are no forms to fill.
- Corrections and mixed languages are expected, not edge cases.
- **Privacy by design:** tasks live only in the browser's local storage. The backend is a stateless proxy that stores nothing. Users bring their own API keys.

## Engineering quality
- 79 backend tests, 18 logic tests and 24 browser end-to-end tests, run against fake Gnani and LLM servers.
- Stress and fuzz testing found and fixed 9 real bugs: wrongly shaped input giving 500 errors, unbounded memory in the rate limiter, no request-size cap, chunked-body bypass, and non-JSON replies from the speech API.
- Safeguards include an SSRF guard on custom LLM URLs, per-IP rate limiting and request body limits.

## Honest limits
- Reminders work only while the browser tab is open.
- One speech language is selected at a time, not auto-detected.
- Tested against simulated services in automation; real Gnani and Gemini keys were checked by hand.
- All demo data is synthetic.

## Models used
Gnani Prisma (STT), Gnani Timbre (TTS), Google Gemini 2.5 Flash (LLM).

## Next steps
Auto language detection per sentence, installable app with background reminders, and shared lists for study groups.
