import {
  Segmenter,
  applyResult,
  compactState,
  emptyState,
  sanitizeState,
  encodeWav,
  isSilent,
  localISO,
  relDue,
  resample,
  rms,
  sortTasks,
  toMarkdown,
  daysBetween,
  localNow,
  fmtTime,
  dueReminders,
  snoozeTask,
  rollForward,
  buildBrief,
  repeatLabel,
} from "./logic.js?v11";
import { audio, initFx } from "./fx.js?v11";

const $ = (id) => document.getElementById(id);
const STATE_KEY = "karyam.state.v1";
const SETTINGS_KEY = "karyam.settings.v1";
const CALM = matchMedia("(prefers-reduced-motion: reduce)").matches;

const readJSON = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
let storageWarned = false;
const writeJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    if (!storageWarned) {
      storageWarned = true;
      setTimeout(() => toast("Your browser is blocking saving. Karyam works, but changes may be lost when you close the tab."), 0);
    }
  }
};

let state = sanitizeState(readJSON(STATE_KEY, {}));
const CHAT_MAX = 30;
let settings = {
  gnaniKey: "",
  sttLang: "en-IN",
  ttsVoice: "Poorvi",
  ttsLang: "auto",
  speak: true,
  notify: true,
  speakReminders: true,
  llmUrl: "",
  llmModel: "",
  llmKey: "",
  ...readJSON(SETTINGS_KEY, {}),
};
let server = { server_gnani_key: false, server_llm: false };
let fresh = new Set();
let undoSnapshot = null;
let busy = false;
let rec = null; // active recording session
const player = new Audio();

const save = () => {
  state.updated = Date.now();
  writeJSON(STATE_KEY, state);
};

// ------------------------------------------------------------------ small helpers

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) n.append(kid);
  return n;
}

function setStatus(message, isError = false) {
  const s = $("status");
  s.textContent = message;
  s.classList.toggle("error", isError);
}

const setMicLabel = (text) => ($("micLabel").textContent = text);

let toastTimer = null;
function toast(message, actionLabel, action, ms = 9000) {
  const t = $("toast");
  t.replaceChildren(el("span", { text: message }));
  if (actionLabel) {
    t.append(
      el("button", {
        type: "button",
        text: actionLabel,
        onclick: () => {
          action();
          t.hidden = true;
        },
      }),
    );
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const gnaniHeaders = () => (settings.gnaniKey ? { "X-Gnani-Key": settings.gnaniKey } : {});
const llmHeaders = () => {
  const h = {};
  if (settings.llmUrl) h["X-LLM-Base-Url"] = settings.llmUrl;
  if (settings.llmModel) h["X-LLM-Model"] = settings.llmModel;
  if (settings.llmKey) h["X-LLM-Key"] = settings.llmKey;
  return h;
};

async function errorText(res) {
  try {
    const body = await res.json();
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail)) return "Invalid request.";
  } catch {
    /* not JSON */
  }
  return `Request failed (${res.status}).`;
}

function snapshot() {
  undoSnapshot = structuredClone(state);
}
function undo() {
  if (!undoSnapshot) return;
  state = undoSnapshot;
  undoSnapshot = null;
  fresh = new Set();
  save();
  render();
}

// Two pages in one document: #/ is Talk, #/plan is Plan.
function route() {
  const plan = location.hash.startsWith("#/plan");
  $("viewTalk").hidden = plan;
  $("viewPlan").hidden = !plan;
  $("navTalk").setAttribute("aria-current", plan ? "false" : "page");
  $("navPlan").setAttribute("aria-current", plan ? "page" : "false");
  window.scrollTo(0, 0);
  requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
}
function go(path) {
  if (location.hash === path) route();
  else location.hash = path;
}

// ------------------------------------------------------------------ rendering

const KIND_LABEL = { personal: "Personal", course: "Course", assignment: "Assignment", work: "Work", other: "" };
const CHECK_SVG = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 5 9.5 10 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="square"/></svg>';

function renderChat() {
  const log = $("chatLog");
  const turns = (state.chat || []).slice(-8);
  log.replaceChildren();
  if (!turns.length) {
    log.append(el("p", { class: "heard-text empty", text: "Nothing yet. Say hello, or ask what's due today." }));
    return;
  }
  for (const m of turns) {
    log.append(el("div", { class: `msg ${m.role}` }, el("p", { class: "who mono", text: m.role === "user" ? "You" : "Karyam" }), el("p", { text: m.text })));
  }
  log.scrollTop = log.scrollHeight;
}

