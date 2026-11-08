// Pure logic for Karyam: state updates, dates, audio helpers. No DOM access, so it can be tested in Node.

export const uid = (prefix = "id") => `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
export const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : typeof v === "number" ? String(v).slice(0, n) : "");
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

// Anything read from storage or from disk may be old, hand-edited or damaged. Rebuild a state the page can always render.
export function sanitizeState(raw) {
  const out = emptyState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const seen = new Set();
  for (const p of list(raw.projects, 500)) {
    if (!p || typeof p !== "object" || !str(p.id, 60) || seen.has(String(p.id))) continue;
    seen.add(String(p.id));
    out.projects.push({ id: str(p.id, 60), name: str(p.name, 60) || "Untitled", kind: str(p.kind, 12) || "other", stage: str(p.stage, 60) || null, details: str(p.details, 200) || null, created: ISO_DAY.test(p.created) ? p.created : null });
  }
  const taskIds = new Set();
  for (const t of list(raw.tasks, 5000)) {
    if (!t || typeof t !== "object" || !str(t.id, 60) || taskIds.has(String(t.id))) continue;
    if (!seen.has(String(t.projectId))) continue;
    taskIds.add(String(t.id));
    const due = ISO_DAY.test(t.due) ? t.due : null;
    const at = due && HHMM.test(t.at) ? t.at : null;
    out.tasks.push({
      id: str(t.id, 60), projectId: String(t.projectId), title: str(t.title, 120) || "Untitled task", due, at,
      remindAt: due ? remindAt(due, at) : null, reminded: !!t.reminded,
      repeat: due && ["daily", "weekdays", "weekly"].includes(t.repeat) ? t.repeat : null,
      priority: ["high", "normal", "low"].includes(t.priority) ? t.priority : "normal",
      done: !!t.done, suggested: !!t.suggested, created: ISO_DAY.test(t.created) ? t.created : null,
    });
  }
  out.pending = list(raw.pending, 4).filter((q) => q && typeof q === "object" && str(q.id, 60) && str(q.text, 200)).map((q) => ({ id: str(q.id, 60), text: str(q.text, 200), project: str(q.project, 60) || null, options: list(q.options, 4).map((o) => str(o, 40)).filter(Boolean) }));
  out.memory = list(raw.memory, 50).filter((m) => m && typeof m === "object" && str(m.text, 140)).map((m) => ({ id: str(m.id, 60) || "m" + Math.random().toString(36).slice(2, 8), text: str(m.text, 140), created: ISO_DAY.test(m.created) ? m.created : null }));
  out.chat = list(raw.chat, 30).filter((c) => c && typeof c === "object" && str(c.text, 2000)).map((c) => ({ ...c, who: c.who === "you" ? "you" : "karyam", text: str(c.text, 2000) }));
  if (Number.isFinite(raw.updated)) out.updated = raw.updated;
  return out;
}

export function emptyState() {
  return { projects: [], tasks: [], pending: [], memory: [], chat: [] };
}

export function localISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function localNow(d = new Date()) {
  return `${localISO(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// When a task should ping you: its due time, or 09:00 on its due day when no time was given.
export function remindAt(due, at) {
  return due ? `${due}T${at || "09:00"}` : null;
}

export function fmtTime(at) {
  if (!at) return "";
  const [h, m] = at.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

// Open tasks whose reminder time has passed and that haven't pinged yet.
export function dueReminders(state, now) {
  return state.tasks.filter((t) => !t.done && !t.suggested && t.remindAt && !t.reminded && t.remindAt <= now);
}

const isoPlusDays = (iso, n) => new Date(parseISO(iso) + n * 86400000).toISOString().slice(0, 10);

// The next date for a repeating task, after the given date.
export function nextDue(dueISO, repeat) {
  let next = isoPlusDays(dueISO, repeat === "weekly" ? 7 : 1);
  if (repeat === "weekdays") {
    while ([0, 6].includes(new Date(parseISO(next)).getUTCDay())) next = isoPlusDays(next, 1);
  }
  return next;
}

// A repeating task never "completes": ticking it (or its reminder firing) moves it to the next day.
export function rollForward(task, todayISO) {
  let next = nextDue(task.due, task.repeat);
  if (next <= todayISO) {
    // Long overdue: jump straight to the first repeat after today instead of stepping one day at a time.
    const gap = Math.round((parseISO(todayISO) - parseISO(next)) / 86400000);
    if (task.repeat === "weekly") next = isoPlusDays(next, Math.ceil((gap + 1) / 7) * 7);
    else next = nextDue(todayISO, task.repeat);
  }
  task.due = next;
  task.remindAt = remindAt(next, task.at);
  task.reminded = false;
  task.done = false;
}

const REPEAT_LABEL = { daily: "every day", weekdays: "every weekday", weekly: "every week" };
export const repeatLabel = (r) => REPEAT_LABEL[r] || "";

// A spoken-style morning/day brief built from the plan alone (no model call, so it always works).
export function buildBrief(state, nowISO) {
  const today = nowISO.slice(0, 10);
  const hour = Number(nowISO.slice(11, 13));
  const hello = hour < 12 ? "Good morning." : hour < 17 ? "Good afternoon." : "Good evening.";
  const open = state.tasks.filter((t) => !t.done && !t.suggested);
  const sort = (xs) => sortTasks(xs).map((t) => (t.at ? `${t.title} at ${fmtTime(t.at)}` : t.title));
  const say = (xs) => (xs.length > 3 ? `${xs.slice(0, 3).join(", ")}, and ${xs.length - 3} more` : xs.join(", "));
  const overdue = open.filter((t) => t.due && t.due < today);
  const todays = open.filter((t) => t.due === today);
  const soon = open.filter((t) => t.due && t.due > today && daysBetween(today, t.due) <= 3);
  const parts = [hello];
  if (!overdue.length && !todays.length) parts.push("Nothing is due today.");
  if (todays.length) parts.push(`Today you have ${todays.length === 1 ? "one thing" : todays.length + " things"}: ${say(sort(todays))}.`);
  if (overdue.length) parts.push(`${overdue.length} ${overdue.length === 1 ? "task is" : "tasks are"} overdue: ${say(sort(overdue))}.`);
  if (soon.length) parts.push(`Coming up: ${say(sort(soon))}.`);
  if (!open.length) parts.push("Your plan is empty. Tell me what is on your mind.");
  return parts.join(" ");
}

export function snoozeTask(task, minutes, nowDate = new Date()) {
  const when = new Date(nowDate.getTime() + minutes * 60000);
  task.due = localISO(when);
  task.at = localNow(when).slice(11);
  task.remindAt = remindAt(task.due, task.at);
  task.reminded = false;
}

const parseISO = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

export function daysBetween(fromISO, toISO) {
  return Math.round((parseISO(toISO) - parseISO(fromISO)) / 86400000);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function relDue(iso, today) {
  if (!iso) return null;
  const diff = daysBetween(today, iso);
  const dt = new Date(parseISO(iso));
  const dateLabel = `${WEEKDAYS[dt.getUTCDay()]} ${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]}`;
  if (diff < 0) return { label: dateLabel, hint: `${-diff}d overdue`, overdue: true };
  if (diff === 0) return { label: "Today", hint: dateLabel, overdue: false };
  if (diff === 1) return { label: "Tomorrow", hint: dateLabel, overdue: false };
  return { label: dateLabel, hint: `in ${diff} days`, overdue: false };
}

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (a.due && b.due && (a.due !== b.due || a.at !== b.at)) return `${a.due}T${a.at || "00:00"}` < `${b.due}T${b.at || "00:00"}` ? -1 : 1;
    if (!!a.due !== !!b.due) return a.due ? -1 : 1;
    return (a.created || "").localeCompare(b.created || "");
  });
}

// What the server needs to know about the current plan (ids let the model refer to existing tasks).
export function compactState(state) {
  return {
    projects: state.projects.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      stage: p.stage,
      tasks: state.tasks
        .filter((t) => t.projectId === p.id)
        .map((t) => ({ id: t.id, title: t.title, due: t.due, at: t.at || null, repeat: t.repeat || null, done: t.done })),
    })),
  };
}

