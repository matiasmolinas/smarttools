import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mts";
import { SCENARIOS } from "../lib/gallery/index.ts";
import { ScenarioRun } from "../lib/gallery/runner.ts";

const run = (id: string, until: number, dt = 1 / 60) => {
  const sc = SCENARIOS.find((s) => s.id === id)!;
  const r = new ScenarioRun(core, sc);
  let f = r.step(0);
  for (let t = dt; t <= until; t += dt) f = r.step(t);
  return { r, f, sc };
};

test("every scenario runs end to end on the engine and produces a panel", () => {
  for (const sc of SCENARIOS) {
    const r = new ScenarioRun(core, sc);
    for (let t = 0; t <= sc.duration; t += 1 / 30) {
      const f = r.step(t);
      assert.ok(f.scene.def.nodes.length > 0);
    }
    const p = r.panel(sc.duration);
    assert.ok(p.caption.length > 10, sc.id);
    assert.ok(r.events.length > 0, `${sc.id} produced engine events`);
    r.dispose();
  }
});

test("drill-three: the engine reaches depth on all three marks", () => {
  const { r } = run("drill-three", 30.5);
  const names = new Set(r.events.filter((e) => e.kind === "depth-reached").map((e) => e.node));
  assert.equal(names.size, 3);
  r.dispose();
});

test("calibrate: the gate stays closed until the dock is calibrated", () => {
  const { r, f } = run("calibrate", 9.9);
  assert.equal(f.snap!.gate & 1, 1, "not calibrated yet");
  let ready = false;
  for (let t = 10; t <= 13; t += 1 / 60) ready ||= r.step(t).snap!.ready;
  assert.ok(ready, "ready after calibrating");
  r.dispose();
});

test("safety: covered markers, shaking and a tilted bit are all caught", () => {
  const sc = SCENARIOS.find((s) => s.id === "safety")!;
  const r = new ScenarioRun(core, sc);
  const readyAt: number[] = [];
  for (let t = 0; t <= sc.duration; t += 1 / 60) if (r.step(t).snap?.ready) readyAt.push(t);
  assert.ok(readyAt.some((t) => t < 4), "ready while steady on the mark");
  assert.ok(!readyAt.some((t) => t > 5.2), "never ready while covered, shaking or drilling tilted");
  assert.ok(r.events.some((e) => e.kind === "angle-alarm"));
  r.dispose();
});

test("athos: the recipe steps advance with the engine's measurements", () => {
  const { r } = run("athos", 13);
  const steps = r.panel(13).steps!;
  assert.equal(steps.at(-1)!.state, "active", "the last step (stop and log) after depth is reached");
  assert.ok(steps.slice(0, 3).every((s) => s.state === "done"));
  r.dispose();
});

test("agentvcs: one record per hole, from live engine events", () => {
  const { r, sc } = run("agentvcs", 30.5);
  assert.equal(r.panel(sc.duration).records!.rows.length, 3);
  r.dispose();
});

test("angled: ready on B1, the hole planned 15° off the normal", () => {
  const { r } = run("angled", 6);
  assert.ok(r.events.some((e) => e.kind === "ready"));
  r.dispose();
});

const runAll = (id: string) => {
  const sc = SCENARIOS.find((s) => s.id === id)!;
  const r = new ScenarioRun(core, sc);
  for (let t = 0; t <= sc.duration; t += 1 / 60) r.step(t);
  return { r, st: r.store as any, sc };
};

test("assembly hero: located by touch, verified, 10 screws seated on three faces, bracket located", () => {
  const { r, st } = runAll("assembly-hero");
  assert.ok(st.reg?.applied && st.reg.freMm < 0.5, `FRE ${st.reg?.freMm}`);
  assert.ok(st.verify.K1 < 1, `K1 ${st.verify.K1} mm`);
  assert.ok(st.bracketReg?.applied && st.bracketReg.freMm < 0.5, "bracket located");
  assert.equal(Object.keys(st.seated).length, 10, `seated: ${Object.keys(st.seated).join(",")}`);
  for (const [n, v] of Object.entries(st.seated) as [string, { angle: number }][]) assert.ok(v.angle < 0.5, `${n} angle ${v.angle}`);
  r.dispose();
});

test("assembly register: the CAD snaps onto the part, checkpoints within 1 mm", () => {
  const { r, st } = runAll("assembly-register");
  assert.ok(st.reg.applied);
  assert.ok(st.verify.K1 < 1 && st.verify.K2 < 1, JSON.stringify(st.verify));
  r.dispose();
});

test("assembly faces: six screws seated (top and 35° chamfer)", () => {
  const { r, st } = runAll("assembly-faces");
  assert.deepEqual(Object.keys(st.seated).sort(), ["C1", "C2", "S1", "S2", "S3", "S4"]);
  r.dispose();
});

test("assembly verify: a bracket 2 mm off is caught, then located and screwed", () => {
  const { r, st } = runAll("assembly-verify");
  assert.ok(st.bracketCheck > 1.5, `caught: ${st.bracketCheck} mm`);
  assert.ok(st.bracketReg.applied);
  assert.ok(st.seated.B1 && st.seated.B2, "two bracket screws seated");
  r.dispose();
});
