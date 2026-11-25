// F1 (docs/ARCHITECTURE.md): the plan file, planning with the tool as a pointer, the job recorder, the local
// memory, the agentvcs ledger, and the architecture's rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { core } from "./helpers.mts";
import { SCENARIOS } from "../lib/gallery/index.ts";
import { ScenarioRun } from "../lib/gallery/runner.ts";
import { SHEET_PLAN, addHole, newPlan, planDepths, planTargets, removeLastHole, tipOnSheet, validatePlan, type Plan } from "../lib/plan.ts";
import { buildEngine, smartToolsScene } from "../lib/scenedef.ts";
import { dockRig } from "../lib/dockrig.ts";
import { JobRecorder, defaultContext, type JobRecord } from "../lib/jobrecord.ts";
import { LocalMemory, MemBackend } from "../lib/memory.ts";
import { canonical, hash, jobLedger, jobManifest } from "../lib/ledger.ts";
import { ruleViolations } from "../lib/architecture.ts";
import type { EngineSnapshot } from "../lib/engine.ts";

const T0 = Date.UTC(2026, 10, 20, 12);

// ---------------- the plan file ----------------

test("the sheet's own plan is valid, and so is a plan made with the pointer", () => {
  assert.equal(validatePlan(SHEET_PLAN).ok, true);
  let p = newPlan("Shelf", { kind: "pointer" });
  for (const at of [{ x: -40, y: 20 }, { x: 40, y: 20 }]) {
    const r = addHole(p, at);
    assert.ok(r.ok);
    p = r.plan;
  }
  assert.deepEqual(p.holes.map((h) => h.label), ["H1", "H2"]);
  assert.equal(validatePlan(p).ok, true);
  assert.equal(removeLastHole(p).holes.length, 1);
});

test("a plan from anywhere is checked before the engine sees it, and every problem is named", () => {
  const bad = { ...SHEET_PLAN, v: 2, holes: [{ label: "A1", x: 0, y: 0, depthMm: 200, diameterMm: 6 }, { label: "A1", x: 1, y: 0, depthMm: 30, diameterMm: 0 }] };
  const r = validatePlan(bad);
  assert.equal(r.ok, false);
  const e = (r as { errors: string[] }).errors.join(" | ");
  for (const want of ["version 2", "depth must be", "repeated", "diameter must be", "closer than"]) assert.match(e, new RegExp(want));
  assert.equal(validatePlan(null).ok, false);
  assert.equal(validatePlan({ ...SHEET_PLAN, holes: [] }).ok, false);
  assert.equal(validatePlan({ ...SHEET_PLAN, holes: [{ label: "far", x: 900, y: 0, depthMm: 30, diameterMm: 6 }] }).ok, false);
});

test("marking twice at the same spot is refused (a double tap), and labels never repeat", () => {
  let p = newPlan("x");
  p = (addHole(p, { x: 0, y: 0 }) as { plan: Plan }).plan;
  const again = addHole(p, { x: 1, y: 1 });
  assert.equal(again.ok, false);
  p = (addHole(p, { x: 20, y: 0 }) as { plan: Plan }).plan;
  p = removeLastHole(p);
  p = (addHole(p, { x: 30, y: 0 }) as { plan: Plan }).plan;
  assert.deepEqual(p.holes.map((h) => h.label), ["H1", "H2"]);
});

test("a plan becomes the engine's targets: same holes, same depths", () => {
  const p = (addHole((addHole(newPlan("two"), { x: -30, y: 50 }, { depthMm: 20, diameterMm: 4 }) as { plan: Plan }).plan, { x: 30, y: -50 }, { depthMm: 45, diameterMm: 8 }) as { plan: Plan }).plan;
  const def = smartToolsScene({ tool: dockRig({}).tool, targets: planTargets(p) });
  assert.deepEqual(def.navigation.targets, ["H1", "H2"]);
  const h2 = def.nodes.find((n) => n.name === "H2")!;
  assert.deepEqual(h2.local!.p, [0.03, -0.05, 0]);
  assert.equal(h2.meta!.depthMm, 45);
  assert.deepEqual(planDepths(p), [20, 45]);
  const built = buildEngine(core.createEngine(), def);
  built.engine.setTargetDepths(planDepths(p));
  assert.ok(built.ids.H1 != null && built.ids.H2 != null, "both holes are nodes in the engine");
  built.engine.free();
  // the default scene is the sheet plan
  assert.deepEqual(smartToolsScene({ tool: dockRig({}).tool }).navigation.targets, smartToolsScene({ tool: dockRig({}).tool, targets: planTargets(SHEET_PLAN) }).navigation.targets);
});

// ---------------- the pointer ----------------

