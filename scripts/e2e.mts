// End-to-end scenarios: simulated camera frames (Rust renderer) -> MarkerTracker -> measurements with
// capture timestamps -> the engine (clock, scene graph, checks) -> snapshots, compared with the
// ground truth at each engine tick. No renderer is involved: navigation is headless.
//
// Run: node --no-warnings scripts/e2e.mts [--quick] [--only name,name] [--tilt 12]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NavCore, cameraFromHfov, type Camera, type EngineSnapshot, type ToolCalib } from "../lib/engine.ts";
import { CALM, DEFAULT_DISTURBANCE, DEFAULT_RIG, IDEAL_RIG, RUN_TIME, V02_RIG, disturb, dockRigAt, markerCodes, navInTarget, renderTool, tiltedRig, toolWorldFromHold, truthAt, type Disturbance, type Hold, type Rig } from "../lib/scene.ts";
import { tipInView } from "../lib/dockrig.ts";
import { NavSession, REQUIREMENT } from "../lib/session.ts";
import { smartToolsScene, toXf, INTO_SHEET } from "../lib/scenedef.ts";
import { BOARD_TARGETS } from "../lib/board.ts";
import { applyDir, compose, qaxis, qmul, xf, type Xf } from "../lib/xform.ts";
import type { V3 } from "../lib/pose.ts";

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const TILT = args.includes("--tilt") ? Number(args[args.indexOf("--tilt") + 1]) : 0;
const RIG_NAME = args.includes("--rig") ? args[args.indexOf("--rig") + 1] : "dock";
const CAM_FPS = QUICK ? 8 : 15;

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const core = await NavCore.load(readFileSync(new URL("../public/engine/nav_core.wasm", import.meta.url)));
const codes = markerCodes(new AR.Dictionary("ARUCO_MIP_36h12").codeList);
const detector = () => new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" });
// dock: the real dock v0.3 (hardware/dock/dock.py), tilted on its hinge with --tilt
// ideal: the idealised rig of the first simulations; v02: dock v0.2 as it was designed
const RIGS: Record<string, () => Rig> = { dock: () => (TILT ? dockRigAt(TILT) : DEFAULT_RIG), ideal: () => (TILT ? tiltedRig(TILT) : IDEAL_RIG), v02: () => V02_RIG };
if (!RIGS[RIG_NAME]) throw new Error(`unknown rig ${RIG_NAME}`);
const rig = RIGS[RIG_NAME]();
const W = rig.width, H = rig.height;
const GUESS_CAMERA: Camera = cameraFromHfov(W, H, 66);
const GUESS_TOOL: ToolCalib = { tipCam: [0, 0.055, 0.17], axisCam: [0, 0, 1] };
const TICK = 1 / 120;

