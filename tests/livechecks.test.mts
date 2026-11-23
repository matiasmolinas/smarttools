// Live Checks (lib/recipe.ts, lib/jobrecord.ts): while a plan that came from a recipe is worked, each finished
// hole is answered by the engine's measurements, and the steps that are not holes are confirmed by the person.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bindCheck, checkHole, checkJob, dueManual, parseRecipe, recipeFromPlan, recipeOfPlan, simulatorRecipePlan, tallyChecks, tallySoFar, tallyText, type StepCheck } from "../lib/recipe.ts";
import { JobRecorder, defaultContext, type Confirmation, type HoleRecord, type JobRecord } from "../lib/jobrecord.ts";
import { gateRecipe } from "../lib/gate.ts";
import { SHEET_PLAN, validatePlan } from "../lib/plan.ts";

const BRACKET = readFileSync(new URL("./fixtures/athos/bracket.md", import.meta.url), "utf8");
const bracket = parseRecipe(BRACKET);
const AT = "2026-11-23T12:00:00.000Z";

/** A drilled hole: depth error (mm) and max angle (deg) against 20 mm planned. */
const hole = (name: string, err = 0.1, angle = 0.4, flagged?: string): HoleRecord => ({
  name, face: "sheet", size: "Ø6 mm", plannedMm: 20, seatedMm: 20 + err, maxAngleDeg: angle, ...(flagged ? { flagged } : {}),
  startedAt: AT, endedAt: AT, score: 90,
});
const yes = (id: string): Confirmation => ({ id, ok: true, at: AT });
const no = (id: string): Confirmation => ({ id, ok: false, at: AT });

/** A job of the bracket recipe's plan with these holes and answers. */
function jobOf(holes: HoleRecord[], confirmations?: Confirmation[]): JobRecord {
  const plan = gateRecipe(BRACKET, { kind: "expert" }, AT).plan!;
  const job = new JobRecorder(plan, defaultContext(), () => undefined).finish();
  return { ...job, holes, ...(confirmations ? { confirmations } : {}) };
}

test("checkHole: a measured Check passes or fails on the hole's record", () => {
  const pass = checkHole(bracket, hole("D1", 0.12, 0.41))!;
  assert.equal(pass.id, "d1");
  assert.equal(pass.hole, "D1");
  assert.equal(pass.outcome.status, "pass");
  assert.equal(pass.outcome.detail, "depth +0.12 mm (±0.5) · angle 0.41° (≤ 1°)");
  const fail = checkHole(bracket, hole("D1", 0.8, 0.4))!;
  assert.equal(fail.outcome.status, "fail");
  assert.match(fail.outcome.detail, /depth \+0\.80 mm/);
  // a hole no step describes
  assert.equal(checkHole(bracket, hole("Z9")), null);
});

test("checkHole: a Check with words for the person waits for the answer; yes lets the measurements decide, no fails", () => {
  const md = BRACKET.replace("**Check:** flush with the surface", "**Check:** depth within 0.5 mm and flush with the surface");
  const r = parseRecipe(md);
  assert.equal(checkHole(r, hole("D2"))!.outcome.status, "manual");
  assert.match(checkHole(r, hole("D2"))!.outcome.detail, /confirm: depth within 0\.5 mm and flush/);
  // an answer for another step does not count
  assert.equal(checkHole(r, hole("D2"), [yes("d1")])!.outcome.status, "manual");
  const ok = checkHole(r, hole("D2"), [yes("d2")])!;
  assert.equal(ok.outcome.status, "pass");
  assert.match(ok.outcome.detail, /^depth \+0\.10 mm \(±0\.5\) · confirmed: /);
  const said = checkHole(r, hole("D2"), [no("d2")])!;
  assert.equal(said.outcome.status, "fail");
  assert.match(said.outcome.detail, /the person said no/);
  // yes, but a measurement failed: it fails
  assert.equal(checkHole(r, hole("D2", 1.2), [yes("d2")])!.outcome.status, "fail");
  // only words for the person (the fixture's D2): yes passes
  assert.equal(checkHole(bracket, hole("D2"), [yes("d2")])!.outcome.status, "pass");
});

