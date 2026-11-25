// The bench lab (lib/bench.ts): its statistics on known signals, the recorder's phases, the published
// simulated reference, and the demo plan used in the field test (docs/FIELD-TEST.md).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { A2_MM, BenchRecorder, checkBenchRun, indexWith, isBenchRun, poseStats, summarize, type BenchIndex, type BenchIndexEntry, type BenchRun, type ToolPose } from "../lib/bench.ts";
import { DEMO_PLAN, LIMITS, validatePlan } from "../lib/plan.ts";
import { BOARD_MARKERS, MARKER_SIZE } from "../lib/board.ts";

const deg = Math.PI / 180;
/** a bit pointing into the sheet, tilted by (ax, ay) degrees, tip at (x, y, z) mm */
const pose = (ax: number, ay: number, tip: [number, number, number]): ToolPose => {
  const a = [Math.sin(ax * deg), Math.sin(ay * deg), -1];
  const l = Math.hypot(a[0], a[1], a[2]);
  return { tip, axis: [a[0] / l, a[1] / l, a[2] / l] };
};

test("stats: a still bit has no jitter; a shaking one has the RMS of its shake, and a slow drift is separated", () => {
  const ts = Array.from({ length: 300 }, (_, i) => i / 30);
  const still = poseStats(ts, ts.map(() => pose(0, 0, [0, 0, 3])))!;
  assert.ok(still.angleJitterDeg < 1e-6 && still.tipJitterMm < 1e-6);
  assert.ok(still.tiltDeg < 1e-6);
  // ±0.2° square-ish shake at 15 Hz (half the frame rate keeps it from aliasing to zero): RMS ≈ 0.2°
  const shake = poseStats(ts, ts.map((t, i) => pose(i % 2 ? 0.2 : -0.2, 0, [0, 0, 3])))!;
  assert.ok(Math.abs(shake.angleJitterDeg - 0.2) < 0.01, `${shake.angleJitterDeg}`);
  assert.ok(Math.abs(shake.angleJitterHpDeg - 0.2) < 0.02, "the fast shake survives the high-pass");
  // a slow 1°/10 s drift: large overall, small above 2 Hz
  const drift = poseStats(ts, ts.map((t) => pose(t / 10, 0, [0, 0, 3])))!;
  assert.ok(drift.angleJitterDeg > 0.2);
  assert.ok(drift.angleJitterHpDeg < 0.01, `${drift.angleJitterHpDeg}`);
  // a tilted bit
  assert.ok(Math.abs(poseStats(ts, ts.map(() => pose(2, 0, [0, 0, 0])))!.tiltDeg - 2) < 0.01);
});

test("recorder: timed phases, a phase recorded again replaces the earlier take, and the A2 check", () => {
  const b = new BenchRecorder();
  const at = (t: number, p: ToolPose | null) => b.add(t, { raw: p, filtered: p, markers: 8, rmsPx: 0.4, latencyMs: 40 });
  b.start("motor-off", 0, 1);
  for (let t = 0; t <= 1.5; t += 1 / 30) at(t, pose(0, 0, [0, -20, 3]));
  assert.equal(b.current, null, "the phase ended by itself");
  assert.ok(b.samples.length >= 29 && b.samples.length <= 31);
  b.start("motor-off", 2, 0.5);
  for (let t = 2; t <= 2.6; t += 1 / 30) at(t, pose(0, 0, [0, -20, 3]));
  assert.ok(b.samples.length <= 16, "the second take replaced the first");
  b.start("check-a2", 3, 1);
  for (let t = 3; t <= 4.1; t += 1 / 30) at(t, pose(0, 0, [A2_MM[0] + 0.3, A2_MM[1] + 0.4, 0]));
  const s = summarize("check-a2", b.samples, b.accel);
  assert.equal(s.a2!.planarMm, 0.5);
  assert.equal(s.tracked, 1);
  // frames without a marker pose count as untracked
  b.start("motor-on", 5, 1);
  for (let t = 5; t <= 6.1; t += 1 / 30) at(t, Math.round(t * 30) % 4 === 0 ? null : pose(0, 0, [0, -20, 3]));
  const on = summarize("motor-on", b.samples, b.accel);
  assert.ok(on.tracked > 0.7 && on.tracked < 0.8, `${on.tracked}`);
  const run = b.finish({ source: "camera", title: "t", mount: "provisional mount", phone: { id: "x", name: "X" }, calibration: { lens: true, dock: true }, filter: {}, notes: "" });
  assert.ok(isBenchRun(run));
  assert.deepEqual(run.summary.map((p) => p.phase), ["motor-off", "motor-on", "check-a2"]);
});