// ---------------- reporting ----------------
const rows: { scenario: string; name: string; pass: boolean; detail: string }[] = [];
let current = "";
const check = (name: string, pass: boolean, detail: string) => {
  rows.push({ scenario: current, name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(50)} ${detail}`);
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const f2 = (x: number) => x.toFixed(2);
const f3 = (x: number) => x.toFixed(3);
const ang = (a: V3, b: V3) => (Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
async function scenario(name: string, title: string, fn: () => void | Promise<void>) {
  if (ONLY && !ONLY.includes(name)) return;
  current = name;
  console.log(`\n[${name}] ${title}`);
  const t0 = performance.now();
  await fn();
  console.log(`  (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------------- simulation driver ----------------
interface DriveOptions {
  session: NavSession | NavSession[];
  /** tool world transform(s) during the exposure at time t, and its phase for disturbances */
  toolAt: (t: number) => { toolW: Xf; blur?: Xf[] };
  from: number;
  to: number;
  cameraFps?: number;
  /** camera-to-tracker latency (s) and per-frame jitter of delivery (s) */
  latency?: number;
  jitter?: number;
  disturbance?: Disturbance;
  /** wall-clock stalls: [start, duration] — nothing runs during them */
  stalls?: [number, number][];
  /** called after each engine advance, with the tool truth at the snapshot time */
  onTick?: (s: EngineSnapshot, truthToolW: Xf, sessionIndex: number) => void;
  seed?: number;
}

/** Drive sessions with a simulated wall clock: frames are captured at cameraFps, tracked after
 * `latency` (+ jitter), and the engine is advanced every tick (120 Hz). */
function drive(o: DriveOptions) {
  const sessions = Array.isArray(o.session) ? o.session : [o.session];
  const fps = o.cameraFps ?? CAM_FPS;
  const d = o.disturbance ?? DEFAULT_DISTURBANCE;
  const pending: { deliverAt: number; tCapture: number; img: ReturnType<typeof renderTool> }[] = [];
  let nextFrame = o.from;
  let k = 0;
  let rnd = o.seed ?? 3;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let wall = o.from; wall <= o.to + 1e-9; wall += TICK) {
    if (o.stalls?.some(([s, dur]) => wall > s && wall < s + dur)) continue;
    while (nextFrame <= wall + 1e-9) {
      const { toolW, blur } = o.toolAt(nextFrame);
      const img = renderTool(core, rig, codes, blur ?? [toolW], d, 17 + k++);
      const jit = o.jitter ? rand() * o.jitter : 0;
      pending.push({ deliverAt: nextFrame + (o.latency ?? 0) + jit, tCapture: nextFrame, img });
      nextFrame += 1 / fps;
    }
    pending.sort((a, b) => a.deliverAt - b.deliverAt);
    while (pending.length && pending[0].deliverAt <= wall + 1e-9) {
      const f = pending.shift()!;
      for (const s of sessions) s.frame(f.img, f.tCapture);
    }
    sessions.forEach((s, i) => {
      const n = s.advance(wall);
      if (n > 0 && o.onTick && s.snapshot) o.onTick(s.snapshot, o.toolAt(s.snapshot.t).toolW, i);
    });
  }
}

/** The standard three-hole run as a tool trajectory (with tremor, vibration and blur). */
function runToolAt(d: Disturbance) {
  return (t: number) => {
    const st = truthAt(Math.min(t, RUN_TIME - 1e-6));
    const held = disturb(st.hold, t, st.phase, d);
    const n = Math.max(1, d.blurSamples);
    const blur: Xf[] = [];
    for (let i = 0; i < n; i++) {
      const ts = t + (n === 1 ? 0 : (i / (n - 1) - 0.5) * d.exposureS);
      blur.push(toolWorldFromHold(core, rig, disturb(st.hold, ts, st.phase, d)));
    }
    return { toolW: toolWorldFromHold(core, rig, held), blur };
  };
}
const holdTool = (h: Hold) => () => ({ toolW: toolWorldFromHold(core, rig, h) });
const targetWorld = (sess: NavSession, name: string): Xf => {
  const n = sess.scene.def.nodes.find((x) => x.name === name)!;
  return compose(toXf(sess.scene.def.nodes.find((x) => x.name === n.parent)?.local), toXf(n.local));
};
const newSession = (o: Partial<ConstructorParameters<typeof NavSession>[2]> = {}) =>
  new NavSession(core, detector(), { camera: GUESS_CAMERA, cameraCalibrated: false, tool: GUESS_TOOL, toolCalibrated: false, ...o });

// shared calibration results
let camera: Camera = rig.camera;
let tool: ToolCalib = rig.tool;
let calibrated = { camera: false, tool: false };

const t0 = performance.now();

// =============================================================================================
await scenario("rig", `Rig geometry (${RIG_NAME}${TILT ? `, tilt ${TILT}°` : ""}): the bit tip in the image, markers in view on every mark`, () => {
  const v = tipInView(rig.tool);
  const halfV = (Math.atan2(rig.height / 2, rig.camera.f) * 180) / Math.PI;
  const halfH = (Math.atan2(rig.width / 2, rig.camera.f) * 180) / Math.PI;
  check("bit tip inside the image (with a 2° margin)", Math.abs(v.downDeg) < halfV - 2 && Math.abs(v.sideDeg) < halfH - 2, `tip ${v.downDeg.toFixed(1)}° below / ${v.sideDeg.toFixed(1)}° aside the optical axis; field ±${halfV.toFixed(1)}° x ±${halfH.toFixed(1)}°`);
  const det = detector();
  const counts: string[] = [];
  let min = Infinity;
  for (const t of BOARD_TARGETS) {
    for (const z of [0, -0.035]) {
      const toolW = toolWorldFromHold(core, rig, { tipWorld: [t.x, t.y, z], yawDeg: 0, pitchDeg: 0, twistDeg: 0 });
      const n = det.detect(renderTool(core, rig, codes, [toolW], CALM, 3)).length;
      min = Math.min(min, n);
      counts.push(`${t.label}${z ? " (35 mm deep)" : ""} ${n}`);
    }
  }
  check("at least 6 markers in view on every mark, on the surface and 35 mm deep", min >= 6, counts.join(", "));
});

await scenario("lens", "Lens calibration: sweep the phone over the sheet (CALM, no latency)", () => {
  const s = newSession();
  s.beginCapture("camera");
  const holds: Hold[] = [];
  for (let i = 0; i < (QUICK ? 30 : 48); i++) {
    const a = i * 0.71;
    holds.push({
      tipWorld: [0.05 * Math.sin(a * 1.3), -0.03 + 0.07 * Math.cos(a * 0.9), 0.08 + 0.12 * (0.5 + 0.5 * Math.sin(a * 0.37))],
      yawDeg: 26 * Math.sin(a),
      pitchDeg: -18 + 26 * Math.cos(a * 1.1),
      twistDeg: 25 * Math.sin(a * 0.6),
    });
  }
  drive({ session: s, toolAt: (t) => ({ toolW: toolWorldFromHold(core, rig, holds[Math.min(holds.length - 1, Math.round(t * CAM_FPS))]) }), from: 0, to: (holds.length - 1) / CAM_FPS, disturbance: CALM });
  const r = s.endCapture();
  if ("camera" in r) {
    camera = r.camera;
    calibrated.camera = true;
    const c = r.camera;
    check("focal length within 1 %", Math.abs(c.f - rig.camera.f) / rig.camera.f < 0.01, `f ${f2(c.f)} vs ${rig.camera.f}, ${r.views} views, rms ${f2(r.rms)} px`);
    check("principal point within 6 px", Math.hypot(c.cx - rig.camera.cx, c.cy - rig.camera.cy) < 6, `(${f2(c.cx)}, ${f2(c.cy)}) vs (${rig.camera.cx}, ${rig.camera.cy})`);
    check("distortion k1 within 0.03", Math.abs(c.k1 - rig.camera.k1) < 0.03, `k1 ${c.k1.toFixed(4)} vs ${rig.camera.k1}`);
  } else check("lens calibration", false, r.error);
  s.dispose();
});

await scenario("dock", "Dock calibration on A2: circle around the tip, then twist around the bit", () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera });
  const a2 = BOARD_TARGETS[1];
  const tip: V3 = [a2.x, a2.y, 0];
  const d: Disturbance = { ...CALM, tremorDeg: 0.04, noise: 2 };
  const N = QUICK ? 36 : 60;
  s.beginCapture("pivot");
  drive({
    session: s,
    from: 0,
    to: (N - 1) / CAM_FPS,
    disturbance: d,
    toolAt: (t) => {
      const i = Math.round(t * CAM_FPS);
      const a = (i / N) * 2 * Math.PI * 1.5;
      const r = 4 + 8 * (i / N);
      return { toolW: toolWorldFromHold(core, rig, { tipWorld: tip, yawDeg: r * Math.cos(a), pitchDeg: r * Math.sin(a), twistDeg: 3 * Math.sin(a * 0.5) }) };
    },
  });
  const pv = s.endCapture();
  if ("tipCam" in pv) check("tip position within 0.7 mm", dist(pv.tipCam, rig.tool.tipCam) * 1000 < 0.7, `error ${f2(dist(pv.tipCam, rig.tool.tipCam) * 1000)} mm, ${pv.frames} frames, wobble ${f2(pv.spreadDeg)}°`);
  else check("tip position", false, pv.error);
  s.beginCapture("roll");
  drive({ session: s, from: 10, to: 10 + (N - 1) / CAM_FPS, disturbance: d, toolAt: (t) => ({ toolW: toolWorldFromHold(core, rig, { tipWorld: tip, yawDeg: 0.4, pitchDeg: -0.3, twistDeg: -28 + (56 * Math.round((t - 10) * CAM_FPS)) / (N - 1) }) }) });
  const ax = s.endCapture();
  if ("axisCam" in ax) {
    tool = s.tool;
    calibrated.tool = s.toolCalibrated;
    check("bit axis within 0.15°", ang(ax.axisCam, rig.tool.axisCam) < 0.15, `error ${f3(ang(ax.axisCam, rig.tool.axisCam))}°, twist ${f2(ax.spreadDeg)}°`);
    check("the engine's tool node is updated and calibrated", s.toolCalibrated && dist(s.tool.tipCam, pv && "tipCam" in pv ? pv.tipCam : [0, 0, 0]) < 1e-12, `calibrated ${s.toolCalibrated}`);
  } else check("bit axis", false, ax.error);
  s.dispose();
});

