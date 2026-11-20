// End-to-end scene test: simulated camera frames (Rust renderer: lens distortion, the bit in view,
// hand tremor, motor vibration, motion blur, lighting, noise, occluders) go through the real
// navigation pipeline (lib/navpipeline.ts: js-aruco2 + the Rust core), and every result is compared
// with the ground truth that produced the frame.
//
// Run: node --no-warnings scripts/scene-test.mts [--fps 15] [--quick]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NavCore, cameraFromHfov, type Camera, type ToolCalib } from "../lib/engine.ts";
import { CALM, DEFAULT_DISTURBANCE, DEFAULT_RIG, RUN_TIME, markerCodes, renderHold, runFrame, tiltedRig, truthNav, type Disturbance, type Hold } from "../lib/scene.ts";
import { NavPipeline, REQUIREMENT } from "../lib/navpipeline.ts";
import { BOARD_MARKERS, BOARD_TARGETS } from "../lib/board.ts";
import type { V3 } from "../lib/pose.ts";

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const FPS = Number(args[args.indexOf("--fps") + 1]) || (QUICK ? 8 : 15);

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const core = await NavCore.load(readFileSync(new URL("../public/engine/nav_core.wasm", import.meta.url)));
const codes = markerCodes(new AR.Dictionary("ARUCO_MIP_36h12").codeList);
const detector = () => new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" });
const TILT = args.includes("--tilt") ? Number(args[args.indexOf("--tilt") + 1]) : 0;
const rig = TILT ? tiltedRig(TILT) : DEFAULT_RIG;
if (TILT) console.log(`dock camera tilted ${TILT}° down`);
const W = rig.width, H = rig.height;

// what the app assumes before any calibration
const GUESS_CAMERA: Camera = cameraFromHfov(W, H, 66);
const GUESS_TOOL: ToolCalib = { tipCam: [0, 0.055, 0.17], axisCam: [0, 0, 1] };

const rows: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  rows.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const angleBetween = (a: V3, b: V3) => (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const f2 = (x: number) => x.toFixed(2);
const t0 = performance.now();

function feed(p: NavPipeline, hold: Hold, t: number, d: Disturbance, phase: "approach" | "align" = "approach", seed = 7) {
  const img = renderHold(core, rig, codes, t, phase, hold, d, seed + Math.round(t * 1000));
  return p.process(img, t);
}

// ------------------------------------------------------------------------------------------------
console.log(`\n1. Camera calibration (true f ${rig.camera.f}, c (${rig.camera.cx}, ${rig.camera.cy}), k1 ${rig.camera.k1}; guess f ${GUESS_CAMERA.f.toFixed(0)})`);
const pCal = new NavPipeline(core, detector(), { camera: GUESS_CAMERA, cameraCalibrated: true, tool: GUESS_TOOL, toolCalibrated: false });
pCal.beginCapture("camera");
for (let i = 0; i < (QUICK ? 30 : 48); i++) {
  // drill held 8-20 cm from the sheet, swept around so the markers fill different parts of the image
  const a = i * 0.71;
  const hold: Hold = {
    tipWorld: [0.05 * Math.sin(a * 1.3), -0.03 + 0.07 * Math.cos(a * 0.9), 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(a * 0.37))],
    yawDeg: 26 * Math.sin(a),
    pitchDeg: -18 + 26 * Math.cos(a * 1.1),
    twistDeg: 25 * Math.sin(a * 0.6),
  };
  feed(pCal, hold, i / FPS, CALM);
}
const cal = pCal.endCapture();
let camera: Camera = GUESS_CAMERA;
if ("camera" in cal) {
  camera = cal.camera;
  const c = cal.camera;
  check("focal length", Math.abs(c.f - rig.camera.f) / rig.camera.f < 0.01, `f ${f2(c.f)} vs ${rig.camera.f} (${f2((100 * (c.f - rig.camera.f)) / rig.camera.f)} %), ${cal.views} views, rms ${f2(cal.rms)} px`);
  check("principal point", Math.hypot(c.cx - rig.camera.cx, c.cy - rig.camera.cy) < 6, `(${f2(c.cx)}, ${f2(c.cy)}) vs (${rig.camera.cx}, ${rig.camera.cy})`);
  check("lens distortion k1", Math.abs(c.k1 - rig.camera.k1) < 0.03, `k1 ${c.k1.toFixed(4)} vs ${rig.camera.k1}, k2 ${c.k2.toFixed(4)} vs ${rig.camera.k2}`);
} else check("camera calibration", false, cal.error);