function addChat(role, text) {
  if (!text) return;
  state.chat = [...(state.chat || []), { role, text: String(text).slice(0, 600) }].slice(-CHAT_MAX);
}

function renderMemory() {
  const list = $("memList");
  list.replaceChildren();
  for (const m of state.memory || []) {
    list.append(
      el(
        "li",
        {},
        el("span", { text: m.text }),
        el("button", {
          type: "button",
          text: "×",
          "aria-label": `Forget "${m.text}"`,
          onclick: () => {
            state.memory = state.memory.filter((x) => x.id !== m.id);
            save();
            renderMemory();
          },
        }),
      ),
    );
  }
  $("memEmpty").hidden = (state.memory || []).length > 0;
}

function render() {
  $("hero").classList.toggle("compact", state.tasks.length > 0);
  renderChat();
  renderMemory();
  renderBoard();
  renderQuestions();
}

function visibleProjects() {
  // Show every project the user created; only an empty catch-all Inbox is hidden.
  return state.projects.filter((p) => p.name !== "Inbox" || state.tasks.some((t) => t.projectId === p.id));
}

function renderStats(today, projectCount) {
  const open = state.tasks.filter((t) => !t.done);
  const due = open.filter((t) => t.due && daysBetween(today, t.due) <= 2);
  $("statTasks").textContent = String(open.length);
  $("statProjects").textContent = String(projectCount);
  $("statDue").textContent = String(due.length);
}

let filterId = null;

function renderToday(today) {
  const items = sortTasks(state.tasks.filter((t) => !t.done && !t.suggested && t.due && t.due <= today));
  $("todayWrap").hidden = !items.length;
  const list = $("todayList");
  list.replaceChildren();
  for (const t of items) {
    const project = state.projects.find((p) => p.id === t.projectId);
    list.append(taskEl(t, today, project ? project.name : null));
  }
}

function renderGrid(projects, today) {
  const grid = $("projectGrid");
  grid.replaceChildren();
  if (!projects.length) {
    grid.hidden = true;
    return;
  }
  grid.hidden = false;
  for (const p of projects) {
    const tasks = state.tasks.filter((t) => t.projectId === p.id);
    const open = tasks.filter((t) => !t.done);
    const pct = tasks.length ? Math.round(((tasks.length - open.length) / tasks.length) * 100) : 0;
    const dated = open.filter((t) => t.due).sort((a, b) => (a.due < b.due ? -1 : 1));
    const next = dated[0] ? relDue(dated[0].due, today) : null;
    const kind = KIND_LABEL[p.kind];
    grid.append(
      el(
        "button",
        {
          class: "pcard",
          type: "button",
          "aria-pressed": String(filterId === p.id),
          onclick: () => {
            filterId = filterId === p.id ? null : p.id;
            renderBoard();
          },
        },
        el("span", { class: "kicker mono" }, kind && kind.toLowerCase() !== p.name.trim().toLowerCase() ? el("span", { text: kind }) : null, p.stage ? el("span", { class: "tag", text: p.stage }) : null),
        el("h3", { text: p.name }),
        el("span", { class: "big" }, String(open.length), el("small", { class: "mono", text: open.length === 1 ? "open task" : "open tasks" })),
        el("span", { class: "bar", style: `--pct:${pct}%`, "aria-hidden": "true" }, el("i")),
        next ? el("span", { class: `next mono${next.overdue ? " overdue" : ""}`, text: `Next: ${next.label} · ${next.hint}` }) : el("span", { class: "next mono", text: tasks.length ? "No dates" : "No tasks yet" }),
      ),
    );
  }
}

function renderBoard() {
  const board = $("board");
  board.replaceChildren();
  const today = localISO();
  const projects = visibleProjects();
  if (filterId && !projects.some((p) => p.id === filterId)) filterId = null;
  renderStats(today, projects.length);
  renderToday(today);
  renderGrid(projects, today);
  const shown = filterId ? projects.filter((p) => p.id === filterId) : projects;
  $("boardTitle").textContent = filterId ? shown[0].name : "All tasks";
  $("clearFilter").hidden = !filterId;
  const badge = $("navCount");
  badge.hidden = !projects.length;
  badge.textContent = String(projects.length);
  if (!projects.length) {
    board.append(
      el(
        "div",
        { class: "empty" },
        el("p", { class: "empty-title", text: "Nothing here yet." }),
        el("p", { text: "Tap the mic and say what's on your plate. Mix languages, stammer, go back and forth. Karyam files it into projects with due dates." }),
      ),
    );
    return;
  }
  for (const p of shown) board.append(projectEl(p, today));
}