// Merge the server's structured result into the state. Returns a new state, stats and the ids that are new.
export function applyResult(state, result, today) {
  const s = structuredClone(state);
  const stats = { projects: 0, tasks: 0, updated: 0 };
  const fresh = new Set();

  const find = (name) => s.projects.find((p) => norm(p.name) === norm(name));
  const ensure = (name, meta = {}) => {
    let p = find(name);
    if (!p) {
      p = { id: uid("p"), name, kind: meta.kind || "other", stage: meta.stage || null, details: meta.details || null, created: today };
      s.projects.push(p);
      stats.projects++;
      fresh.add(p.id);
    } else {
      if (meta.kind && meta.kind !== "other" && (p.kind === "other" || !p.kind)) p.kind = meta.kind;
      if (meta.stage) p.stage = meta.stage;
      if (meta.details) p.details = meta.details;
    }
    return p;
  };

  for (const p of result.projects || []) ensure(p.name, p);

  for (const t of result.tasks || []) {
    const p = ensure(t.project || "Inbox");
    const dup = s.tasks.some((x) => x.projectId === p.id && norm(x.title) === norm(t.title));
    if (dup) continue;
    const task = {
      id: uid("t"),
      projectId: p.id,
      title: t.title,
      due: t.due || null,
      at: t.due ? t.time || null : null,
      remindAt: remindAt(t.due, t.time),
      reminded: false,
      repeat: t.due ? t.repeat || null : null,
      priority: t.priority || "normal",
      done: false,
      suggested: !!t.suggested,
      created: today,
    };
    s.tasks.push(task);
    fresh.add(task.id);
    stats.tasks++;
  }

  for (const u of result.updates || []) {
    const t = s.tasks.find((x) => x.id === u.task_id);
    if (!t) continue;
    if (u.action === "done") t.done = true;
    if (u.action === "move" && u.due) {
      t.due = u.due;
      t.at = u.time || null;
      t.remindAt = remindAt(t.due, t.at);
      t.reminded = false;
    }
    if (u.action === "delete") s.tasks = s.tasks.filter((x) => x.id !== u.task_id);
    stats.updated++;
  }

  for (const text of result.remember || []) {
    if (!(s.memory || []).some((m) => norm(m.text) === norm(text))) {
      s.memory = [...(s.memory || []), { id: uid("m"), text, created: today }].slice(-50);
      stats.remembered = (stats.remembered || 0) + 1;
    }
  }

  const answered = new Set(result.answered || []);
  s.pending = s.pending.filter((q) => !answered.has(q.id));
  for (const q of result.questions || []) s.pending.push({ id: q.id, text: q.text, project: q.project || null, options: q.options || [] });
  s.pending = s.pending.slice(-4);

  return { state: s, stats, fresh: [...fresh] };
}

