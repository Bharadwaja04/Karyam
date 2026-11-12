import test from "node:test";
import assert from "node:assert/strict";
import {
  Segmenter,
  applyResult,
  compactState,
  emptyState,
  encodeWav,
  isSilent,
  relDue,
  resample,
  sortTasks,
  toMarkdown,
} from "../frontend/logic.js";

const TODAY = "2026-10-22";

test("relDue labels", () => {
  assert.deepEqual(relDue("2026-10-22", TODAY), { label: "Today", hint: "Thu 22 Oct", overdue: false });
  assert.equal(relDue("2026-10-23", TODAY).label, "Tomorrow");
  assert.deepEqual(relDue("2026-10-27", TODAY), { label: "Tue 27 Oct", hint: "in 5 days", overdue: false });
  assert.deepEqual(relDue("2026-10-20", TODAY), { label: "Tue 20 Oct", hint: "2d overdue", overdue: true });
  assert.equal(relDue(null, TODAY), null);
});

test("applyResult builds projects, tasks, questions and ignores duplicates", () => {
  const result = {
    projects: [
      { name: "AI Engineer prep", kind: "personal" },
      { name: "Course project", kind: "course", stage: "Survey" },
    ],
    tasks: [
      { title: "Finish assignment", project: "Assignment", due: "2026-10-27", priority: "high" },
      { title: "Study system design", project: "AI Engineer prep", suggested: true },
      { title: "study system design", project: "ai engineer prep" },
    ],
    questions: [{ id: "q_1", text: "What kind of course project?", options: ["Research", "Build"] }],
  };
  const first = applyResult(emptyState(), result, TODAY);
  assert.equal(first.stats.tasks, 2);
  assert.equal(first.stats.projects, 3);
  assert.equal(first.state.pending.length, 1);
  assert.ok(first.fresh.length >= 5);
  const assignment = first.state.projects.find((p) => p.name === "Assignment");
  assert.equal(assignment.kind, "other");

  // same result again adds no duplicate tasks
  const second = applyResult(first.state, { tasks: result.tasks }, TODAY);
  assert.equal(second.stats.tasks, 0);
  assert.equal(second.state.tasks.length, 2);
});

test("applyResult handles updates and answered questions without mutating the input", () => {
  const base = applyResult(
    emptyState(),
    { tasks: [{ title: "A", project: "P" }, { title: "B", project: "P" }, { title: "C", project: "P" }], questions: [{ id: "q_1", text: "?" }] },
    TODAY,
  ).state;
  const [a, b, c] = base.tasks;
  const before = JSON.stringify(base);
  const out = applyResult(
    base,
    {
      updates: [
        { task_id: a.id, action: "done" },
        { task_id: b.id, action: "move", due: "2026-10-23" },
        { task_id: c.id, action: "delete" },
        { task_id: "missing", action: "done" },
      ],
      answered: ["q_1"],
    },
    TODAY,
  );
  assert.equal(JSON.stringify(base), before);
  assert.equal(out.stats.updated, 3);
  assert.equal(out.state.tasks.find((t) => t.id === a.id).done, true);
  assert.equal(out.state.tasks.find((t) => t.id === b.id).due, "2026-10-23");
  assert.equal(out.state.tasks.some((t) => t.id === c.id), false);
  assert.equal(out.state.pending.length, 0);
});

test("a later answer upgrades an 'other' project kind and sets the stage", () => {
  const s1 = applyResult(emptyState(), { tasks: [{ title: "x", project: "Course project" }] }, TODAY).state;
  const s2 = applyResult(s1, { projects: [{ name: "course project", kind: "course", stage: "Survey" }] }, TODAY).state;
  assert.equal(s2.projects.length, 1);
  assert.equal(s2.projects[0].kind, "course");
  assert.equal(s2.projects[0].stage, "Survey");
});

test("sortTasks: open before done, soonest due first, undated last", () => {
  const sorted = sortTasks([
    { id: 1, done: true, due: "2026-10-23" },
    { id: 2, done: false, due: null, created: "a" },
    { id: 3, done: false, due: "2026-10-30" },
    { id: 4, done: false, due: "2026-10-25" },
  ]).map((t) => t.id);
  assert.deepEqual(sorted, [4, 3, 2, 1]);
});