// ------------------------------------------------------------------------------------------------
console.log(`\n2. Dock calibration on A2 (true dock: tip (${rig.tool.tipCam.map((v) => (v * 1000).toFixed(0)).join(", ")}) mm, axis ${angleBetween(rig.tool.axisCam, [0, 0, 1]).toFixed(1)}° off the optical axis)`);
const pTool = new NavPipeline(core, detector(), { camera, cameraCalibrated: true, tool: GUESS_TOOL, toolCalibrated: false });
const wobbleD: Disturbance = { ...CALM, tremorDeg: 0.04, noise: 2 };
pTool.beginCapture("pivot");
const NW = QUICK ? 36 : 60;
for (let i = 0; i < NW; i++) {
  const a = (i / NW) * 2 * Math.PI * 1.5;
  const r = 4 + 8 * (i / NW);
  feed(pTool, { tipWorld: [0, -0.02, 0], yawDeg: r * Math.cos(a), pitchDeg: r * Math.sin(a), twistDeg: 3 * Math.sin(a * 0.5) }, i / FPS, wobbleD, "align");
}
const pv = pTool.endCapture();
if ("tipCam" in pv) check("tip position (pivot)", dist(pv.tipCam, rig.tool.tipCam) * 1000 < 0.7, `error ${f2(dist(pv.tipCam, rig.tool.tipCam) * 1000)} mm over ${pv.frames} frames, wobble ${f2(pv.spreadDeg)}°, pivot rms ${f2(pv.rmsMm)} mm`);
else check("tip position (pivot)", false, pv.error);
pTool.beginCapture("roll");
for (let i = 0; i < NW; i++) {
  const tw = -28 + (56 * i) / (NW - 1);
  feed(pTool, { tipWorld: [0, -0.02, 0], yawDeg: 0.4, pitchDeg: -0.3, twistDeg: tw }, 10 + i / FPS, wobbleD, "align");
}
const ax = pTool.endCapture();
let tool: ToolCalib = GUESS_TOOL;
if ("axisCam" in ax) {
  tool = pTool.opts.tool;
  check("bit axis (twist)", angleBetween(ax.axisCam, rig.tool.axisCam) < 0.15, `error ${angleBetween(ax.axisCam, rig.tool.axisCam).toFixed(3)}° over ${ax.frames} frames, twist ${f2(ax.spreadDeg)}°`);
} else check("bit axis (twist)", false, ax.error);
const toolOk = pTool.opts.toolCalibrated;