function projectEl(p, today) {
  const tasks = sortTasks(state.tasks.filter((t) => t.projectId === p.id));
  const done = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const kind = KIND_LABEL[p.kind];
  const showKind = kind && kind.toLowerCase() !== p.name.trim().toLowerCase();

  const side = el(
    "div",
    { class: "proj-side" },
    el("h3", { text: p.name }),
    el(
      "p",
      { class: "proj-meta mono" },
      showKind ? el("span", { text: kind }) : null,
      p.stage ? el("span", { class: "tag", text: p.stage }) : null,
      el("span", { text: tasks.length ? `${done} of ${tasks.length} done` : "No tasks yet" }),
    ),
    el("div", { class: "bar", style: `--pct:${pct}%`, "aria-hidden": "true" }, el("i")),
    el("button", { class: "mini mono proj-remove", type: "button", text: "Remove project", "aria-label": `Remove project ${p.name}`, onclick: () => removeProject(p) }),
  );
  const list = el("div", { class: "proj-tasks" });
  if (p.details) list.append(el("p", { class: "details", text: p.details }));
  for (const t of tasks) list.append(taskEl(t, today));
  if (!tasks.length) list.append(el("p", { class: "details", text: "No tasks yet. Say what needs doing for this project." }));
  return el("section", { class: `proj${fresh.has(p.id) ? " fresh" : ""}` }, side, list);
}

function taskEl(t, today, projectName = null) {
  const row = el("div", { class: `task${t.done ? " done" : ""}${t.suggested ? " suggested" : ""}${fresh.has(t.id) ? " fresh" : ""}` });
  const check = el("button", {
    class: "check",
    type: "button",
    role: "checkbox",
    "aria-checked": String(t.done),
    "aria-label": `Mark "${t.title}" ${t.done ? "not done" : "done"}`,
    onclick: () => {
      if (t.repeat && !t.done) {
        rollForward(t, localISO());
        toast(`Done. Next: ${relDue(t.due, localISO()).label.toLowerCase()}${t.at ? " at " + fmtTime(t.at) : ""}.`);
      } else {
        t.done = !t.done;
      }
      save();
      render();
    },
  });
  check.innerHTML = CHECK_SVG;

  const title = el("button", { class: "title", type: "button", text: t.title, "aria-label": `Edit "${t.title}"` });
  title.addEventListener("click", () => editTitle(t, title));

  const actions = el("div", { class: "row-actions" });
  if (t.suggested) {
    actions.append(
      el("button", { class: "mini mono", type: "button", text: "Keep", onclick: () => ((t.suggested = false), save(), render()) }),
      el("button", { class: "mini mono", type: "button", text: "Skip", onclick: () => removeTask(t) }),
    );
  }
  if (projectName) actions.append(el("span", { class: "proj-tag mono", text: projectName }));
  const due = relDue(t.due, today);
  if (due && !t.done) {
    const soon = !due.overdue && daysBetween(today, t.due) <= 2;
    const clock = t.at ? ` · ${fmtTime(t.at)}` : "";
    const again = t.repeat ? ` · ${repeatLabel(t.repeat)}` : "";
    actions.append(el("span", { class: `due mono${due.overdue ? " overdue" : soon ? " soon" : ""}`, text: `${due.label}${clock} · ${due.hint}${again}` }));
  }
  if (!t.suggested) {
    actions.append(el("button", { class: "mini remove", type: "button", text: "×", "aria-label": `Delete "${t.title}"`, onclick: () => removeTask(t) }));
  }
  row.append(check, title, actions);
  return row;
}