const snap = (status: string, p: [number, number, number], camera = "valid"): EngineSnapshot =>
  ({ nodes: [{ id: 7, status, age: 0, world: { p, q: [0, 0, 0, 1] } }, { id: 3, status: camera, age: 0, world: { p: [0, 0, 0.3], q: [0, 0, 0, 1] } }] }) as unknown as EngineSnapshot;

test("the tip marks a hole only when calibrated, measured and touching the surface", () => {
  assert.deepEqual(tipOnSheet(snap("static", [0.0123, -0.0456, 0.001]), 7, 3), { ok: true, x: 12.3, y: -45.6 });
  assert.equal(tipOnSheet(snap("static", [0, 0, 0.02]), 7, 3).ok, false);
  assert.match((tipOnSheet(snap("static", [0, 0, 0.02]), 7, 3) as { reason: string }).reason, /Touch the surface \(20 mm/);
  assert.equal((tipOnSheet(snap("uncalibrated", [0, 0, 0]), 7, 3) as { reason: string }).reason, "Calibrate first");
  assert.equal((tipOnSheet(snap("static", [0, 0, 0], "lost"), 7, 3) as { reason: string }).reason, "Show the markers");
  assert.equal((tipOnSheet(snap("static", [0, 0, 0], "stale"), 7, 3) as { reason: string }).reason, "Show the markers");
  assert.equal(tipOnSheet(null, 7).ok, false);
});

test("on the engine: the tip resting on a target marks that target's position", () => {
  // run the core loop scenario until the tip rests on A1 (lined up, before drilling), and mark
  const sc = SCENARIOS.find((s) => s.id === "drill-three")!;
  const r = new ScenarioRun(core, sc);
  let f = r.step(0);
  let marked: { x: number; y: number } | null = null;
  for (let t = 0; t <= 8 && !marked; t += 1 / 60) {
    f = r.step(t);
    const s = f.snap!;
    if (s.phase === "align" && s.targets[s.active]?.gapMm < 0.5) {
      const m = tipOnSheet(s, f.scene.ids.tool, f.scene.ids.camera);
      if (m.ok) marked = m;
    }
  }
  assert.ok(marked, "the tip touched the surface");
  assert.ok(Math.hypot(marked!.x - 0, marked!.y - 60) < 1, `marked at ${marked!.x}, ${marked!.y} (A1 is 0, 60)`);
  r.dispose();
});

// ---------------- the job recorder ----------------

function recordDrillThree(): JobRecord {
  const sc = SCENARIOS.find((s) => s.id === "drill-three")!;
  const r = new ScenarioRun(core, sc);
  let f = r.step(0);
  const rec = new JobRecorder(SHEET_PLAN, defaultContext({ source: "simulation" }), (id) => f.scene.names[id], { wall: (t) => T0 + t * 1000, t0: 0 });
  let tick = -1;
  for (let t = 0; t <= sc.duration; t += 1 / 60) {
    f = r.step(t);
    if (f.snap && f.snap.tick !== tick) {
      tick = f.snap.tick;
      rec.feed(f.snap);
    }
  }
  r.dispose();
  return rec.finish(sc.duration);
}

test("a job on the engine: every hole recorded with the depth and angle it measured, and graded", () => {
  const job = recordDrillThree();
  assert.equal(job.status, "completed");
  assert.deepEqual(job.holes.map((h) => h.name), ["A1", "A2", "A3"]);
  for (const h of job.holes) {
    assert.ok(Math.abs(h.seatedMm - 35) < 0.5, `${h.name} seated ${h.seatedMm} mm`);
    assert.ok(h.maxAngleDeg < 0.5, `${h.name} ${h.maxAngleDeg}°`);
    assert.ok(h.score != null && h.score > 50);
    assert.ok(Date.parse(h.endedAt) > Date.parse(h.startedAt));
  }
  assert.equal(job.report.summary.redo, 0);
  assert.match(job.report.verdict, /all 3 within spec/);
});

test("a job on the engine: every hole keeps how far the tip was from its mark when drilling started", () => {
  const job = recordDrillThree();
  for (const h of job.holes) {
    assert.equal(typeof h.offsetMm, "number", `${h.name} has no position error`);
    assert.ok(h.offsetMm! >= 0 && h.offsetMm! < 0.75, `${h.name} ${h.offsetMm} mm`);
    assert.equal(h.offsetMm, Math.round(h.offsetMm! * 100) / 100, "rounded to 0.01 mm");
  }
  const steps = jobLedger(job).ledger.filter((e) => e.kind === "step") as { body: { metrics: Record<string, number> } }[];
  assert.deepEqual(steps.map((e) => e.body.metrics["position.error_mm"]), job.holes.map((h) => h.offsetMm));
});

test("the recorder: the position error is scoreScrew's start offset, else the first drill sample, else left out", () => {
  const plan: Plan = { ...SHEET_PLAN, holes: SHEET_PLAN.holes.slice(0, 2) };
  const [a, b] = plan.holes;
  const ids: Record<number, string> = { 1: a.label, 2: b.label };
  const rec = new JobRecorder(plan, defaultContext(), (id) => ids[id], { wall: (t) => T0 + t * 1000, t0: 0 });
  const snapOf = (t: number, id: number, phase: string, offsetMm: number, depthMm: number, events: { kind: string; node: number; value: number }[] = []) =>
    ({ t, phase, active: 0, alarms: 0, targets: [{ id, angleErrDeg: 0.1, offsetMm, depthMm }], events }) as unknown as EngineSnapshot;
  // A: aligned at 0.6 mm, the bit enters at 0.42 mm; scoreScrew starts counting past 0.5 mm deep: its 0.3 mm is kept
  rec.feed(snapOf(0, 1, "align", 0.6, 0));
  rec.feed(snapOf(0.1, 1, "drill", 0.423, 0.2));
  rec.feed(snapOf(0.2, 1, "drill", 0.3, 1));
  rec.feed(snapOf(0.3, 1, "hold", 0.3, a.depthMm, [{ kind: "drilled", node: 1, value: 0 }]));
  // B: drilled with no drill sample at all (the engine said so between two snapshots)
  rec.feed(snapOf(0.4, 2, "align", 0.2, 0, [{ kind: "drilled", node: 2, value: 0 }]));
  const [ha, hb] = rec.holes;
  assert.equal(ha.offsetMm, 0.3, "scoreScrew's start offset (first sample past 0.5 mm deep)");
  assert.equal("offsetMm" in hb, false);
  // without a sample past 0.5 mm, scoreScrew has nothing: the first drill sample, rounded
  const rec2 = new JobRecorder(plan, defaultContext(), (id) => ids[id], { wall: (t) => T0 + t * 1000, t0: 0 });
  rec2.feed(snapOf(0, 1, "drill", 0.423, 0.2));
  rec2.feed(snapOf(0.1, 1, "drill", 0.5, 0.4, [{ kind: "drilled", node: 1, value: 0 }]));
  assert.equal(rec2.holes[0].offsetMm, 0.42);
});

test("a job stopped early is recorded as aborted, with the holes it has", () => {
  const sc = SCENARIOS.find((s) => s.id === "drill-three")!;
  const r = new ScenarioRun(core, sc);
  let f = r.step(0);
  const rec = new JobRecorder(SHEET_PLAN, defaultContext(), (id) => f.scene.names[id], { wall: (t) => T0 + t * 1000, t0: 0 });
  for (let t = 0; t <= 12; t += 1 / 60) {
    f = r.step(t);
    if (f.snap) rec.feed({ ...f.snap, events: t === 0 ? f.snap.events : f.snap.events });
  }
  r.dispose();
  const job = rec.finish(12);
  assert.equal(job.status, "aborted");
  assert.deepEqual(job.holes.map((h) => h.name), ["A1"]);
  assert.match(job.report.verdict, /1 of 3 done/);
});

test("a lost job resumes from its draft: same id and start, the next holes added, none recorded twice", () => {
  const sc = SCENARIOS.find((s) => s.id === "drill-three")!;
  // the first page: A1 drilled, then the page dies; the draft is what onJobProgress wrote
  let r = new ScenarioRun(core, sc);
  let f = r.step(0);
  const first = new JobRecorder(SHEET_PLAN, defaultContext(), (id) => f.scene.names[id], { wall: (t) => T0 + t * 1000, t0: 0 });
  let tick = -1;
  for (let t = 0; t <= 12; t += 1 / 60) {
    f = r.step(t);
    if (f.snap && f.snap.tick !== tick) (tick = f.snap.tick), first.feed(f.snap);
  }
  r.dispose();
  const draft: JobRecord = JSON.parse(JSON.stringify(first.finish(12)));
  assert.deepEqual(draft.holes.map((h) => h.name), ["A1"]);
  // the next page: a later start, the engine guides through every hole again (it does not know A1 is done)
  r = new ScenarioRun(core, sc);
  f = r.step(0);
  const T1 = T0 + 3600_000;
  const rec = new JobRecorder(SHEET_PLAN, defaultContext(), (id) => f.scene.names[id], { wall: (t) => T1 + t * 1000, t0: 0, resume: draft });
  assert.equal(rec.holes.length, 1);
  tick = -1;
  for (let t = 0; t <= sc.duration; t += 1 / 60) {
    f = r.step(t);
    if (f.snap && f.snap.tick !== tick) (tick = f.snap.tick), rec.feed(f.snap);
  }
  r.dispose();
  const job = rec.finish(sc.duration);
  assert.equal(job.id, draft.id);
  assert.equal(job.started, draft.started);
  assert.equal(job.status, "completed");
  assert.deepEqual(job.holes.map((h) => h.name), ["A1", "A2", "A3"]);
  assert.deepEqual(job.holes[0], draft.holes[0], "the recovered A1 is kept as it was, not recorded again");
  assert.ok(Date.parse(job.holes[1].endedAt) >= T1);
});

// ---------------- local memory ----------------

test("local memory keeps plans and jobs, refuses invalid plans, and lists what is not synced", async () => {
  const m = new LocalMemory(new MemBackend());
  const p = (addHole(newPlan("Shelf"), { x: 10, y: 10 }) as { plan: Plan }).plan;
  assert.equal((await m.savePlan(p)).ok, true);
  const bad = await m.savePlan({ ...p, id: "bad", holes: [] });
  assert.equal(bad.ok, false);
  assert.deepEqual((await m.plans()).map((r) => r.id), [p.id]);
  assert.deepEqual(await m.plan(p.id), p);
  const job = recordDrillThree();
  await m.saveJob(job);
  assert.deepEqual(await m.outbox(), { plans: [p.id], jobs: [job.id] });
  await m.markSynced("plans", p.id);
  assert.deepEqual(await m.outbox(), { plans: [], jobs: [job.id] });
  await m.deleteJob(job.id);
  assert.equal((await m.jobs()).length, 0);
});

// ---------------- the agentvcs ledger ----------------

test("canonical JSON and BLAKE3 match the agentvcs conformance cases", () => {
  const dir = new URL("./fixtures/agentvcs-hash/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 13);
  let checked = 0;
  for (const f of files) {
    const c = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    // integers past 2^53 need the raw literal; this writer never produces them (left to the agentvcs CLI)
    if (c.id === "hash-015-int-beyond-safe-range") continue;
    const want = c.expect.json;
    let got: { ok: boolean; canonical?: string; hash?: string };
    try {
      const v = JSON.parse(c.input);
      got = { ok: true, canonical: canonical(v), hash: hash(v) };
    } catch {
      got = { ok: false };
    }
    assert.equal(got.ok, want.ok, c.id);
    if (want.canonical) assert.equal(got.canonical, want.canonical, c.id);
    if (want.hash) assert.equal(got.hash, want.hash, c.id);
    checked++;
  }
  assert.ok(checked >= 13);
});

test("a job becomes a hash-chained ledger: manifest, run_start, one step per hole, run_end", () => {
  const job = recordDrillThree();
  const b = jobLedger(job);
  const m = jobManifest(job);
  assert.equal(b.type, "audit_bundle");
  assert.deepEqual(Object.keys(b.manifests), [m.manifest_id]);
  assert.deepEqual(b.ledger.map((e) => e.kind), ["run_start", "step", "step", "step", "run_end"]);
  b.ledger.forEach((e, i) => {
    const { entry_hash, ...rest } = e;
    assert.equal(entry_hash, hash(rest), `entry ${i} hash`);
    assert.equal(e.prev_hash, i ? b.ledger[i - 1].entry_hash : null);
  });
  const step = b.ledger[1].body as { metrics: Record<string, number> };
  assert.ok(Math.abs(step.metrics["depth.error_mm"]) < 0.5);
  // the same job always gives the same ledger; another phone gives another manifest
  assert.equal(canonical(jobLedger(job)), canonical(b));
  assert.notEqual(jobManifest({ ...job, context: { ...job.context, phone: { id: "other", name: "Other", provisional: true } } }).manifest_id, m.manifest_id);
});

test("agentvcs verify accepts the ledger (when the agentvcs CLI is installed)", (t) => {
  const bin = process.env.AGENTVCS_BIN;
  if (!bin || !existsSync(bin)) return t.skip("set AGENTVCS_BIN to the agentvcs CLI to run this check");
  const dir = mkdtempSync(join(tmpdir(), "st-ledger-"));
  const file = join(dir, "bundle.json");
  writeFileSync(file, JSON.stringify(jobLedger(recordDrillThree())));
  const out = JSON.parse(execFileSync(bin, ["verify", file], { encoding: "utf8" }));
  assert.equal(out.valid, true, JSON.stringify(out.violations));
  assert.equal(out.entries, 5);
});

// ---------------- the architecture ----------------

test("the architecture keeps its rule: nothing from the cloud ends in the real-time loop", () => {
  assert.deepEqual(ruleViolations(), []);
});
