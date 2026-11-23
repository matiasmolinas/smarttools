// The job in progress survives a closed page: the draft in localStorage, and what the next start does with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearJobDraft, readJobDraft, writeJobDraft } from "../lib/memory.ts";
import { JobRecorder, defaultContext, draftAction, resumableHoles, type HoleRecord, type JobRecord } from "../lib/jobrecord.ts";
import { SHEET_PLAN, type Plan } from "../lib/plan.ts";

class FakeStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

const hole = (name: string): HoleRecord => ({ name, face: "sheet", size: "Ø6 mm", plannedMm: 35, seatedMm: 35, maxAngleDeg: 0.2, startedAt: "2026-11-20T12:00:00.000Z", endedAt: "2026-11-20T12:00:10.000Z", score: 90 });

function draftOf(plan: Plan, names: string[]): JobRecord {
  const job = new JobRecorder(plan, defaultContext(), () => undefined).finish();
  return { ...job, holes: names.map(hole) };
}

test("the draft is written, read back and cleared", () => {
  const st = new FakeStorage();
  assert.equal(readJobDraft(st), null);
  const d = draftOf(SHEET_PLAN, ["A1"]);
  writeJobDraft(d, st);
  assert.deepEqual(readJobDraft(st), d);
  clearJobDraft(st);
  assert.equal(readJobDraft(st), null);
});

test("anything that is not a job record is not a draft", () => {
  const st = new FakeStorage();
  st.setItem("st-job-draft", "{not json");
  assert.equal(readJobDraft(st), null);
  st.setItem("st-job-draft", JSON.stringify({ kind: "something-else", id: "x", holes: [], plan: { id: "p" } }));
  assert.equal(readJobDraft(st), null);
  st.setItem("st-job-draft", JSON.stringify({ ...draftOf(SHEET_PLAN, []), holes: "A1" }));
  assert.equal(readJobDraft(st), null);
});

test("a storage that throws (private mode) never breaks the app", () => {
  const bad = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
  assert.equal(readJobDraft(bad), null);
  writeJobDraft(draftOf(SHEET_PLAN, ["A1"]), bad);
  clearJobDraft(bad);
});

test("at start: resume a draft of this plan, keep one of another plan, drop an empty one", () => {
  const other: Plan = { ...SHEET_PLAN, id: "other-plan", name: "Other" };
  assert.equal(draftAction(null, SHEET_PLAN), "none");
  assert.equal(draftAction(draftOf(SHEET_PLAN, []), SHEET_PLAN), "none");
  assert.equal(draftAction(draftOf(SHEET_PLAN, ["A1", "A2"]), SHEET_PLAN), "resume");
  assert.equal(draftAction(draftOf(other, ["A1"]), SHEET_PLAN), "save");
  // the same plan, but none of its holes are in it any more (edited): kept as an unfinished job
  assert.equal(draftAction(draftOf(SHEET_PLAN, ["Z9"]), SHEET_PLAN), "save");
});

test("only the plan's holes are resumed, each once", () => {
  const d = draftOf(SHEET_PLAN, ["A1", "Z9", "A1", "A3"]);
  assert.deepEqual(resumableHoles(d, SHEET_PLAN).map((h) => h.name), ["A1", "A3"]);
  const rec = new JobRecorder(SHEET_PLAN, defaultContext(), () => undefined, { resume: d });
  assert.deepEqual(rec.holes.map((h) => h.name), ["A1", "A3"]);
  const job = rec.finish();
  assert.equal(job.id, d.id);
  assert.equal(job.started, d.started);
  assert.equal(job.status, "aborted");
});