test("compactState and toMarkdown", () => {
  const s = applyResult(emptyState(), { tasks: [{ title: "Do it", project: "P", due: "2026-10-27", suggested: true }] }, TODAY).state;
  const compact = compactState(s);
  assert.equal(compact.projects[0].tasks[0].title, "Do it");
  assert.ok(compact.projects[0].tasks[0].id.startsWith("t_"));
  const md = toMarkdown(s, TODAY);
  assert.match(md, /## P/);
  assert.match(md, /- \[ \] Do it \(due 2026-10-27\) \(suggested\)/);
});

test("resample and WAV encoding", () => {
  const input = new Float32Array(48000).fill(0.5);
  const out = resample(input, 48000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[100] - 0.5) < 1e-6);
  const wav = encodeWav(out, 16000);
  assert.equal(wav.length, 44 + 16000 * 2);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
});

test("Segmenter cuts at a pause after the minimum, or at the hard cap", () => {
  const rate = 16000;
  const loud = new Float32Array(2048).fill(0.2);
  const quiet = new Float32Array(2048).fill(0);
  const seg = new Segmenter(rate);
  const clips = [];
  // 19s of speech: no cut yet
  for (let i = 0; i < Math.floor((19 * rate) / 2048); i++) clips.push(...seg.feed(loud));
  assert.equal(clips.length, 0);
  // a pause triggers the cut
  for (let i = 0; i < 4; i++) clips.push(...seg.feed(quiet));
  assert.equal(clips.length, 1);
  assert.ok(clips[0].length / rate >= 19 && clips[0].length / rate < 21);

  // continuous speech is cut at the 28s cap
  const seg2 = new Segmenter(rate);
  let cut = null;
  let fed = 0;
  while (!cut) {
    const out = seg2.feed(loud);
    fed += 2048;
    if (out.length) cut = out[0];
  }
  assert.ok(fed / rate >= 28 && fed / rate < 29);

  // short tails are dropped, longer ones kept
  const seg3 = new Segmenter(rate);
  seg3.feed(loud);
  assert.equal(seg3.flush(), null);
  for (let i = 0; i < 4; i++) seg3.feed(loud);
  assert.ok(seg3.flush().length > 0);
});

test("isSilent", () => {
  assert.equal(isSilent(new Float32Array(1000)), true);
  assert.equal(isSilent(new Float32Array(1000).fill(0.1)), false);
});

import { remindAt, dueReminders, snoozeTask, fmtTime, localNow } from "../frontend/logic.js";

test("reminders: date-only defaults to 09:00, times are exact, snooze reschedules", () => {
  assert.equal(remindAt("2026-10-27", null), "2026-10-27T09:00");
  assert.equal(remindAt("2026-10-27", "17:30"), "2026-10-27T17:30");
  assert.equal(remindAt(null, "17:30"), null);
  assert.equal(fmtTime("17:05"), "5:05 PM");
  assert.equal(fmtTime("00:10"), "12:10 AM");
  const state = { tasks: [
    { id: "a", done: false, remindAt: "2026-10-22T19:00", reminded: false },
    { id: "b", done: false, remindAt: "2026-10-22T20:00", reminded: false },
    { id: "c", done: true, remindAt: "2026-10-22T18:00", reminded: false },
    { id: "d", done: false, suggested: true, remindAt: "2026-10-22T18:00", reminded: false },
    { id: "e", done: false, remindAt: "2026-10-22T18:00", reminded: true },
  ] };
  assert.deepEqual(dueReminders(state, "2026-10-22T19:23").map((t) => t.id), ["a"]);
  const t = { done: false };
  snoozeTask(t, 10, new Date(2026, 9, 22, 23, 55));
  assert.equal(t.remindAt, "2026-10-23T00:05");
  assert.equal(t.reminded, false);
  assert.match(localNow(new Date(2026, 9, 5, 7, 3)), /^2026-10-05T07:03$/);
});

import { nextDue, rollForward, buildBrief } from "../frontend/logic.js";