test("the published simulated reference: labelled as simulation, the filter halves the motor's angular jitter, the tip lands on A2", () => {
  const run = JSON.parse(readFileSync(new URL("../public/benchmarks/sim-reference.json", import.meta.url), "utf8")) as BenchRun;
  assert.ok(isBenchRun(run));
  assert.equal(run.source, "simulation");
  const ph = Object.fromEntries(run.summary.map((s) => [s.phase, s]));
  assert.equal(ph["motor-on"].tracked, 1);
  assert.ok(ph["motor-on"].raw!.angleJitterDeg > 3 * ph["motor-off"].raw!.angleJitterDeg, "the motor shakes the raw poses");
  assert.ok(ph["motor-on"].filtered!.angleJitterDeg < 0.6 * ph["motor-on"].raw!.angleJitterDeg, "the filter cuts the angular jitter");
  assert.ok(ph["check-a2"].a2!.distanceMm < 0.5, `tip to A2 ${ph["check-a2"].a2!.distanceMm} mm`);
  const idx = JSON.parse(readFileSync(new URL("../public/benchmarks/index.json", import.meta.url), "utf8"));
  assert.ok(idx.runs.some((r: { id: string; source: string }) => r.id === run.id && r.source === "simulation"));
});

test("simulated reference filtered at the tip: the motor's shake reaches the tip less than raw, and less than filtering at the camera", () => {
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../public/benchmarks/${f}`, import.meta.url), "utf8")) as BenchRun;
  const on = (r: BenchRun) => r.summary.find((s) => s.phase === "motor-on")!;
  const cam = on(load("sim-reference.json")), tip = on(load("sim-reference-tip.json"));
  assert.ok(tip.filtered!.tipJitterMm < tip.raw!.tipJitterMm, `tip filtered ${tip.filtered!.tipJitterMm} vs raw ${tip.raw!.tipJitterMm}`);
  assert.ok(tip.filtered!.tipJitterMm < cam.filtered!.tipJitterMm, `at the tip ${tip.filtered!.tipJitterMm} vs at the camera ${cam.filtered!.tipJitterMm}`);
  assert.ok(tip.filtered!.angleJitterDeg < 0.6 * tip.raw!.angleJitterDeg);
});

test("the demo plan: four valid holes on a 40 mm square, clear of every marker and of A2", () => {
  assert.equal(validatePlan(DEMO_PLAN).ok, true);
  assert.equal(DEMO_PLAN.holes.length, 4);
  for (const h of DEMO_PLAN.holes) {
    for (const m of BOARD_MARKERS) {
      const half = (MARKER_SIZE * 1000) / 2 + h.diameterMm / 2 + 2;
      const clear = Math.abs(h.x - m.x * 1000) > half || Math.abs(h.y - m.y * 1000) > half;
      assert.ok(clear, `${h.label} hits marker ${m.id}`);
    }
    assert.ok(h.depthMm <= LIMITS.depthMm[1]);
    assert.ok(Math.hypot(h.x - A2_MM[0], h.y - A2_MM[1]) > 20, `${h.label} is too close to A2`);
  }
});

// ---------------- published runs ----------------

const BENCH_DIR = new URL("../public/benchmarks/", import.meta.url);

test("every published run is listed, exists, passes checkBenchRun, and its id and source match the index", () => {
  const index = JSON.parse(readFileSync(new URL("index.json", BENCH_DIR), "utf8")) as BenchIndex;
  assert.ok(index.runs.length >= 1);
  for (const e of index.runs) {
    const run = JSON.parse(readFileSync(new URL(e.file, BENCH_DIR), "utf8"));
    assert.deepEqual(checkBenchRun(run), [], e.file);
    assert.equal(run.id, e.id, `${e.file}: id`);
    assert.equal(run.source, e.source, `${e.file}: source`);
  }
  const files = readdirSync(BENCH_DIR).filter((f) => f.endsWith(".json") && f !== "index.json");
  assert.deepEqual(files.filter((f) => !index.runs.some((e) => e.file === f)), [], "files missing from the index");
  // the order indexWith keeps: camera runs before simulations
  const kinds = index.runs.map((e) => e.source);
  assert.deepEqual(kinds, [...kinds].sort((a, b) => Number(a !== "camera") - Number(b !== "camera")));
});

test("checkBenchRun names every problem of a broken run", () => {
  const good = JSON.parse(readFileSync(new URL("sim-reference.json", BENCH_DIR), "utf8")) as BenchRun;
  assert.deepEqual(checkBenchRun(good), []);
  assert.match(checkBenchRun(null)[0], /not a bench run/);
  assert.match(checkBenchRun({ kind: "smarttools-job" })[0], /not a bench run/);
  const e = (x: unknown) => checkBenchRun(x).join(" | ");
  assert.match(e({ ...good, samples: [] }), /no samples/);
  assert.match(e({ ...good, source: "phone" }), /source must be "camera" or "simulation"/);
  assert.match(e({ ...good, summary: [...good.summary, { ...good.summary[0], phase: "warm-up" }] }), /phase "warm-up" does not exist/);
  assert.match(e({ ...good, summary: [{ ...good.summary[0], phase: "toString" }] }), /phase "toString" does not exist/);
  assert.match(e({ ...good, source: "camera", summary: good.summary.filter((s) => s.phase === "check-a2") }), /needs a motor-off or a motor-on phase/);
  assert.equal(e({ ...good, source: "simulation", summary: good.summary.filter((s) => s.phase === "check-a2") }), "", "a simulation may have any phases");
  const nan = structuredClone(good);
  nan.summary[1].raw!.angleJitterDeg = NaN;
  nan.summary[0].latencyMs = Infinity;
  const msg = e(nan);
  assert.match(msg, /motor-on\.raw\.angleJitterDeg is not a finite number/);
  assert.match(msg, /motor-off\.latencyMs is not a finite number/);
  assert.match(e({ ...good, created: "yesterday" }), /created is not a date/);
});

test("indexWith: camera runs first, newest first, then simulations; the same id is replaced", () => {
  const ent = (id: string, source: "camera" | "simulation", created?: string): BenchIndexEntry => ({ id, file: `${id}.json`, source, title: id, ...(created ? { created } : {}) });
  let idx: BenchIndex = { runs: [ent("sim-reference", "simulation"), ent("sim-reference-tip", "simulation")] };
  idx = indexWith(idx, ent("phone-a", "camera", "2026-12-01T10:00:00.000Z"));
  assert.deepEqual(idx.runs.map((r) => r.id), ["phone-a", "sim-reference", "sim-reference-tip"]);
  idx = indexWith(idx, ent("phone-b", "camera", "2026-12-02T10:00:00.000Z"));
  idx = indexWith(idx, ent("phone-old", "camera", "2026-11-30T10:00:00.000Z"));
  idx = indexWith(idx, ent("sim-new", "simulation", "2026-12-03T10:00:00.000Z"));
  assert.deepEqual(idx.runs.map((r) => r.id), ["phone-b", "phone-a", "phone-old", "sim-new", "sim-reference", "sim-reference-tip"]);
  // replaced, not doubled: the new date moves it
  idx = indexWith(idx, { ...ent("phone-old", "camera", "2026-12-04T10:00:00.000Z"), title: "again" });
  assert.equal(idx.runs.filter((r) => r.id === "phone-old").length, 1);
  assert.deepEqual(idx.runs.slice(0, 3).map((r) => r.id), ["phone-old", "phone-b", "phone-a"]);
  assert.equal(idx.runs[0].title, "again");
  // the index given is not changed
  const before = structuredClone(idx);
  indexWith(idx, ent("x", "camera", "2026-12-05T10:00:00.000Z"));
  assert.deepEqual(idx, before);
});