// ------------------------------------------------------------------------------------------------
console.log(`\n3. Drilling A1, A2, A3 with tremor, motor vibration, motion blur and noise (${FPS} fps, ${RUN_TIME.toFixed(1)} s)`);
const calibrated = new NavPipeline(core, detector(), { camera, cameraCalibrated: true, tool, toolCalibrated: toolOk });
const naive = new NavPipeline(core, detector(), { camera: GUESS_CAMERA, cameraCalibrated: false, tool: GUESS_TOOL, toolCalibrated: true });
type Err = { tip: number[]; axis: number[]; aim: number[]; depth: number[]; rawTip: number[]; rawAxis: number[]; rawAim: number[]; rawDepth: number[]; byPhase: Record<string, number[]>; lost: number; frames: number; falseReady: number; readyByHole: number[]; markers: number[] };
const newErr = (): Err => ({ tip: [], axis: [], aim: [], depth: [], rawTip: [], rawAxis: [], rawAim: [], rawDepth: [], byPhase: {}, lost: 0, frames: 0, falseReady: 0, readyByHole: [0, 0, 0], markers: [] });
const E = { calibrated: newErr(), naive: newErr() };
const completed = new Set<number>();
let worstFalse = "";
for (let i = 0; i * (1 / FPS) < RUN_TIME; i++) {
  const t = i / FPS;
  const fr = runFrame(core, rig, codes, t, DEFAULT_DISTURBANCE, 11);
  const tr = fr.truth.nav;
  for (const [name, p] of [["calibrated", calibrated], ["naive", naive]] as const) {
    const r = p.process(fr.image, t);
    const e = E[name];
    e.frames++;
    e.markers.push(r.markers);
    if (!r.nav || !r.raw) {
      e.lost++;
      continue;
    }
    // errors against the truth (the pipeline's target may differ: compare geometry, not offsets)
    e.tip.push(dist(r.nav.tip, tr.tip) * 1000);
    e.rawTip.push(dist(r.raw.tip, tr.tip) * 1000);
    e.rawAxis.push(angleBetween(r.raw.axis, tr.axis));
    (e.byPhase[fr.truth.phase] ??= []).push(angleBetween(r.raw.axis, tr.axis));
    if (fr.truth.phase === "align" || fr.truth.phase === "approach") e.rawAim.push(Math.hypot(r.raw.aim.x - tr.aim.x, r.raw.aim.y - tr.aim.y) * 1000);
    if (fr.truth.phase === "drill" || fr.truth.phase === "hold") e.rawDepth.push(Math.abs(r.raw.depthMm - tr.depthMm));
    e.axis.push(angleBetween(r.nav.axis, tr.axis));
    if (fr.truth.phase === "align" || fr.truth.phase === "approach") e.aim.push(Math.hypot(r.nav.aim.x - tr.aim.x, r.nav.aim.y - tr.aim.y) * 1000);
    if (fr.truth.phase === "drill" || fr.truth.phase === "hold") e.depth.push(Math.abs(r.nav.depthMm - tr.depthMm));
    if (r.ready) {
      const tg = BOARD_TARGETS[r.targetIndex];
      const truthOff = Math.hypot(tr.aim.x - tg.x, tr.aim.y - tg.y) * 1000;
      if (tr.angleErrDeg >= REQUIREMENT.angleDeg || truthOff >= REQUIREMENT.offsetMm || tr.gapMm > 1) {
        e.falseReady++;
        if (name === "calibrated") worstFalse ||= `t ${t.toFixed(2)} truth ${f2(tr.angleErrDeg)}° ${f2(truthOff)} mm, est ${f2(r.nav.angleErrDeg)}° ${f2(r.nav.offsetMm)} mm`;
      }
      if (fr.truth.phase === "align" && r.targetIndex === fr.truth.targetIndex) e.readyByHole[fr.truth.targetIndex]++;
    }
    if (name === "calibrated" && r.phase === "hold") completed.add(r.targetIndex);
  }
}
{
  const e = E.calibrated;
  check("tracking continuity", e.lost / e.frames < 0.02, `${e.lost}/${e.frames} frames without a pose, markers seen min ${Math.min(...e.markers)} median ${pct(e.markers, 50)}`);
  console.log(`      raw (unfiltered) measurement: tip p50 ${f2(pct(e.rawTip, 50))} p95 ${f2(pct(e.rawTip, 95))} mm, angle p95 ${pct(e.rawAxis, 95).toFixed(3)}°, aim p95 ${f2(pct(e.rawAim, 95))} mm, depth p95 ${f2(pct(e.rawDepth, 95))} mm`);
  console.log(`      raw angle p95 by phase: ${Object.entries(e.byPhase).map(([k, v]) => `${k} ${pct(v, 95).toFixed(3)}`).join(", ")} °`);
  check("tip position p95", pct(e.tip, 95) < 1.0, `p50 ${f2(pct(e.tip, 50))} mm, p95 ${f2(pct(e.tip, 95))} mm, max ${f2(Math.max(...e.tip))} mm`);
  check("bit angle p95", pct(e.axis, 95) < 0.25, `p50 ${pct(e.axis, 50).toFixed(3)}°, p95 ${pct(e.axis, 95).toFixed(3)}°, max ${Math.max(...e.axis).toFixed(3)}°`);
  check("aim point on the surface p95", pct(e.aim, 95) < 0.6, `p50 ${f2(pct(e.aim, 50))} mm, p95 ${f2(pct(e.aim, 95))} mm`);
  check("depth p95", pct(e.depth, 95) < 1.0, `p50 ${f2(pct(e.depth, 50))} mm, p95 ${f2(pct(e.depth, 95))} mm`);
  check("no false 'ready' (truth outside 0.5°/1 mm)", e.falseReady === 0, e.falseReady ? `${e.falseReady} frames, first: ${worstFalse}` : "0 frames");
  check("'ready' reached on every hole", e.readyByHole.every((n) => n > 0), `ready frames while aligning: A1 ${e.readyByHole[0]}, A2 ${e.readyByHole[1]}, A3 ${e.readyByHole[2]}`);
  check("all three holes reach 35 mm and are registered", completed.size === 3, `holes completed: ${[...completed].sort().map((i) => BOARD_TARGETS[i].label).join(", ") || "none"}`);
}
{
  const e = E.naive;
  console.log(
    `      without calibration (66° FOV guess, no distortion, bit assumed parallel): tip p95 ${f2(pct(e.tip, 95))} mm, angle p95 ${pct(e.axis, 95).toFixed(2)}°, aim p95 ${f2(pct(e.aim, 95))} mm, false 'ready' ${e.falseReady}`,
  );
  check("calibration matters (uncalibrated angle p95 > 0.5°)", pct(e.axis, 95) > 0.5, `uncalibrated ${pct(e.axis, 95).toFixed(2)}° vs calibrated ${pct(E.calibrated.axis, 95).toFixed(3)}°`);
}