// =============================================================================================
interface RunMetrics {
  /** while moving fast (approach, retract): reported, not required */
  movingTip: number[];
  tip: number[];
  axis: number[];
  aim: number[];
  depth: number[];
  falseReady: number;
  firstFalse: string;
  readyByTarget: Set<number>;
  depthReached: Set<number>;
  ticks: number;
  statusBad: number;
  snaps: number;
  events: string[];
}
function metricsFor(sess: NavSession, phaseAt: (t: number) => string = (t) => truthAt(Math.min(t, RUN_TIME - 1e-6)).phase) {
  const m: RunMetrics = { movingTip: [], tip: [], axis: [], aim: [], depth: [], falseReady: 0, firstFalse: "", readyByTarget: new Set(), depthReached: new Set(), ticks: 0, statusBad: 0, snaps: 0, events: [] };
  const targetsW = sess.scene.def.navigation.targets.map((n) => targetWorld(sess, n));
  const onTick = (s: EngineSnapshot, truthToolW: Xf) => {
    m.snaps++;
    m.ticks = s.stats.ticks;
    for (const e of s.events) {
      m.events.push(e.kind);
      if (e.kind === "depth-reached") m.depthReached.add(e.node);
    }
    if (s.active < 0 || !s.targets.length) return;
    const cam = s.nodes.find((n) => n.id === sess.id("camera"))!;
    if (cam.status === "lost" || cam.status === "stale") m.statusBad++;
    const est = s.targets[s.active];
    const truth = navInTarget(targetsW[s.active], truthToolW);
    const ph = phaseAt(s.t);
    const tipErr = dist(est.tip, truth.tip) * 1000;
    if (ph === "approach" || ph === "retract") {
      m.movingTip.push(tipErr);
    } else {
      m.tip.push(tipErr);
      m.axis.push(ang(est.axis, truth.axis));
    }
    if (truth.depthMm === 0 && truth.gapMm < 30) m.aim.push(Math.hypot(est.aim[0] - truth.aim[0], est.aim[1] - truth.aim[1]) * 1000);
    if (truth.depthMm > 1 && ph !== "approach" && ph !== "retract") m.depth.push(Math.abs(est.depthMm - truth.depthMm));
    if (s.ready) {
      m.readyByTarget.add(est.id);
      if (truth.angleErrDeg >= REQUIREMENT.angleDeg || truth.offsetMm >= REQUIREMENT.offsetMm || truth.gapMm > 1) {
        m.falseReady++;
        m.firstFalse ||= `t ${f2(s.t)} truth ${f2(truth.angleErrDeg)}° ${f2(truth.offsetMm)} mm gap ${f2(truth.gapMm)}`;
      }
    }
  };
  return { m, onTick };
}