export function toMarkdown(state, today) {
  const lines = [`# Karyam plan (${today})`, ""];
  for (const p of state.projects) {
    const tasks = sortTasks(state.tasks.filter((t) => t.projectId === p.id));
    if (!tasks.length && !p.stage) continue;
    lines.push(`## ${p.name}${p.stage ? ` (${p.stage})` : ""}`);
    if (p.details) lines.push(p.details);
    for (const t of tasks) {
      const due = t.due ? ` (due ${t.due}${t.at ? " " + t.at : ""})` : "";
      lines.push(`- [${t.done ? "x" : " "}] ${t.title}${due}${t.suggested ? " (suggested)" : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---- audio helpers -------------------------------------------------------------------------

export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

// 16-bit mono PCM WAV.
export function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const write = (off, str) => [...str].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  write(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  write(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// Splits a live recording into clips that fit Gnani's 60 second REST limit.
// Cuts at a short pause after `minCut` seconds, or at `maxCut` seconds whatever happens.
export class Segmenter {
  constructor(rate, opts = {}) {
    this.rate = rate;
    this.minCut = opts.minCut ?? 18;
    this.maxCut = opts.maxCut ?? 28;
    this.quietSeconds = opts.quietSeconds ?? 0.35;
    this.threshold = opts.threshold ?? 0.01;
    this.reset();
  }

  reset() {
    this.parts = [];
    this.length = 0;
    this.quietRun = 0;
  }

  take() {
    const out = new Float32Array(this.length);
    let off = 0;
    for (const p of this.parts) {
      out.set(p, off);
      off += p.length;
    }
    this.reset();
    return out;
  }

  feed(chunk) {
    const out = [];
    this.parts.push(chunk);
    this.length += chunk.length;
    this.quietRun = rms(chunk) < this.threshold ? this.quietRun + chunk.length : 0;
    const secs = this.length / this.rate;
    if ((secs >= this.minCut && this.quietRun >= this.quietSeconds * this.rate) || secs >= this.maxCut) out.push(this.take());
    return out;
  }

  flush() {
    if (this.length < 0.3 * this.rate) {
      this.reset();
      return null;
    }
    return this.take();
  }
}

// Clips with almost no signal are not worth spending credits on.
export const isSilent = (samples) => rms(samples) < 0.004;