// ------------------------------------------------------------------------------------------------
console.log("\n4. Safety: occlusion, lost markers, uncalibrated dock");
{
  // a finger over the markers while aligned on A2: the gate must not say ready
  const p = new NavPipeline(core, detector(), { camera, cameraCalibrated: true, tool, toolCalibrated: toolOk });
  const hold: Hold = { tipWorld: [0, -0.02, 0], yawDeg: 0.05, pitchDeg: 0.05, twistDeg: 0 };
  let readyBefore = 0;
  for (let i = 0; i < 12; i++) readyBefore += feed(p, hold, i / FPS, CALM, "align").ready ? 1 : 0;
  // project marker centres to find where to put fingers
  const { pose } = truthNav(core, rig, hold, 1);
  // a hand over the sheet: every marker but one covered
  const centres = core.projectPoints(rig.camera, pose, BOARD_MARKERS.map((m) => [m.x, m.y, 0] as V3)).filter((c) => c && c.x > -40 && c.x < W + 40 && c.y > -40 && c.y < H + 40) as { x: number; y: number }[];
  const occluded: Disturbance = { ...CALM, occluders: centres.slice(1).slice(0, 14).map((c) => ({ cx: c.x, cy: c.y, r: 60 })) };
  let readyAfter = 0;
  let reasons = 0;
  for (let i = 12; i < 24; i++) {
    const r = feed(p, hold, i / FPS, occluded, "align");
    readyAfter += r.ready && i > 18 ? 1 : 0; // allow the 0.35 s hold-over
    reasons |= r.gate;
  }
  check("ready when clear, not ready when markers hidden", readyBefore > 0 && readyAfter === 0, `ready frames clear ${readyBefore}/12, hidden ${readyAfter}/5 (gate bits ${reasons})`);
}
{
  const p = new NavPipeline(core, detector(), { camera, cameraCalibrated: true, tool: GUESS_TOOL, toolCalibrated: false });
  let ready = 0;
  for (let i = 0; i < 10; i++) ready += feed(p, { tipWorld: [0, -0.02, 0], yawDeg: 0, pitchDeg: 0, twistDeg: 0 }, i / FPS, CALM, "align").ready ? 1 : 0;
  check("never ready before the dock is calibrated", ready === 0, `${ready}/10 ready frames`);
}
{
  // shaking hand: tremor 4x
  const p = new NavPipeline(core, detector(), { camera, cameraCalibrated: true, tool, toolCalibrated: toolOk });
  const shaky: Disturbance = { ...DEFAULT_DISTURBANCE, tremorMm: 0.8, tremorDeg: 0.6 };
  let ready = 0;
  let unsteady = 0;
  for (let i = 0; i < 20; i++) {
    const r = feed(p, { tipWorld: [0, -0.02, 0], yawDeg: 0, pitchDeg: 0, twistDeg: 0 }, i / FPS, shaky, "align");
    ready += r.ready ? 1 : 0;
    unsteady += r.gate & 64 ? 1 : 0;
  }
  check("shaking hand is held back", ready === 0, `${ready}/20 ready, ${unsteady}/20 flagged unsteady`);
}

const failed = rows.filter((r) => !r.pass);
console.log(`\n${rows.length - failed.length}/${rows.length} checks passed in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
console.log(failed.length ? "SCENE FAIL" : "SCENE PASS");
calibrated.dispose();
naive.dispose();
process.exit(failed.length ? 1 : 0);