function editTitle(task, button) {
  const input = el("input", { class: "title-input", type: "text", value: task.title, "aria-label": "Edit task" });
  button.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    if (commit && v && v !== task.title) {
      task.title = v;
      save();
    }
    render();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function removeTask(t) {
  snapshot();
  state.tasks = state.tasks.filter((x) => x.id !== t.id);
  save();
  render();
  toast("Task removed.", "Undo", undo);
}

function removeProject(p) {
  snapshot();
  state.tasks = state.tasks.filter((t) => t.projectId !== p.id);
  state.projects = state.projects.filter((x) => x.id !== p.id);
  save();
  render();
  toast(`Removed ${p.name}.`, "Undo", undo);
}

function renderQuestions() {
  const box = $("question");
  const qs = state.pending;
  $("heroCopy").hidden = qs.length > 0;
  if (!qs.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  box.replaceChildren();
  for (const q of qs) {
    box.append(
      el(
        "div",
        { class: "q" },
        el("p", { class: "question-text", text: q.text }),
        q.options?.length
          ? el(
              "div",
              { class: "options" },
              q.options.map((o) => el("button", { class: "chip", type: "button", text: o, onclick: () => organize(o) })),
            )
          : null,
      ),
    );
  }
  box.append(
    el(
      "div",
      { class: "question-actions" },
      el("button", { class: "underline mono", type: "button", text: "Hear it again", onclick: () => speak(qs.map((q) => q.text).join(" "), true) }),
      el("span", { class: "hint mono", text: "or tap the mic and answer" }),
    ),
  );
}

// ------------------------------------------------------------------ speech out

async function speak(text, explicit = false) {
  if (!text || (!settings.speak && !explicit)) return;
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...gnaniHeaders() },
      body: JSON.stringify({ text: text.slice(0, 500), voice: settings.ttsVoice, model: "timbre-v2.5", language: settings.ttsLang }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const url = URL.createObjectURL(await res.blob());
    player.src = url;
    player.onended = () => URL.revokeObjectURL(url);
    await player.play();
  } catch (err) {
    console.warn("Speech output failed:", err);
    if (explicit) toast(`Couldn't play the voice: ${err.message}`);
  }
}

// ------------------------------------------------------------------ recording

const WORKLET = `
class KaryamCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === 2048) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('karyam-capture', KaryamCapture);`;

function hasGnaniAccess() {
  return !!settings.gnaniKey || server.server_gnani_key;
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    setStatus("This browser can't record here. Try a current Chrome, Edge or Safari, or type below.", true);
    return;
  }
  if (!hasGnaniAccess()) {
    setStatus("Add your Gnani API key in Settings first.", true);
    openSettings();
    return;
  }
  player.pause();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  } catch (err) {
    setStatus(
      err?.name === "NotFoundError"
        ? "No microphone found. Plug one in, or type below."
        : "Karyam can't hear you yet. Click the lock icon next to the address, set Microphone to Allow, then tap again. Or type below.",
      true,
    );
    return;
  }
  const ctx = new AudioContext();
  await ctx.resume();
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(moduleUrl);
  URL.revokeObjectURL(moduleUrl);

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "karyam-capture");
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  // The spectrum field and the ribbons read from here.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.7;
  source.connect(analyser);
  audio.analyser = analyser;
  audio.sampleRate = ctx.sampleRate;

  const session = { stream, ctx, node, source, mute, seg: new Segmenter(ctx.sampleRate), pieces: [], chain: Promise.resolve(), error: null, smooth: 0 };
  rec = session;
  clearTimeout(recTimer);
  recTimer = setTimeout(() => {
    if (rec === session) {
      setStatus("Stopped after 3 minutes. Tap the mic to keep going.");
      stopRecording();
    }
  }, 180000);
  node.port.onmessage = (e) => {
    const chunk = e.data;
    session.smooth = session.smooth * 0.7 + Math.min(1, rms(chunk) * 9) * 0.3;
    audio.level = session.smooth;
    for (const clip of session.seg.feed(chunk)) queueClip(clip, session);
  };

  $("mic").setAttribute("aria-pressed", "true");
  setMicLabel("Stop and sort");
  setStatus("Listening. Say it however it comes out, then tap again.");
  const heard = $("heard");
  heard.textContent = "Listening…";
  heard.classList.add("empty");
}