test("dueManual: the steps written before the next hole that is not done, not yet answered", () => {
  assert.deepEqual(dueManual(bracket, [], []).map((s) => s.id), ["clamp"]);
  assert.deepEqual(dueManual(bracket, [], ["clamp"]), []);
  assert.deepEqual(dueManual(bracket, ["D1", "D2"], ["clamp"]), []);
  // a step after a hole is due only once that hole is done
  const r = parseRecipe(`${BRACKET.split("## History")[0]}\n## #sweep\n**Do:** Sweep the chips away\n**Check:** the holes are clean\n`);
  assert.deepEqual(dueManual(r, [], []).map((s) => s.id), ["clamp"]);
  assert.deepEqual(dueManual(r, ["D1"], ["clamp"]), []);
  assert.deepEqual(dueManual(r, ["D1", "D2"], ["clamp"]).map((s) => s.id), ["sweep"]);
  assert.deepEqual(dueManual(r, ["D1", "D2"], []).map((s) => s.id), ["clamp", "sweep"]);
});

test("checkJob uses the job's confirmations: answered steps pass or fail, unanswered ones wait", () => {
  const open = checkJob(bracket, jobOf([hole("D1")]));
  assert.deepEqual(open.map((c) => [c.id, c.outcome.status]), [["clamp", "manual"], ["d1", "pass"], ["d2", "fail"]]);
  assert.equal(open[2].outcome.detail, "not drilled");
  assert.equal(open[1].hole, "D1");
  assert.equal(open[0].hole, undefined);
  const done = checkJob(bracket, jobOf([hole("D1"), hole("D2")], [yes("clamp"), no("d2")]));
  assert.deepEqual(done.map((c) => c.outcome.status), ["pass", "pass", "fail"]);
  assert.match(done[0].outcome.detail, /^confirmed: the board does not move/);
  assert.match(done[2].outcome.detail, /the person said no/);
  assert.equal(checkJob(bracket, jobOf([hole("D1")], [no("clamp")]))[0].outcome.status, "fail");
});

test("tallyChecks counts pass, fail and to confirm", () => {
  const c = (status: StepCheck["outcome"]["status"]): StepCheck => ({ id: "x", do: "", outcome: { status, detail: "" } });
  assert.deepEqual(tallyChecks([]), { pass: 0, fail: 0, manual: 0 });
  assert.deepEqual(tallyChecks([c("pass"), c("pass"), c("fail"), c("manual")]), { pass: 2, fail: 1, manual: 1 });
  assert.deepEqual(tallyChecks(checkJob(bracket, jobOf([hole("D1")]))), { pass: 1, fail: 1, manual: 1 });
});

test("recipeOfPlan: the plan's recipe parsed, null when absent or unreadable", () => {
  assert.equal(recipeOfPlan(SHEET_PLAN), null);
  assert.equal(recipeOfPlan({ ...SHEET_PLAN, recipe: { id: "x", md: "# a title\n\nno statements" } }), null);
  assert.equal(recipeOfPlan({ ...SHEET_PLAN, recipe: { id: "x", md: 42 as unknown as string } }), null);
  const r = recipeOfPlan({ ...SHEET_PLAN, recipe: { id: "sheet", md: recipeFromPlan(SHEET_PLAN) } })!;
  assert.deepEqual(r.statements.map((s) => s.id), ["a1", "a2", "a3"]);
  assert.equal(recipeOfPlan(gateRecipe(BRACKET, { kind: "expert" }).plan!)!.id, "drill-a-bracket-pattern");
});