await scenario("drill", `Three holes with tremor, motor vibration, blur and noise; ${CAM_FPS} fps camera, 50 ms latency, engine 120 Hz, no renderer`, () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
  const { m, onTick } = metricsFor(s);
  drive({ session: s, toolAt: runToolAt(DEFAULT_DISTURBANCE), from: 0, to: RUN_TIME, latency: 0.05, onTick: (x, w) => onTick(x, w) });
  const expectedTicks = Math.floor(RUN_TIME * 120);
  check("engine ran every tick (headless, 120 Hz)", Math.abs(m.ticks - expectedTicks) <= 2, `${m.ticks} ticks for ${f2(RUN_TIME)} s (expected ~${expectedTicks})`);
  check("tracking never stale", m.statusBad === 0, `${m.statusBad} ticks with the camera stale or lost`);
  check("tip p95 < 1 mm while aligning and drilling", pct(m.tip, 95) < 1, `p50 ${f2(pct(m.tip, 50))} mm, p95 ${f2(pct(m.tip, 95))} mm`);
  console.log(`        moving fast (approach, retract, up to ~80 mm/s): tip p50 ${f2(pct(m.movingTip, 50))} mm, p95 ${f2(pct(m.movingTip, 95))} mm`);
  check("bit angle p95 < 0.25°", pct(m.axis, 95) < 0.25, `p50 ${f3(pct(m.axis, 50))}°, p95 ${f3(pct(m.axis, 95))}°`);
  check("aim point p95 < 0.6 mm", pct(m.aim, 95) < 0.6, `p50 ${f2(pct(m.aim, 50))} mm, p95 ${f2(pct(m.aim, 95))} mm`);
  check("depth p95 < 1 mm", pct(m.depth, 95) < 1, `p50 ${f2(pct(m.depth, 50))} mm, p95 ${f2(pct(m.depth, 95))} mm`);
  check("no false 'ready' (truth outside 0.5° / 1 mm)", m.falseReady === 0, m.falseReady ? `${m.falseReady} ticks, first: ${m.firstFalse}` : "0 ticks");
  check("'ready' reached on A1, A2 and A3", ["A1", "A2", "A3"].every((n) => m.readyByTarget.has(s.id(n))), [...m.readyByTarget].map((i) => s.name(i)).join(", ") || "none");
  check("depth reached (35 mm) on A1, A2 and A3", ["A1", "A2", "A3"].every((n) => m.depthReached.has(s.id(n))), [...m.depthReached].map((i) => s.name(i)).join(", ") || "none");
  s.dispose();
});