function queueClip(samples, r) {
  if (isSilent(samples)) return;
  const index = r.pieces.length;
  r.pieces.push("");
  r.chain = r.chain.then(async () => {
    if (r.error) return;
    try {
      const wav = encodeWav(resample(samples, r.ctx.sampleRate, 16000), 16000);
      const form = new FormData();
      form.append("audio", new Blob([wav], { type: "audio/wav" }), "clip.wav");
      form.append("language_code", settings.sttLang);
      const res = await fetch("/api/transcribe", { method: "POST", headers: gnaniHeaders(), body: form });
      if (!res.ok) throw new Error(await errorText(res));
      r.pieces[index] = (await res.json()).transcript || "";
      showHeard(r.pieces.join(" ").trim());
    } catch (err) {
      r.error = err;
    }
  });
}

function showHeard(text) {
  const h = $("heard");
  h.textContent = text || "Nothing yet.";
  h.classList.toggle("empty", !text);
}

let recTimer = null;
async function stopRecording() {
  clearTimeout(recTimer);
  const r = rec;
  rec = null;
  audio.analyser = null;
  audio.level = 0;
  setBusy(true, "Transcribing…");
  r.source.disconnect();
  r.node.port.onmessage = null;
  const tail = r.seg.flush();
  if (tail) queueClip(tail, r);
  r.stream.getTracks().forEach((t) => t.stop());
  await r.ctx.close();
  $("mic").setAttribute("aria-pressed", "false");

  await r.chain;
  const transcript = r.pieces.join(" ").replace(/\s+/g, " ").trim();
  if (r.error && !transcript) {
    setBusy(false, `Transcription failed: ${r.error.message}`, true);
    showHeard("");
    return;
  }
  if (!transcript) {
    setBusy(false, "I didn't catch anything. Tap the mic and try again.", true);
    showHeard("");
    return;
  }
  showHeard(transcript);
  if (r.error) toast(`Part of the recording failed: ${r.error.message}`);
  await organize(transcript, true);
}

function setBusy(on, message, isError = false) {
  busy = on;
  const mic = $("mic");
  mic.disabled = on;
  mic.dataset.busy = String(on);
  setMicLabel(on ? "Working…" : "Tap to talk");
  $("typeForm").querySelector("button").disabled = on;
  if (message) setStatus(message, isError);
}

// ------------------------------------------------------------------ planning

async function organize(text, fromVoice = false) {
  setBusy(true, "Thinking…");
  try {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...llmHeaders() },
      body: JSON.stringify({
        transcript: text,
        today: localISO(),
        now: localNow(),
        memory: (state.memory || []).map((m) => m.text),
        history: (state.chat || []).slice(-6),
        state: compactState(state),
        pending_questions: state.pending,
      }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const result = await res.json();
    snapshot();
    const out = applyResult(state, result, localISO());
    state = out.state;
    fresh = new Set(out.fresh);
    if (!fromVoice) $("typeInput").value = "";

    const parts = [];
    if (out.stats.tasks) parts.push(`${out.stats.tasks} task${out.stats.tasks === 1 ? "" : "s"}`);
    if (out.stats.projects) parts.push(`${out.stats.projects} project${out.stats.projects === 1 ? "" : "s"}`);
    if (out.stats.updated) parts.push(`${out.stats.updated} change${out.stats.updated === 1 ? "" : "s"}`);
    const noted = out.stats.remembered || 0;
    const summary = result.summary || (parts.length ? `Added ${parts.join(" and ")}.` : noted ? "Noted." : "Nothing new to add.");
    const said = result.reply || summary;

    addChat("user", text);
    addChat("karyam", [said, ...result.questions.map((q) => q.text)].join(" "));
    save();
    render();

    const qa = !parts.length && !noted && !!result.reply;
    setBusy(false, state.pending.length ? "I have a question for you." : qa ? result.reply : summary);
    if (parts.length || noted) toast(summary, parts.length ? "Undo" : null, undo);
    else if (!result.reply && !result.questions.length) toast("Nothing new to add.");

    if (result.questions.length) {
      speak([result.reply, ...result.questions.map((q) => q.text)].filter(Boolean).join(" "));
      go("#/");
    } else {
      if (fromVoice) speak(parts.length && !result.reply ? confirmation(summary, out.fresh) : said);
      if (parts.length) go("#/plan");
    }
    checkReminders();
  } catch (err) {
    setBusy(false, err.message, true);
    toast("Couldn't sort that. Keep it as a single task?", "Add to Inbox", () => addToInbox(text));
  }
}