test("JobRecorder.confirm: one answer per step, kept by finish() and restored by resume", () => {
  const plan = gateRecipe(BRACKET, { kind: "expert" }, AT).plan!;
  const rec = new JobRecorder(plan, defaultContext(), () => undefined);
  assert.equal("confirmations" in rec.finish(), false); // none given: the field is left out
  rec.confirm("clamp", false, AT);
  rec.confirm("d2", true, AT);
  rec.confirm("clamp", true, "2026-11-23T12:01:00.000Z"); // a new answer replaces the old one
  assert.deepEqual(rec.confirmations, [yes("d2"), { id: "clamp", ok: true, at: "2026-11-23T12:01:00.000Z" }]);
  const job = rec.finish();
  assert.deepEqual(job.confirmations, rec.confirmations);
  // a draft carries them over, and they survive JSON (localStorage)
  const draft = JSON.parse(JSON.stringify({ ...job, holes: [hole("D1")] })) as JobRecord;
  const again = new JobRecorder(plan, defaultContext(), () => undefined, { resume: draft });
  assert.deepEqual(again.confirmations, job.confirmations);
  assert.deepEqual(again.finish().confirmations, job.confirmations);
  assert.deepEqual(checkJob(bracket, again.finish()).map((c) => c.outcome.status), ["pass", "pass", "fail"]); // D2 answered, but not drilled
});

test("tallySoFar: in a job still in progress a hole not drilled yet is to do, not a fail", () => {
  const job = jobOf([hole("D1")]);
  assert.deepEqual(tallySoFar(bracket, job), { pass: 1, fail: 0, manual: 1, todo: 1 });
  assert.deepEqual(tallyChecks(checkJob(bracket, job)), { pass: 1, fail: 1, manual: 1 }); // finished: "not drilled" fails
  assert.deepEqual(tallySoFar(bracket, jobOf([hole("D1", 0.9), hole("D2")], [no("clamp")])), { pass: 0, fail: 2, manual: 1, todo: 0 }); // D2 asks the person
  assert.deepEqual(tallySoFar(bracket, jobOf([])), { pass: 0, fail: 0, manual: 1, todo: 2 });
});

test("tallyText: pass and fail always, to confirm and to drill when not 0", () => {
  assert.equal(tallyText({ pass: 2, fail: 1, manual: 1, todo: 1 }), "2 pass · 1 fail · 1 to confirm · 1 to drill");
  assert.equal(tallyText({ pass: 3, fail: 0, manual: 0 }), "3 pass · 0 fail");
  assert.equal(tallyText({ pass: 0, fail: 0, manual: 0, todo: 3 }), "0 pass · 0 fail · 3 to drill");
});

test("simulatorRecipePlan: the sheet's holes, a step to confirm first, and A2's Check with words for the person", () => {
  const plan = simulatorRecipePlan();
  assert.equal(validatePlan(plan).ok, true);
  assert.deepEqual(plan.holes, SHEET_PLAN.holes); // the simulator's scene drills A1-A3
  assert.equal(plan.author.kind, "ai");
  const r = recipeOfPlan(plan)!;
  assert.deepEqual(r.statements.map((s) => s.id), ["clamp", "a1", "a2", "a3"]);
  assert.equal(r.meta.author, "ai");
  assert.deepEqual(dueManual(r, [], []).map((s) => s.id), ["clamp"]);
  assert.deepEqual(dueManual(r, [], ["clamp"]), []);
  const check = (id: string) => bindCheck(r.statements.find((s) => s.id === id)!.check);
  assert.equal(check("a1").manual, "");
  assert.notEqual(check("a2").manual, "");
  assert.equal(check("a2").measures.length, 2);
  const a2 = { ...hole("A2", 0.1, 0.3), plannedMm: 35, seatedMm: 35.1 };
  assert.equal(checkHole(r, a2)!.outcome.status, "manual");
  assert.equal(checkHole(r, a2, [yes("a2")])!.outcome.status, "pass");
});
