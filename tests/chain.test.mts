// One test through the whole chain: the pilot's recipe is gated, its plan worked on the real engine (scripted
// screws, no rendering), the job recorded, every Check answered, the job written as a ledger and the ledger verified.
// A second run drives one screw tilted past the Check's angle: it fails, and is still in the ledger.

import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mts";
import { fitPart, pilotPlan, PILOT_STEPS } from "../lib/pilot.ts";
import { gateRecipe } from "../lib/gate.ts";
import { planDepths, planTargets, type Plan } from "../lib/plan.ts";
import { checkJob, drillOf, recipeOfPlan, tallyChecks } from "../lib/recipe.ts";
import { JobRecorder, defaultContext, type JobRecord } from "../lib/jobrecord.ts";
import { jobLedger } from "../lib/ledger.ts";
import { verifyBundle, type Bundle } from "../lib/vcs.ts";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, PILOT_BLOCK, PILOT_SCREW_TIME, disturb, pilotBlockCorners, pilotHold, toolWorldFromHold } from "../lib/scene.ts";
import { smartToolsScene } from "../lib/scenedef.ts";
import { ScenarioRun } from "../lib/gallery/runner.ts";
import type { Scenario } from "../lib/gallery/scenarios.ts";

const AT = "2026-11-24T10:00:00.000Z";
const T0 = Date.parse(AT);
const rig = DEFAULT_RIG;
const BUILD = "abc1234";

/** The pilot plan for the block where the four sheets meet (its corners as touched, the real registration). */
function plan(): Plan {
  const fit = fitPart(pilotBlockCorners(PILOT_BLOCK) as [number, number, number][], (m, d) => core.registerPoints(m, d))!;
  assert.ok(fit.ok, `fit ${fit.why}`);
  return pilotPlan(fit, AT);
}

/** The four screws driven one after the other on the engine (the pilot's scripted person, motor vibration while
 * drilling); `tiltDeg` leans the bit of screw `bad` while it is driven. Returns the job record. */
function work(p: Plan, o: { bad?: number; tiltDeg?: number } = {}): JobRecord {
  const screwAt = (t: number) => {
    const k = Math.min(p.holes.length - 1, Math.floor(t / PILOT_SCREW_TIME));
    const h = p.holes[k];
    return { k, local: t - k * PILOT_SCREW_TIME, screw: { x: h.x, y: h.y, z: h.z ?? 0, depthMm: h.depthMm } };
  };
  const sc: Scenario = {
    id: "chain",
    title: "the pilot's four screws",
    kicker: "",
    summary: "",
    duration: p.holes.length * PILOT_SCREW_TIME + 1,
    view2d: "plan",
    segments: [{ from: 0, rig, label: "pilot" }],
    scene: () => smartToolsScene({ tool: rig.tool, targets: planTargets(p) }),
    depths: planDepths(p),
    tool: (ctx) => {
      const { k, local, screw } = screwAt(ctx.t);
      const { hold, phase } = pilotHold(core, rig, { phase: "work", corners: 0, screw }, local);
      const tilted = k === o.bad && (phase === "drill" || phase === "hold") ? { ...hold, pitchDeg: hold.pitchDeg + (o.tiltDeg ?? 0) } : hold;
      return { toolW: toolWorldFromHold(core, rig, disturb(tilted, ctx.t, phase, DEFAULT_DISTURBANCE)) };
    },
    panel: () => ({ caption: "" }),
  };
  const run = new ScenarioRun(core, sc);
  let f = run.step(0);
  const labels = new Set(p.holes.map((h) => h.label));
  const rec = new JobRecorder(p, defaultContext({ source: "simulation", build: BUILD, engineHash: core.wasmHash! }), (id) => (labels.has(f.scene.names[id]) ? f.scene.names[id] : undefined), { wall: (t) => T0 + t * 1000, t0: 0 });
  let tick = -1;
  for (let t = 0; t <= sc.duration; t += 1 / 60) {
    f = run.step(t);
    if (f.snap && f.snap.tick !== tick) (tick = f.snap.tick), rec.feed(f.snap);
  }
  run.dispose();
  // the steps no measurement answers: the person says yes to each
  for (const id of Object.keys(PILOT_STEPS)) rec.confirm(id, true, AT);
  return rec.finish(sc.duration);
}