function addToInbox(text) {
  snapshot();
  const out = applyResult(state, { tasks: [{ title: text.slice(0, 120), project: "Inbox", due: null }] }, localISO());
  state = out.state;
  fresh = new Set(out.fresh);
  save();
  render();
  setStatus("Added to Inbox.");
}

// ------------------------------------------------------------------ settings

function openSettings() {
  $("gnaniKey").value = settings.gnaniKey;
  $("sttLang").value = settings.sttLang;
  $("ttsVoice").value = settings.ttsVoice;
  $("ttsLang").value = settings.ttsLang;
  $("speakQuestions").checked = settings.speak;
  $("notifyOn").checked = settings.notify;
  $("speakReminders").checked = settings.speakReminders;
  $("llmUrl").value = settings.llmUrl;
  $("llmModel").value = settings.llmModel;
  $("llmKey").value = settings.llmKey;
  $("settings").showModal();
}

function llmReady() {
  return !!(settings.llmUrl && settings.llmModel) || !!server.server_llm;
}

// The first-run card: shows what is still missing, and disappears when everything is set.
function renderSetup() {
  const gnani = hasGnaniAccess();
  const llm = llmReady();
  $("stepGnani").classList.toggle("done", gnani);
  $("stepLlm").classList.toggle("done", llm);
  $("setup").hidden = gnani && llm;
}

function saveSettings() {
  settings = {
    gnaniKey: $("gnaniKey").value.trim(),
    sttLang: $("sttLang").value,
    ttsVoice: $("ttsVoice").value.trim() || "Poorvi",
    ttsLang: $("ttsLang").value,
    speak: $("speakQuestions").checked,
    notify: $("notifyOn").checked,
    speakReminders: $("speakReminders").checked,
    llmUrl: $("llmUrl").value.trim(),
    llmModel: $("llmModel").value.trim(),
    llmKey: $("llmKey").value.trim(),
  };
  writeJSON(SETTINGS_KEY, settings);
  askNotifyPermission();
  renderSetup();
  setStatus("Settings saved. Tap the mic and say what's on your plate.");
}

// ------------------------------------------------------------------ reminders

// What the assistant says after you speak: the model's summary plus the nearest reminder, in plain words.
function confirmation(summary, freshIds) {
  const next = state.tasks
    .filter((t) => freshIds.includes(t.id) && t.remindAt && !t.suggested)
    .sort((a, b) => (a.remindAt < b.remindAt ? -1 : 1))[0];
  if (!next) return summary;
  const rel = relDue(next.due, localISO());
  return `${summary} I'll remind you ${rel.label.toLowerCase() === "today" || rel.label === "Tomorrow" ? rel.label.toLowerCase() : "on " + rel.label} at ${fmtTime(next.at || "09:00")}.`;
}

function askNotifyPermission() {
  if (settings.notify && "Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

function fireReminder(task) {
  const repeats = !!task.repeat;
  const title = task.title;
  if (repeats) rollForward(task, localISO());
  else task.reminded = true;
  const project = state.projects.find((p) => p.id === task.projectId);
  const when = task.at ? fmtTime(task.at) : "today";
  const card = el(
    "div",
    { class: "reminder", role: "alert" },
    el("p", { class: "when mono", text: `Reminder · ${when}${project && project.name !== "Inbox" ? " · " + project.name : ""}` }),
    el("p", { class: "what", text: title }),
    el(
      "div",
      { class: "acts" },
      el("button", { type: "button", text: "Done", onclick: () => (repeats || (task.done = true), save(), card.remove(), render()) }),
      repeats ? null : el("button", { type: "button", text: "In 10 min", onclick: () => (snoozeTask(task, 10), save(), card.remove(), render()) }),
      repeats ? null : el("button", { type: "button", text: "In 1 hour", onclick: () => (snoozeTask(task, 60), save(), card.remove(), render()) }),
      el("button", { type: "button", text: "Dismiss", onclick: () => card.remove() }),
    ),
  );
  $("reminders").append(card);
  if (settings.notify && "Notification" in window && Notification.permission === "granted") {
    try {
      new Notification("Karyam", { body: title, tag: task.id });
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }
  if (settings.speakReminders && hasGnaniAccess()) speak(`Reminder. ${title}.`, true);
}

function checkReminders() {
  const due = dueReminders(state, localNow());
  if (!due.length) return;
  for (const t of due) fireReminder(t);
  save();
  render();
}

setInterval(checkReminders, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) checkReminders();
});

// ------------------------------------------------------------------ wiring

$("mic").addEventListener("click", () => {
  if (busy) return;
  askNotifyPermission();
  if (rec) stopRecording();
  else startRecording();
});

$("typeToggle").addEventListener("click", () => {
  const input = $("typeInput");
  input.scrollIntoView({ behavior: CALM ? "auto" : "smooth", block: "center" });
  input.focus({ preventScroll: true });
});
$("setupOpen").addEventListener("click", openSettings);

for (const chip of document.querySelectorAll(".chip")) {
  chip.addEventListener("click", () => {
    if (busy) return;
    if (!llmReady()) {
      setStatus("Connect a language model first, then tap the example again.", true);
      openSettings();
      return;
    }
    organize(chip.dataset.say);
  });
}

// Press Space anywhere (not while typing) to start or stop talking.
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.("input, textarea, select, button, a, summary, dialog, [contenteditable]")) return;
  if ($("viewTalk").hidden || $("settings").open || busy) return;
  e.preventDefault();
  $("mic").click();
});

