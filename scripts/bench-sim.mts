// A simulated bench run, as a reference for the real ones: the drill held still with the bit 3 mm above A2,
// motor off, then motor on (vibration modelled as a 35 Hz shake of the tip and the axis, with motion blur),
// then the tip resting on A2. Camera images are rendered by the Rust core and go through the real tracker
// and the real engine, the same path as /hud. Written to public/benchmarks/ and labelled "simulation".
//
// Run: node --no-warnings scripts/bench-sim.mts [--at-tool]   (--at-tool: the engine filters at the tip)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { NavCore, ENGINE_DEFAULTS } from "../lib/engine.ts";
import { DEFAULT_RIG, disturb, markerCodes, renderTool, toolWorldFromHold, CALM, type Disturbance, type Hold, type Phase } from "../lib/scene.ts";
import { NavSession } from "../lib/session.ts";
import { toolLocal } from "../lib/scenedef.ts";
import { compose, fromPose, inverse, type Xf } from "../lib/xform.ts";
import { BenchRecorder, filteredPose, toolPose, type PhaseId, A2_MM } from "../lib/bench.ts";

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const core = await NavCore.load(readFileSync(new URL("../public/engine/nav_core.wasm", import.meta.url)));
const codes = markerCodes(new AR.Dictionary("ARUCO_MIP_36h12").codeList);
const rig = DEFAULT_RIG;
const FPS = 30, TICK = 1 / 120;

// the motor's shake, larger than the default drilling vibration of the E2E runs (a free-spinning motor, no
// workpiece damping it), with the motion blur of a 1/60 s exposure
const MOTOR: Disturbance = { ...CALM, vibrationMm: 0.15, vibrationDeg: 0.12, blurSamples: 3, exposureS: 1 / 60, noise: 3 };
const STILL: Disturbance = { ...CALM, noise: 3 };

const PLAN: { phase: PhaseId; seconds: number; hold: Hold; d: Disturbance; simPhase: Phase }[] = [
  { phase: "motor-off", seconds: 10, hold: { tipWorld: [A2_MM[0] / 1000, A2_MM[1] / 1000, 0.003], yawDeg: 0, pitchDeg: 0, twistDeg: 0 }, d: STILL, simPhase: "approach" },
  { phase: "motor-on", seconds: 10, hold: { tipWorld: [A2_MM[0] / 1000, A2_MM[1] / 1000, 0.003], yawDeg: 0, pitchDeg: 0, twistDeg: 0 }, d: MOTOR, simPhase: "drill" },
  { phase: "check-a2", seconds: 5, hold: { tipWorld: [A2_MM[0] / 1000, A2_MM[1] / 1000, 0], yawDeg: 0, pitchDeg: 0, twistDeg: 0 }, d: STILL, simPhase: "align" },
];

const session = new NavSession(core, new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" }), { camera: rig.camera, cameraCalibrated: true, tool: rig.tool, toolCalibrated: true, t0: 0 });
// as in the bench lab on the phone: no prediction, so "filtered" is the pose the gate decides with
const AT_TOOL = process.argv.includes("--at-tool");
session.engine.configure({ predict: false, filterAtTool: AT_TOOL });
const nav = session.scene.def.navigation;
const bench = new BenchRecorder();
let wall = 0;
let frame = 0;
for (const step of PLAN) {
  // settle for half a second before recording, as a person would
  const start = wall + 0.5;
  const end = start + step.seconds;
  let nextFrame = wall;
  let started = false;
  for (; wall <= end + 1e-9; wall += TICK) {
    if (!started && wall >= start) {
      bench.start(step.phase, wall, step.seconds);
      started = true;
    }
    if (nextFrame <= wall + 1e-9) {
      const n = Math.max(1, step.d.blurSamples);
      const blur: Xf[] = [];
      for (let i = 0; i < n; i++) {
        const ts = nextFrame + (n === 1 ? 0 : (i / (n - 1) - 0.5) * step.d.exposureS);
        blur.push(toolWorldFromHold(core, rig, disturb(step.hold, ts, step.simPhase, step.d)));
      }
      const img = renderTool(core, rig, codes, blur, step.d, 101 + frame++);
      const f = session.frame(img, nextFrame);
      session.advance(wall);
      const raw = f.pose ? toolPose(compose(inverse(fromPose(f.pose)), toolLocal(session.tool))) : null;
      const filtered = filteredPose(session.snapshot, session.id(nav.tool), session.id(nav.tracked));
      bench.add(wall, { raw, filtered, markers: f.markers, rmsPx: f.rmsPx ?? 0, latencyMs: 0 });
      nextFrame += 1 / FPS;
    }
    session.advance(wall);
  }
  process.stdout.write(`${step.phase}: ${bench.samples.filter((s) => s.phase === step.phase).length} frames\n`);
}

const d = ENGINE_DEFAULTS;
const run = bench.finish({
  id: AT_TOOL ? "sim-reference-tip" : "sim-reference",
  created: "2026-11-21T00:00:00.000Z",
  source: "simulation",
  title: AT_TOOL ? "Simulated reference, filtered at the tip: motor off vs motor on, then the tip on A2" : "Simulated reference: motor off vs motor on (modelled vibration), then the tip on A2",
  mount: "dock v0.4 (simulated geometry)",
  phone: { id: "redmi-15", name: "Redmi 15 (simulated camera)" },
  calibration: { lens: true, dock: true },
  filter: { posMinCutoff: d.posMinCutoff, posBeta: d.posBeta, rotMinCutoff: d.rotMinCutoff, rotBeta: d.rotBeta, dCutoff: d.dCutoff, predict: false, filterAtTool: AT_TOOL },
  notes: "Rendered camera images (lens model, noise, motion blur) through the real tracker and engine. Motor vibration is a model: 0.15 mm / 0.12° at 35 Hz. Not a measurement.",
});
session.dispose();

mkdirSync("public/benchmarks", { recursive: true });
writeFileSync(`public/benchmarks/${run.id}.json`, JSON.stringify(run));
for (const s of run.summary) {
  const r = s.raw, f = s.filtered;
  console.log(
    `${s.phase.padEnd(10)} tracked ${(s.tracked * 100).toFixed(0)}% · angle jitter raw ${r?.angleJitterDeg.toFixed(3)}° filtered ${f?.angleJitterDeg.toFixed(3)}° · tip raw ${r?.tipJitterMm.toFixed(3)} filtered ${f?.tipJitterMm.toFixed(3)} mm` +
      (s.a2 ? ` · tip to A2 ${s.a2.distanceMm} mm` : ""),
  );
}
console.log(`wrote public/benchmarks/${run.id}.json`);