test("repeating tasks roll to the next day and skip weekends", () => {
  assert.equal(nextDue("2026-10-23", "daily"), "2026-10-24");
  assert.equal(nextDue("2026-10-23", "weekdays"), "2026-10-26"); // Fri -> Mon
  assert.equal(nextDue("2026-10-23", "weekly"), "2026-10-30");
  const t = { due: "2026-10-01", at: "08:00", repeat: "daily", done: true };
  rollForward(t, "2026-10-22"); // was away for three weeks: jump to the first day after today
  assert.deepEqual([t.due, t.remindAt, t.reminded, t.done], ["2026-10-23", "2026-10-23T08:00", false, false]);
});

test("memory is added once and repeat is kept", () => {
  const out = applyResult(emptyState(), { remember: ["Exams start 12 Nov", "exams  start 12 nov"], tasks: [{ title: "Medicine", project: "Health", due: "2026-10-23", time: "08:00", repeat: "daily" }] }, "2026-10-22");
  assert.equal(out.state.memory.length, 1);
  assert.equal(out.state.tasks[0].repeat, "daily");
});

test("brief names today's items, overdue items and what is coming", () => {
  const s = emptyState();
  s.tasks = [
    { id: "1", title: "Call vendor", due: "2026-10-22", at: "17:00", done: false },
    { id: "2", title: "Old thing", due: "2026-10-20", done: false },
    { id: "3", title: "Report", due: "2026-10-24", done: false },
    { id: "4", title: "Hidden suggestion", due: "2026-10-22", suggested: true, done: false },
  ];
  const text = buildBrief(s, "2026-10-22T08:15");
  assert.match(text, /^Good morning\./);
  assert.match(text, /Today you have one thing: Call vendor at 5:00 PM\./);
  assert.match(text, /1 task is overdue: Old thing\./);
  assert.match(text, /Coming up: Report\./);
  assert.doesNotMatch(text, /Hidden/);
  assert.match(buildBrief(emptyState(), "2026-10-22T20:00"), /Good evening\. Nothing is due today\. Your plan is empty/);
});

// ---------------------------------------------------------------- stress and robustness

import { sanitizeState } from "../frontend/logic.js";

test("rollForward from years ago lands on the first repeat after today, fast", () => {
  const t0 = Date.now();
  for (const [repeat, due] of [["daily", "2019-01-01"], ["weekdays", "2019-01-01"], ["weekly", "2019-01-01"]]) {
    const task = { due, repeat, at: "08:00" };
    rollForward(task, "2026-10-22");
    assert.ok(task.due > "2026-10-22", `${repeat}: ${task.due}`);
    assert.ok(task.due <= "2026-10-29", `${repeat}: ${task.due} is too far ahead`);
    assert.equal(task.remindAt, `${task.due}T08:00`);
    if (repeat === "weekly") assert.equal(new Date(task.due + "T00:00:00Z").getUTCDay(), new Date("2019-01-01T00:00:00Z").getUTCDay());
    if (repeat === "weekdays") assert.ok(![0, 6].includes(new Date(task.due + "T00:00:00Z").getUTCDay()));
  }
  assert.ok(Date.now() - t0 < 200);
});

test("sanitizeState turns any junk into a state the page can render", () => {
  for (const junk of [null, undefined, 5, "x", [], {}, { projects: 5 }, { projects: [null, 1, "a", {}], tasks: {} }, { tasks: [{ id: 1 }], projects: [{ id: "p" }] }]) {
    const s = sanitizeState(junk);
    for (const k of ["projects", "tasks", "pending", "memory", "chat"]) assert.ok(Array.isArray(s[k]), k);
  }
});