await scenario("latency", "Latency compensation: 80 ms camera latency, prediction on vs off (same frames)", () => {
  const on = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool, engine: { predict: true, predictMaxS: 0.1 } });
  const off = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool, engine: { predict: false } });
  const err: number[][] = [[], []];
  // the approach and retract of hole A1 are the fast parts
  drive({
    session: [on, off],
    toolAt: runToolAt(CALM),
    from: 0,
    to: QUICK ? 3 : 11,
    latency: 0.08,
    onTick: (snap, truthW, i) => {
      const st = truthAt(snap.t).phase;
      if (snap.active < 0 || (st !== "approach" && st !== "retract")) return;
      const tw = targetWorld(i === 0 ? on : off, (i === 0 ? on : off).name(snap.targets[snap.active].id));
      err[i].push(dist(snap.targets[snap.active].tip, navInTarget(tw, truthW).tip) * 1000);
    },
  });
  check("prediction reduces the moving-tip error", pct(err[0], 95) < pct(err[1], 95) * 0.6, `p95 with ${f2(pct(err[0], 95))} mm, without ${f2(pct(err[1], 95))} mm`);
  on.dispose();
  off.dispose();
});

await scenario("decoupled", "Rendering decoupled: a 20 Hz renderer and a 300 ms stall; the engine keeps its clock", () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
  const renders: { tick: number; t: number }[] = [];
  let lastRender = -1;
  let overrunEvents = 0;
  let readyOnOldData = 0;
  const stall: [number, number] = [2.0, 0.3];
  drive({
    session: s,
    toolAt: holdTool({ tipWorld: [BOARD_TARGETS[1].x, BOARD_TARGETS[1].y, 0], yawDeg: 0.05, pitchDeg: -0.05, twistDeg: 0 }),
    from: 0,
    to: 3.5,
    latency: 0.03,
    disturbance: CALM,
    stalls: [stall],
    onTick: (snap) => {
      overrunEvents += snap.events.filter((e) => e.kind === "overrun").length;
      if (snap.ready && snap.poseAgeS > 0.25) readyOnOldData++;
      if (snap.t - lastRender >= 0.05 - 1e-9) {
        renders.push({ tick: snap.tick, t: snap.t });
        lastRender = snap.t;
      }
    },
  });
  const gaps = renders.slice(1).map((r, i) => r.tick - renders[i].tick);
  check("the renderer skips engine ticks (≈ 6 per frame)", pct(gaps, 50) >= 5 && pct(gaps, 50) <= 7, `median ${pct(gaps, 50)} ticks between renders, ${renders.length} renders`);
  check("a stall is reported as an overrun and the clock catches up", overrunEvents >= 1 && Math.abs(s.engine.now() - 3.5) < 0.02, `${overrunEvents} overrun events, engine time ${f3(s.engine.now())} s`);
  check("never 'ready' on data older than 250 ms", readyOnOldData === 0, `${readyOnOldData} ready ticks on old data`);
  check("ready again after the stall", !!s.snapshot?.ready, `ready at the end: ${s.snapshot?.ready}`);
  s.dispose();
});

