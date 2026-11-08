# Karyam launch kit (Gnani Great Indian AI Internship Challenge)

Deadline: **11:59 PM IST, Tuesday 10 November 2026. Fixed, no extensions.** Plan to submit on Monday 9 Nov.

## What Gnani says it checks (from gnani.ai's challenge page)

- Post a public demo on LinkedIn and/or X. **Both hashtags on every nominated post:** #GreatIndianAIInternshipChallenge #GnaniAI. Tag Gnani AI.
- Tagging is not enough. You must **nominate the post links** in the submission form. The post must be live before you submit.
- Submit: demo video or working demo, written explanation (problem, users, each person's contribution), the Gnani models used, post links.
- Shortlist = eligible projects with the strongest **verified engagement** (reactions, comments, reshares as of the cutoff). Then a one-to-one interview. Only a written offer confirms an internship.
- Not allowed: bought engagement, bots, paid promotion, engagement exchanges or pods, plagiarism, misleading demos.
- Synthetic data only. No real phone numbers, account numbers, Aadhaar, PAN or recorded calls.
- Gnani's own words: "A demo that fakes a result will cost you more than one that shows an honest limitation."
- Awards (Rs 50,000 each, one per entrant) that fit Karyam: **Mixed Vibes** (code-mixed voice), **Solo Ninja**, **Demo Day Drop** (best 60-second video), **Jugaad Genius** (creative use), **Main Character** (regional language, if your demo is Telugu).

## Karyam's one-line pitch

> A voice-first personal assistant for people who think in two languages at once. Say your day messy, in Telugu, Hindi or English mixed. It sorts it into a plan, asks you questions out loud, reminds you at the right time, and remembers what you tell it.

What the other public entries look like (so you can be better, not just different):
- Bolo (forms by voice) and KisanSetu (farmer assistant) are institutional/farmer tools. Karyam is personal, for daily life.
- Both had gaps when I looked: no demo video yet, no measured results, placeholder text left in the README, no licence file. You can beat that with a 60-second video, 3 measured numbers, a clean README and an MIT licence (added).

## 4-day plan

| Day | Do | Done when |
|---|---|---|
| Fri 6 Nov | Put real keys in `.env`. Run `./start.sh`. Speak 10 real sentences (Telugu+English, Hindi+English, English). Note what breaks. Fix or cut anything flaky. | A full voice loop works with real Gnani + your LLM at least 8 times out of 10 |
| Sat 7 Nov | Measure: speech-to-text time, extraction correct on your 10 sentences. Record the demo. Push to GitHub (README screenshots, LICENSE, no keys). Post on LinkedIn **and** X in the evening. | Both posts live, repo public |
| Sun 8 Nov | Reply to every comment within the hour. Message people directly and ask them to try it. Share in IIIT-H groups and Gnani's Discord. | 10+ genuine conversations |
| Mon 9 Nov | Fill the registration form, nominate both post links, paste the explanation below. Submit. Screenshot the confirmation. | Submission confirmed |
| Tue 10 Nov | Buffer. Keep replying. Do not change the posts' links. | Nothing to do before 11:59 PM |

## The measured numbers to put in the post and README (fill honestly)

- Speech-to-text round trip on a 20-second clip: ___ s (your stopwatch or the API's own timing).
- Tasks correct on your 10 test sentences: ___ / 10 (count tasks and dates correct; do not round up).
- Tests: 45 backend + 13 logic tests passing (`pytest -q tests` and `node --test tests/logic.test.mjs`).
Do not publish a number you did not measure.

## LinkedIn post (fill the brackets, then post)

I talk to my to-do list now. And it talks back.

For the Great Indian AI Internship Challenge by Gnani.ai, I built Karyam (కార్యం, Telugu for "task"): a voice-first personal assistant for people who think in two languages at once.

I just say my day, messy, in Telugu + English:
"Assignment due in 5 days, then AI prep, and remind me at 6 to call the vendor."

Karyam:
→ sorts it into projects, tasks and dates
→ asks me a question out loud when something is unclear, and I answer by voice
→ reminds me at the right time, in a voice
→ remembers things like "my exams start 12 Nov"
→ opens apps and searches, but only after I allow it

Built on Gnani Prisma (speech to text) and Timbre (text to speech). Open source, solo build.

What I measured: [speech-to-text about ___ s on a 20-second clip; ___ of 10 test sentences sorted correctly].
What it can't do yet: [one honest limitation, e.g. "reminders only fire while the app is running"].

60-second demo 👇 [video]
Code (MIT): [GitHub link]

If you have ever lost a task because typing was too slow, try it and tell me what breaks.

@Gnani.ai #GreatIndianAIInternshipChallenge #GnaniAI

(Type @Gnani and choose the company page from the dropdown so the tag actually links.)

## X post (keep both hashtags; check the length)

I built Karyam (కార్యం): talk to your to-do list in a Telugu/Hindi + English mix. It sorts tasks, asks questions by voice, reminds you, remembers. Built on Gnani Prisma + Timbre. Open source. Demo below.
[Gnani AI handle] #GreatIndianAIInternshipChallenge #GnaniAI

## 60-second demo script (this also enters Demo Day Drop)

Rules: show it working in the first 10 seconds. Add English captions. Use synthetic content only (fake names, no real numbers). Record screen and mic together (Mac: QuickTime, Windows: Win+G).

| Time | On screen | You say or show |
|---|---|---|
| 0-10 s | Talk page, tap the mic | Say your real mixed sentence. Suggested: "Naku 5 days lo assignment undi, taruvata AI prep start cheyyali, and 6 ki vendor ki call cheyyi ani remind chey." Use your own words. |
| 10-20 s | Plan page, project cards and dated tasks | Let it sit for a beat so people can read it. |
| 20-30 s | Karyam asks a question aloud, you answer by voice | Pick a vague input like "course project" so it must ask. |
| 30-40 s | A reminder card pops up and speaks | Set one for 1 minute ahead before recording. |
| 40-50 s | Say "what's due today?", then "remind me in 2 minutes to drink water" | Shows answering and a reminder firing. |
| 50-60 s | End card: Karyam · Gnani Prisma + Timbre · GitHub link · one honest limitation | Say the limitation out loud. |

## Written explanation for the submission form (edit to be true)

**Problem.** People who think in mixed languages (for me, Telugu and English) lose tasks because typing is slow and to-do apps expect one language and tidy input.
**Users.** Students and young professionals in India who juggle assignments, projects and reminders and prefer to speak.
**What I built.** Karyam is a voice-first personal assistant. Speech goes to Gnani Prisma (speech to text). A language model turns the transcript into projects, tasks, dates and times, answers questions about the plan, asks clarifying questions, remembers facts you tell it and repeats tasks on a schedule. Gnani Timbre (text to speech) speaks questions, replies and reminders.
**Gnani models used.** Prisma v2.5 (STT) and Timbre v2.5 (TTS). [Evon is not used because it has no hosted API yet.]
**My contribution.** Solo: everything (backend, frontend, prompts, tests, design).
**Honest limitations.** [Reminders fire only while the app or server is running. Extraction quality depends on the language model. Tested on my own voice only.]

## Interview prep (you will be asked to explain your own code)

- Walk through one request from mic to screen. (recording → 16 kHz clips → /api/transcribe → /api/extract → validated JSON → plan.)
- Why does the server check the model's JSON? (Models make mistakes. The code drops unknown ids, past dates, bad times.)
- What happens when the model asks a question? How do pending questions get answered?
- How would you measure accuracy properly? What would you test next?
- What would you do with Evon once it has an API?
- What is the weakest part, and what would you fix first?

## Before you press post

- [ ] No keys anywhere in the repo (search for your key prefix). `.env` is git-ignored.
- [ ] README has 2 screenshots and the demo link, no placeholder text.
- [ ] LICENSE present (MIT, added).
- [ ] Claims are honest. Do NOT say "offline" or "works without internet": speech and the language model need the internet.
- [ ] Both hashtags on every post. Gnani AI tagged. Post links open when logged out.
- [ ] Demo contains no real personal data.