type Step = { kind: string; body: { metrics: Record<string, number> } };
const steps = (b: Bundle) => b.ledger.filter((e) => e.kind === "step") as unknown as Step[];

test("the chain: pilot recipe → gate → plan → four screws on the engine → every Check passes → ledger → verify", () => {
  const p = plan();
  // the recipe goes through the gate before the engine sees anything: the same holes come out
  const g = gateRecipe(p.recipe!.md, undefined, AT);
  assert.equal(g.verdict, "FAST_TRACK", g.reasons.join("; "));
  assert.deepEqual(g.plan!.holes.map((h) => [h.label, h.x, h.y, h.depthMm]), p.holes.map((h) => [h.label, h.x, h.y, h.depthMm]));
  const recipe = recipeOfPlan(p)!;
  assert.equal(recipe.statements.filter((s) => drillOf(s.do)).length, 4);

  const job = work(p);
  assert.equal(job.status, "completed");
  assert.deepEqual(job.holes.map((h) => h.name), ["S1", "S2", "S3", "S4"]);
  const checks = checkJob(recipe, job);
  for (const c of checks.filter((x) => x.hole)) assert.equal(c.outcome.status, "pass", `${c.hole}: ${c.outcome.detail}`);
  assert.deepEqual(tallyChecks(checks), { pass: 7, fail: 0, manual: 0 });

  const b = jobLedger(job) as unknown as Bundle;
  assert.deepEqual(verifyBundle(b), { ok: true });
  const st = steps(b);
  assert.equal(st.length, 4);
  for (const s of st) for (const k of ["depth.error_mm", "angle.max_deg", "position.error_mm"]) assert.equal(typeof s.body.metrics[k], "number", `${k} missing`);
  for (const [i, h] of job.holes.entries()) assert.equal(st[i].body.metrics["position.error_mm"], h.offsetMm);
  const m = Object.values(b.manifests)[0];
  assert.equal((m.dimensions.app.content as { build?: string }).build, BUILD);
  assert.equal((m.dimensions.engine.content as { hash?: string }).hash, core.wasmHash);

  // one metric changed in one step: verify names that entry
  const edited = structuredClone(b);
  const at = edited.ledger.findIndex((e) => e.kind === "step") + 2;
  (edited.ledger[at].body.metrics as Record<string, number>)["position.error_mm"] = 0;
  assert.match((verifyBundle(edited) as { errors: string[] }).errors.join(" | "), new RegExp(`entry ${at}: its content does not match`));
  // another engine hash written into the manifest: verify names the dimension
  const swapped = structuredClone(b);
  (Object.values(swapped.manifests)[0].dimensions.engine.content as { hash: string }).hash = "b3:" + "0".repeat(64);
  assert.match((verifyBundle(swapped) as { errors: string[] }).errors.join(" | "), /dimension engine does not match its hash/);
});

test("the chain with one screw driven tilted: its Check fails, the job is not all pass, the ledger still verifies", () => {
  const p = plan();
  const job = work(p, { bad: 1, tiltDeg: 1.6 });
  const recipe = recipeOfPlan(p)!;
  const s2 = job.holes.find((h) => h.name === "S2");
  assert.ok(s2, `S2 was not recorded (holes: ${job.holes.map((h) => h.name).join(", ")})`);
  assert.ok(s2.maxAngleDeg > 1, `S2 max angle ${s2.maxAngleDeg}°`);
  const checks = checkJob(recipe, job);
  const bad = checks.find((c) => c.hole === "S2")!;
  assert.equal(bad.outcome.status, "fail");
  assert.match(bad.outcome.detail, /angle/);
  for (const c of checks.filter((x) => x.hole && x.hole !== "S2")) assert.equal(c.outcome.status, "pass", `${c.hole}: ${c.outcome.detail}`);
  assert.notDeepEqual(tallyChecks(checks).fail, 0);
  assert.notEqual(job.report.summary.redo, 0);
  // recorded honestly: the bad hole is a step like the others, and the bundle verifies
  const b = jobLedger(job) as unknown as Bundle;
  assert.deepEqual(verifyBundle(b), { ok: true });
  assert.equal(steps(b).length, job.holes.length);
  const i = job.holes.indexOf(s2);
  assert.equal(steps(b)[i].body.metrics["angle.max_deg"], s2.maxAngleDeg);
});