await scenario("reorder", "Out-of-order delivery: frames arrive with 0 to 2.5 frame intervals of random latency", () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
  const { m, onTick } = metricsFor(s);
  drive({ session: s, toolAt: runToolAt(DEFAULT_DISTURBANCE), from: 0, to: QUICK ? 6 : 11, latency: 0.0, jitter: 2.5 / CAM_FPS, onTick: (x, w) => onTick(x, w), seed: 9 });
  const st = s.snapshot!.stats;
  check("late frames are merged, not dropped", st.lateMerged > 0 && st.lateDropped === 0, `${st.lateMerged} merged, ${st.lateDropped} dropped of ${st.measurements}`);
  // stress case: data up to ~230 ms old while drilling at ~14 mm/s, beyond the 120 ms prediction cap
  check("tip p95 < 1.5 mm while aligning and drilling (stress)", pct(m.tip, 95) < 1.5, `p95 ${f2(pct(m.tip, 95))} mm (moving: p95 ${f2(pct(m.movingTip, 95))} mm)`);
  check("no false 'ready'", m.falseReady === 0, `${m.falseReady}${m.firstFalse ? ", first: " + m.firstFalse : ""}`);
  s.dispose();
});

await scenario("angled", "An angled hole: B1 planned 15° off the normal, approached and drilled along its own axis", () => {
  const scene = smartToolsScene({ tool, angledTargetDeg: 15 });
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool, scene });
  const tw = targetWorld(s, "B1");
  const { m, onTick } = metricsFor(s, (t) => (t < 3 ? "approach" : t < 4.8 ? "align" : "drill"));
  // in the target frame: approach from 40 mm, tilt 3° -> 0.1°, then drill 35 mm along +Z
  const T = 8;
  const toolAt = (t: number) => {
    const k = Math.min(1, t / 3);
    const z = t < 3 ? -0.04 * (1 - k) : t < 4.8 ? 0 : Math.min(0.035, ((t - 4.8) / 2.5) * 0.035);
    const tilt = t < 3 ? 3 - 2.9 * k : 0.1;
    const q = qaxis([1, 1, 0], (tilt * Math.PI) / 180);
    const tipT: V3 = [0.0002, -0.0001, z];
    const local = xf(tipT, q);
    return { toolW: compose(tw, local) };
  };
  drive({ session: s, toolAt, from: 0, to: T, latency: 0.04, disturbance: { ...DEFAULT_DISTURBANCE, tremorMm: 0.05, tremorDeg: 0.02 }, onTick: (x, w) => onTick(x, w) });
  const b1 = s.id("B1");
  check("B1 is chosen as the active target", m.readyByTarget.has(b1) || m.depthReached.has(b1), `ready on ${[...m.readyByTarget].map((i) => s.name(i)).join(", ") || "none"}`);
  check("'ready' on the angled hole", m.readyByTarget.has(b1), "");
  check("depth along the angled axis p95 < 1 mm", pct(m.depth, 95) < 1, `p95 ${f2(pct(m.depth, 95))} mm`);
  check("angle against the planned axis p95 < 0.25°", pct(m.axis, 95) < 0.25, `p95 ${f3(pct(m.axis, 95))}°`);
  check("depth reached on B1", m.depthReached.has(b1), "");
  void INTO_SHEET;
  void qmul;
  void applyDir;
  s.dispose();
});