test("sanitizeState drops orphan tasks and bad dates but keeps good data", () => {
  const s = sanitizeState({
    projects: [{ id: "p1", name: "Thesis" }, { id: "p1", name: "dupe" }],
    tasks: [
      { id: "t1", projectId: "p1", title: "Write", due: "2026-10-30", at: "09:00", repeat: "daily", priority: "high" },
      { id: "t2", projectId: "gone", title: "Orphan" },
      { id: "t3", projectId: "p1", title: "Bad", due: "tomorrow", at: "25:99", repeat: "hourly", priority: "urgent" },
    ],
  });
  assert.equal(s.projects.length, 1);
  assert.deepEqual(s.tasks.map((t) => t.id), ["t1", "t3"]);
  assert.equal(s.tasks[0].remindAt, "2026-10-30T09:00");
  assert.deepEqual([s.tasks[1].due, s.tasks[1].at, s.tasks[1].repeat, s.tasks[1].priority], [null, null, null, "normal"]);
});

test("a 5000-task plan renders its brief, sort, markdown and compact copy quickly", () => {
  const state = { projects: [{ id: "p", name: "P", kind: "work" }], tasks: Array.from({ length: 5000 }, (_, i) => ({ id: "t" + i, projectId: "p", title: "task " + i, due: `2026-11-${String((i % 28) + 1).padStart(2, "0")}`, at: "09:00", remindAt: `2026-11-${String((i % 28) + 1).padStart(2, "0")}T09:00`, done: i % 3 === 0, priority: "normal", repeat: null }))
    , pending: [], memory: [], chat: [] };
  const t0 = Date.now();
  buildBrief(state, "2026-11-06T08:00");
  sortTasks(state.tasks);
  toMarkdown(state, "2026-11-06");
  compactState(state);
  dueReminders(state, "2026-11-30T23:59");
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
});

test("applyResult survives 2000 random model results without throwing or growing without bound", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let state = emptyState();
  for (let i = 0; i < 2000; i++) {
    const result = {
      projects: rnd() < 0.5 ? [{ name: pick(["A", "B", "a", "C", "", "Ünï"]), kind: pick(["work", "other", undefined]) }] : undefined,
      tasks: rnd() < 0.8 ? [{ title: pick(["x", "y", "z", "w" + (i % 50)]), project: pick(["A", "B", undefined]), due: pick([null, "2026-11-10", undefined]), time: pick([null, "09:00"]), repeat: pick([null, "daily"]) }] : null,
      updates: rnd() < 0.3 ? [{ task_id: pick(state.tasks.length ? state.tasks.map((t) => t.id) : ["nope"]), action: pick(["done", "move", "delete", "bogus"]), due: "2026-11-12" }] : [],
      remember: rnd() < 0.2 ? ["fact " + (i % 80)] : [],
      questions: rnd() < 0.2 ? [{ id: "q" + i, text: "?", options: ["a", "b"] }] : [],
      answered: [],
    };
    state = applyResult(state, result, "2026-11-06").state;
  }
  assert.ok(state.memory.length <= 50);
  assert.ok(state.pending.length <= 4);
  assert.equal(new Set(state.tasks.map((t) => t.id)).size, state.tasks.length);
  assert.equal(new Set(state.projects.map((p) => p.id)).size, state.projects.length);
});

test("renames translate old project and task names, and new tasks join the renamed project", () => {
  const base = applyResult(emptyState(), { projects: [{ name: "సమర్పణలు", kind: "assignment" }], tasks: [{ title: "అసైన్మెంట్", project: "సమర్పణలు", due: null }] }, TODAY).state;
  const taskId = base.tasks[0].id;
  const out = applyResult(base, {
    renames: [{ project_from: "సమర్పణలు", to: "Submissions" }, { task_id: taskId, to: "Submit assignment" }],
    tasks: [{ title: "Submit project", project: "Submissions", due: null }],
  }, TODAY).state;
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].name, "Submissions");
  assert.deepEqual(out.tasks.map((t) => t.title).sort(), ["Submit assignment", "Submit project"]);
});

test("renaming into an existing project merges instead of duplicating", () => {
  let s = applyResult(emptyState(), { projects: [{ name: "Submissions" }, { name: "సమర్పణలు" }], tasks: [{ title: "A", project: "Submissions" }, { title: "B", project: "సమర్పణలు" }] }, TODAY).state;
  s = applyResult(s, { renames: [{ project_from: "సమర్పణలు", to: "Submissions" }] }, TODAY).state;
  assert.equal(s.projects.length, 1);
  assert.equal(s.tasks.length, 2);
});