$("testConn").addEventListener("click", async () => {
  const list = $("testResult");
  list.replaceChildren(el("li", { text: "Testing…" }));
  const headers = {};
  if ($("gnaniKey").value.trim()) headers["X-Gnani-Key"] = $("gnaniKey").value.trim();
  if ($("llmUrl").value.trim()) headers["X-LLM-Base-Url"] = $("llmUrl").value.trim();
  if ($("llmModel").value.trim()) headers["X-LLM-Model"] = $("llmModel").value.trim();
  if ($("llmKey").value.trim()) headers["X-LLM-Key"] = $("llmKey").value.trim();
  try {
    const res = await fetch("/api/selftest", { method: "POST", headers });
    if (!res.ok) throw new Error(await errorText(res));
    const out = await res.json();
    list.replaceChildren(
      el("li", { class: out.llm.ok ? "ok" : "bad", text: "Language model: " + out.llm.message }),
      el("li", { class: out.gnani.ok ? "ok" : "bad", text: "Gnani voice: " + out.gnani.message }),
    );
  } catch (err) {
    list.replaceChildren(el("li", { class: "bad", text: "Could not run the test: " + (err.message || "is Karyam still running?") }));
  }
});

let clearArmed = null;
$("clearData").addEventListener("click", () => {
  const btn = $("clearData");
  if (!clearArmed) {
    btn.textContent = "Click again to erase everything";
    clearArmed = setTimeout(() => {
      clearArmed = null;
      btn.textContent = "Erase my plan and settings";
    }, 5000);
    return;
  }
  clearTimeout(clearArmed);
  clearArmed = null;
  btn.textContent = "Erase my plan and settings";
  try {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    /* nothing to erase if storage is blocked */
  }
  state = sanitizeState(null);
  settings = { ...settings, gnaniKey: "", llmUrl: "", llmModel: "", llmKey: "" };
  save();
  render();
  renderChat();
  renderMemory();
  renderSetup();
  $("settings").close();
  toast("Everything was erased from this browser.");
});


$("briefBtn").addEventListener("click", () => {
  const text = buildBrief(state, localNow());
  addChat("karyam", text);
  save();
  render();
  setStatus(text);
  speak(text, true);
});

$("clearFilter").addEventListener("click", () => {
  filterId = null;
  renderBoard();
});
window.addEventListener("hashchange", route);

$("typeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("typeInput").value.trim();
  askNotifyPermission();
  if (text && !busy) organize(text);
});

$("settingsBtn").addEventListener("click", openSettings);
$("settingsForm").addEventListener("submit", (e) => {
  if (e.submitter?.id === "saveSettings") saveSettings();
});
$("cancelSettings").addEventListener("click", () => $("settings").close());

$("exportBtn").addEventListener("click", async () => {
  const md = toMarkdown(state, localISO());
  try {
    await navigator.clipboard.writeText(md);
    toast("Plan copied as Markdown.");
  } catch {
    const a = el("a", { href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })), download: "karyam-plan.md" });
    a.click();
  }
});

async function boot() {
  try {
    server = await (await fetch("/api/health")).json();
    renderSetup();
  } catch {
    /* the page still works from saved data; sending will report the problem */
  }
  checkReminders();
}

render();
route();
initFx();
checkReminders();
renderSetup();
boot();