await scenario("safety", "Safety: markers hidden, uncalibrated dock, shaking hand, tilted while drilling", () => {
  const onA2: Hold = { tipWorld: [BOARD_TARGETS[1].x, BOARD_TARGETS[1].y, 0], yawDeg: 0.05, pitchDeg: 0.05, twistDeg: 0 };
  {
    const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
    let readyBefore = 0, readyHidden = 0;
    drive({ session: s, toolAt: holdTool(onA2), from: 0, to: 1.5, latency: 0.03, disturbance: CALM, onTick: (x) => (readyBefore += x.ready ? 1 : 0) });
    const hidden: Disturbance = { ...CALM, occluders: [{ cx: W / 2, cy: H / 2, r: 2000 }] };
    drive({ session: s, toolAt: holdTool(onA2), from: 1.5 + TICK, to: 3, latency: 0.03, disturbance: hidden, onTick: (x) => (readyHidden += x.ready && x.t > 1.8 ? 1 : 0) });
    const cam = s.snapshot!.nodes.find((n) => n.id === s.id("camera"))!;
    check("ready when clear, not ready when the camera is covered", readyBefore > 0 && readyHidden === 0, `ready ticks clear ${readyBefore}, covered ${readyHidden}, camera ${cam.status}`);
    s.dispose();
  }
  {
    const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool: GUESS_TOOL, toolCalibrated: false });
    let ready = 0;
    drive({ session: s, toolAt: holdTool(onA2), from: 0, to: 1.5, disturbance: CALM, onTick: (x) => (ready += x.ready ? 1 : 0) });
    check("never ready before the dock is calibrated", ready === 0 && (s.snapshot!.gate & 1) === 1, `${ready} ready ticks, gate ${s.snapshot!.gate}`);
    s.dispose();
  }
  {
    const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
    let ready = 0;
    const shaky: Disturbance = { ...DEFAULT_DISTURBANCE, tremorMm: 0.8, tremorDeg: 0.6 };
    drive({ session: s, from: 0, to: 2, disturbance: shaky, toolAt: (t) => ({ toolW: toolWorldFromHold(core, rig, disturb(onA2, t, "align", shaky)) }), onTick: (x) => (ready += x.ready ? 1 : 0) });
    check("a shaking hand is held back", ready === 0, `${ready} ready ticks`);
    s.dispose();
  }
  {
    const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
    const a = (1.2 * Math.PI) / 180;
    const events: string[] = [];
    drive({
      session: s,
      from: 0,
      to: 3,
      disturbance: CALM,
      toolAt: (t) => {
        const d = t < 1 ? 0 : Math.min(0.02, (t - 1) * 0.01);
        return { toolW: toolWorldFromHold(core, rig, { tipWorld: [BOARD_TARGETS[1].x + Math.sin(a) * d, BOARD_TARGETS[1].y, -Math.cos(a) * d], yawDeg: 1.2, pitchDeg: 0, twistDeg: 0 }) };
      },
      onTick: (x) => events.push(...x.events.map((e) => e.kind)),
    });
    check("tilting 1.2° while drilling raises the angle alarm", events.includes("angle-alarm") && (s.snapshot!.alarms & 2) === 2, `alarms ${s.snapshot!.alarms}, events ${[...new Set(events)].join(", ")}`);
    s.dispose();
  }
});

// =============================================================================================
const failed = rows.filter((r) => !r.pass);
console.log(`\n${rows.length - failed.length}/${rows.length} checks passed in ${((performance.now() - t0) / 1000).toFixed(0)} s (rig ${RIG_NAME}${TILT ? `, tilt ${TILT}°` : ""})`);
for (const f of failed) console.log(`  FAILED [${f.scenario}] ${f.name}: ${f.detail}`);
console.log(failed.length ? "E2E FAIL" : "E2E PASS");
process.exit(failed.length ? 1 : 0);
