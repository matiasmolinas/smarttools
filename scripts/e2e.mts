// End-to-end scenarios: simulated camera frames (Rust renderer) -> MarkerTracker -> measurements with
// capture timestamps -> the engine (clock, scene graph, checks) -> snapshots, compared with the
// ground truth at each engine tick. No renderer is involved: navigation is headless.
//
// Run: node --no-warnings scripts/e2e.mts [--quick] [--only name,name] [--tilt 12]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NavCore, cameraFromHfov, gateReasonNames, type Camera, type EngineSnapshot, type RenderOptions, type ToolCalib } from "../lib/engine.ts";
import type { TrackerFrame } from "../lib/markertracker.ts";
import { StickerLearner, stickerSpecs, type MarkerBody } from "../lib/anchors.ts";
import { CALM, DEFAULT_DISTURBANCE, DEFAULT_RIG, IDEAL_RIG, RUN_TIME, V02_RIG, disturb, dockRigAt, markerCodes, navInTarget, renderTool, tiltedRig, toolWorldFromHold, truthAt, type Disturbance, type Hold, type Rig } from "../lib/scene.ts";
import { tipInView } from "../lib/dockrig.ts";
import { NavSession, REQUIREMENT } from "../lib/session.ts";
import { smartToolsScene, toXf, INTO_SHEET } from "../lib/scenedef.ts";
import { BOARD_TARGETS } from "../lib/board.ts";
import { applyDir, compose, fromPose, inverse, qaxis, qmul, xf, xlerp, type Xf } from "../lib/xform.ts";
import type { V3 } from "../lib/pose.ts";
import { BASE_BODY, BASE_STICKERS, baseSolids, BASE_ON_BENCH, CHECKPOINTS, FIDUCIALS, SCREWS, SCREW_DEPTHS, assemblyScene, probeError, registerPart, toolAt as toolPose } from "../lib/assembly.ts";

const args = process.argv.slice(2);
const QUICK = args.includes("--quick");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const TILT = args.includes("--tilt") ? Number(args[args.indexOf("--tilt") + 1]) : 0;
const RIG_NAME = args.includes("--rig") ? args[args.indexOf("--rig") + 1] : "dock";
const PHONE = args.includes("--phone") ? args[args.indexOf("--phone") + 1] : undefined;
const CAM_FPS = QUICK ? 8 : 15;

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const core = await NavCore.load(readFileSync(new URL("../public/engine/nav_core.wasm", import.meta.url)));
const codeList: string[] = new AR.Dictionary("ARUCO_MIP_36h12").codeList;
const codes = markerCodes(codeList);
/** the sheet covered (a cloth over it, or no sheet at all): its markers cannot be read */
const COVERED = new Uint8Array(codes.length);
const detector = () => new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" });
// dock: the real dock v0.3 (hardware/dock/dock.py), tilted on its hinge with --tilt
// ideal: the idealised rig of the first simulations; v02: dock v0.2 as it was designed
const RIGS: Record<string, () => Rig> = { dock: () => (TILT || PHONE ? dockRigAt(TILT || undefined, DEFAULT_RIG, PHONE) : DEFAULT_RIG), ideal: () => (TILT ? tiltedRig(TILT) : IDEAL_RIG), v02: () => V02_RIG };
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
  /** after each tracked frame */
  onFrame?: (f: TrackerFrame, sessionIndex: number) => void;
  /** what else is in the scene at time t (parts, stickers), or a covered sheet */
  world?: (t: number) => Partial<RenderOptions>;
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
      const img = renderTool(core, rig, codes, blur ?? [toolW], d, 17 + k++, o.world?.(nextFrame));
      const jit = o.jitter ? rand() * o.jitter : 0;
      pending.push({ deliverAt: nextFrame + (o.latency ?? 0) + jit, tCapture: nextFrame, img });
      nextFrame += 1 / fps;
    }
    pending.sort((a, b) => a.deliverAt - b.deliverAt);
    while (pending.length && pending[0].deliverAt <= wall + 1e-9) {
      const f = pending.shift()!;
      sessions.forEach((s, i) => {
        const tf = s.frame(f.img, f.tCapture);
        o.onFrame?.(tf, i);
      });
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
await scenario("rig", `Rig geometry (${RIG_NAME}${PHONE ? `, ${PHONE}` : ""}${TILT ? `, tilt ${TILT}°` : ""}): the bit tip in the image, markers in view on every mark`, () => {
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

await scenario("reorder", "Out-of-order delivery: frames arrive with 0 to 170 ms of random latency", () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
  const { m, onTick } = metricsFor(s);
  drive({ session: s, toolAt: runToolAt(DEFAULT_DISTURBANCE), from: 0, to: QUICK ? 6 : 11, latency: 0.0, jitter: 2.5 / 15, onTick: (x, w) => onTick(x, w), seed: 9 });
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

await scenario("assembly", "3D assembly: register a part by touching it with the bit, verify, then drive screws on two faces", () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool, scene: assemblyScene({ tool }), targetDepths: SCREW_DEPTHS });
  // turn the tool about its bit so the camera faces the marker sheet's centre (more markers in view)
  const toward = (p: V3): V3 => [-p[0], -p[1], 0];
  const truthW = (name: string) => compose(BASE_ON_BENCH, SCREWS.find((x) => x.name === name)!.frame);
  const fromPart = (p: V3) => compose(BASE_ON_BENCH, xf(p)).p;
  const d: Disturbance = { ...DEFAULT_DISTURBANCE, tremorMm: 0.08, tremorDeg: 0.04, vibrationMm: 0.05, vibrationDeg: 0.03 };
  const tipNow = () => s.world("tool")!.p;
  let t0 = 0;
  /** hold the tip on a world point for `dur` seconds and return the engine's mean tip over the last half */
  const touch = (p: V3, axis: V3 = [0.03, -0.02, -1]) => {
    const tips: V3[] = [];
    const n = Math.hypot(...axis);
    const ax = axis.map((v) => v / n) as V3;
    drive({
      session: s,
      from: t0,
      to: t0 + 1.2,
      latency: 0.04,
      disturbance: { ...d, vibrationMm: 0, vibrationDeg: 0 },
      toolAt: (t) => ({ toolW: compose(toolPose(p, ax, toward(p)), xf([0.00004 * Math.sin(t * 59), 0.00004 * Math.cos(t * 61), 0])) }),
      onTick: (snap) => snap.t > t0 + 0.6 && tips.push(tipNow()),
    });
    t0 += 1.3;
    return [0, 1, 2].map((k) => tips.reduce((a, v) => a + v[k], 0) / tips.length) as V3;
  };

  // 1. before registering, the gate stays shut on the part's holes
  let readyBefore = 0;
  drive({ session: s, from: t0, to: t0 + 1.5, latency: 0.04, disturbance: CALM, toolAt: () => ({ toolW: toolPose(truthW("S1").p, [0, 0, -1], toward(truthW("S1").p)) }), onTick: (x) => (readyBefore += x.ready ? 1 : 0) });
  t0 += 1.6;
  check("no screw before the part is registered", readyBefore === 0 && (s.snapshot!.gate & 128) === 128, `${readyBefore} ready ticks, gate reasons ${s.snapshot!.gate} (not located)`);

  // 2. register: touch the four dimples
  const touches = FIDUCIALS.map((f) => touch(fromPart(f.p)));
  const reg = registerPart(core, s.engine, s.id("base"), xf(), FIDUCIALS.map((f) => f.p), touches)!;
  const holeErr = Math.max(...SCREWS.filter((x) => x.part === "base").map((x) => dist(compose(reg.world, x.frame).p, truthW(x.name).p) * 1000));
  check("registration by touch: FRE < 0.6 mm", reg.freMm < 0.6, `FRE ${f2(reg.freMm)} mm (max ${f2(reg.maxMm)} mm) from 4 touches`);
  check("every base hole within 0.8 mm of the true part", holeErr < 0.8, `worst hole ${f2(holeErr)} mm`);

  // 3. verify on points not used to register
  // the bit square to the surface it touches: K1 is on the chamfer
  const chamferAxis = applyDir(truthW("C1"), [0, 0, 1]);
  const ver = CHECKPOINTS.map((k) => probeError(reg.world, k.p, touch(fromPart(k.p), k.name === "K1" ? chamferAxis : undefined)));
  check("verification touches within 1 mm", ver.every((e) => e < 1), CHECKPOINTS.map((k, i) => `${k.name} ${f2(ver[i])} mm`).join(", "));

  // 4. drive S1 (top) and C1 (35° chamfer)
  for (const name of ["S1", "C1"]) {
    const tw = truthW(name);
    const depth = SCREWS.find((x) => x.name === name)!.depthMm / 1000;
    const tips: number[] = [], angles: number[] = [];
    let falseReady = 0, ready = 0, seated = false;
    const start = t0;
    drive({
      session: s,
      from: t0,
      to: t0 + 6,
      latency: 0.04,
      disturbance: d,
      toolAt: (t) => {
        const k = Math.min(1, (t - start) / 2);
        const z = t - start < 2 ? -0.03 * (1 - k) : t - start < 3.6 ? 0 : Math.min(depth, ((t - start - 3.6) / 1.8) * depth);
        const tilt = t - start < 2 ? 3 - 2.85 * k : 0.12;
        const local = xf([0.00015, -0.0001, z], qaxis([1, 0.4, 0], (tilt * Math.PI) / 180));
        const w = compose(tw, local);
        return { toolW: toolPose(w.p, applyDir(w, [0, 0, 1]), toward(tw.p)) };
      },
      onTick: (snap, truthToolW) => {
        if (snap.active < 0 || s.name(snap.targets[snap.active].id) !== name) return;
        const est = snap.targets[snap.active];
        const tr = navInTarget(tw, truthToolW);
        // accuracy while aligning and driving (the approach moves fast, as in the drilling scenarios)
        if (snap.t - start > 2.2) {
          tips.push(dist(est.tip, tr.tip) * 1000);
          angles.push(ang(est.axis, tr.axis));
        }
        if (snap.ready) {
          ready++;
          if (tr.angleErrDeg >= REQUIREMENT.angleDeg || tr.offsetMm >= REQUIREMENT.offsetMm || tr.gapMm > 1) falseReady++;
        }
        if (snap.events.some((e) => e.kind === "depth-reached" && s.name(e.node) === name)) seated = true;
      },
    });
    t0 += 6.2;
    const face = SCREWS.find((x) => x.name === name)!.face;
    check(`${name} (${face}): ready, seated at ${depth * 1000} mm, tip p95 < 1 mm`, ready > 0 && seated && pct(tips, 95) < 1 && falseReady === 0, `ready ${ready} ticks, seated ${seated}, tip p95 ${f2(pct(tips, 95))} mm, angle p95 ${f3(pct(angles, 95))}°, false ready ${falseReady}`);
  }
  s.dispose();
});

// ---------------- markers on the part: learned stickers and factory markers ----------------

/** Drive one screw on a part whose true pose is `partW(t)`; returns the accuracy and the events seen. */
/** `towardDeg`: the direction (deg, in the bench plane) the person turns the camera to about the bit; by default
 * toward the sheet's centre. */
function driveScrew(s: NavSession, name: string, start: number, partW: (t: number) => Xf, world: (t: number) => Partial<RenderOptions>, d: Disturbance, opts: { slipAt?: number; towardDeg?: number } = {}) {
  const spec = SCREWS.find((x) => x.name === name)!;
  const depth = spec.depthMm / 1000;
  const toward = (p: V3): V3 => (opts.towardDeg == null ? [-p[0], -p[1], 0] : [Math.cos((opts.towardDeg * Math.PI) / 180), Math.sin((opts.towardDeg * Math.PI) / 180), 0]);
  const tips: number[] = [], angles: number[] = [];
  let ready = 0, falseReady = 0, seated = false, alarmAt = NaN, alarmBefore = 0;
  drive({
    session: s,
    from: start,
    to: start + 6,
    latency: 0.04,
    disturbance: d,
    world,
    toolAt: (t) => {
      const tw = compose(partW(t), spec.frame);
      const k = Math.min(1, (t - start) / 2);
      const z = t - start < 2 ? -0.03 * (1 - k) : t - start < 3.6 ? 0 : Math.min(depth, ((t - start - 3.6) / 1.8) * depth);
      const tilt = t - start < 2 ? 3 - 2.85 * k : 0.12;
      const w = compose(tw, xf([0.00015, -0.0001, z], qaxis([1, 0.4, 0], (tilt * Math.PI) / 180)));
      return { toolW: toolPose(w.p, applyDir(w, [0, 0, 1]), toward(tw.p)) };
    },
    onTick: (snap, truthToolW) => {
      const tw = compose(partW(snap.t), spec.frame);
      if (snap.alarms & 8) {
        if (opts.slipAt != null && snap.t >= opts.slipAt) alarmAt = Number.isNaN(alarmAt) ? snap.t : alarmAt;
        else alarmBefore++;
      }
      if (snap.active < 0 || s.name(snap.targets[snap.active].id) !== name) return;
      const est = snap.targets[snap.active];
      const tr = navInTarget(tw, truthToolW);
      if (snap.t - start > 2.2 && (opts.slipAt == null || snap.t < opts.slipAt)) {
        tips.push(dist(est.tip, tr.tip) * 1000);
        angles.push(ang(est.axis, tr.axis));
      }
      if (snap.ready) {
        ready++;
        if (tr.angleErrDeg >= REQUIREMENT.angleDeg || tr.offsetMm >= REQUIREMENT.offsetMm || tr.gapMm > 1) falseReady++;
      }
      if (snap.events.some((e) => e.kind === "depth-reached" && s.name(e.node) === name)) seated = true;
    },
  });
  return { tips, angles, ready, falseReady, seated, alarmAt, alarmBefore, face: spec.face, depthMm: spec.depthMm };
}

const holeErrMm = (s: NavSession, truthPart: Xf) =>
  Math.max(...SCREWS.filter((x) => x.part === "base").map((x) => dist(compose(s.world("base")!, x.frame).p, compose(truthPart, x.frame).p) * 1000));

await scenario("anchors", "Stickers on the part: register by touch, learn the stickers, then move the part, cover the sheet, catch a slip", () => {
  // where the user actually stuck the stickers: near the planned spots, a few mm and degrees off
  const stuck: MarkerBody = {
    name: BASE_BODY.name,
    stickers: BASE_STICKERS.map((st, i) => ({ ...st, pose: compose(st.pose, xf([0.003 * Math.sin(i * 2.1), 0.0025 * Math.cos(i * 1.7), 0], qaxis([0, 0, 1], ((7 * Math.sin(i * 1.3)) * Math.PI) / 180))) })),
  };
  // one body per sticker while learning: the tracker reports each sticker's own pose
  const single: MarkerBody[] = BASE_STICKERS.map((st) => ({ name: st.name, stickers: [{ ...st, pose: xf() }] }));
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool, scene: assemblyScene({ tool, anchors: "learned" }), targetDepths: SCREW_DEPTHS, bodies: single });
  const d: Disturbance = { ...DEFAULT_DISTURBANCE, tremorMm: 0.08, tremorDeg: 0.04, vibrationMm: 0.05, vibrationDeg: 0.03 };
  const toward = (p: V3): V3 => [-p[0], -p[1], 0];
  let partTrue: Xf = BASE_ON_BENCH;
  let partAt = (_t: number) => partTrue;
  let sheetCovered = false;
  const world = (t: number): Partial<RenderOptions> => ({ solids: baseSolids(partAt(t)), stickers: stickerSpecs(stuck, partAt(t), codeList), ...(sheetCovered ? { codes: COVERED } : {}) });
  let t0 = 0;
  const touch = (p: V3) => {
    const tips: V3[] = [];
    const ax: V3 = [0.03, -0.02, -1].map((v) => v / Math.hypot(0.03, 0.02, 1)) as V3;
    drive({ session: s, from: t0, to: t0 + 1.2, latency: 0.04, world, disturbance: { ...d, vibrationMm: 0, vibrationDeg: 0 }, toolAt: () => ({ toolW: toolPose(p, ax, toward(p)) }), onTick: (snap) => snap.t > t0 + 0.6 && tips.push(s.world("tool")!.p) });
    t0 += 1.3;
    return [0, 1, 2].map((k) => tips.reduce((a, v) => a + v[k], 0) / tips.length) as V3;
  };
  // 1. register by touch, with the part (and its stickers) in the camera's view
  const touches = FIDUCIALS.map((f) => touch(compose(BASE_ON_BENCH, xf(f.p)).p));
  const reg = registerPart(core, s.engine, s.id("base"), xf(), FIDUCIALS.map((f) => f.p), touches)!;
  const regHole = Math.max(...SCREWS.filter((x) => x.part === "base").map((x) => dist(compose(reg.world, x.frame).p, compose(BASE_ON_BENCH, x.frame).p) * 1000));
  check("registered by touch (stickers in view do not disturb it)", reg.freMm < 0.6 && regHole < 0.8, `FRE ${f2(reg.freMm)} mm, worst hole ${f2(regHole)} mm`);

  // 2. learn the stickers: hover over two screws so every sticker is seen from a few views
  const learner = new StickerLearner(BASE_STICKERS);
  for (const name of ["S1", "C1", "S2"]) {
    const tw = compose(BASE_ON_BENCH, SCREWS.find((x) => x.name === name)!.frame);
    const ax = applyDir(tw, [0, 0, 1]);
    drive({
      session: s, from: t0, to: t0 + 1.5, latency: 0.04, world, disturbance: CALM,
      toolAt: (t) => ({ toolW: toolPose(applyDir(tw, [0.01 * Math.sin(t * 2), 0.01 * Math.cos(t * 2), -0.03]).map((v, k) => v + tw.p[k]) as V3, ax, toward(tw.p)) }),
      onFrame: (f) => {
        if (!f.pose || f.markers < 6) return;
        // the camera at capture time, from the sheet in the same frame; the part where it was registered
        const seen = new Map(f.bodies.filter((b) => b.markers >= 2).map((b) => [b.name, b.pose]));
        learner.add(inverse(fromPose(f.pose)), reg.world, seen);
      },
    });
    t0 += 1.6;
  }
  const { body, spreadMm } = learner.body(BASE_BODY.name, 4);
  const errs = body.stickers.map((st) => dist(st.pose.p, stuck.stickers.find((x) => x.name === st.name)!.pose.p) * 1000);
  check("stickers learned where they were stuck (< 0.6 mm)", body.stickers.length >= 4 && Math.max(...errs) < 0.6, `${body.stickers.length}/${BASE_STICKERS.length} stickers (${body.stickers.map((x, i) => `${x.name} ${f2(errs[i])}`).join(", ")} mm), spread ≤ ${f2(Math.max(...Object.values(spreadMm)))} mm`);
  s.tracker.setBodies([body]);
  s.engine.setCalibrated(s.id(BASE_BODY.name), true);

  // 3. the user turns the part 25° and slides it 4 cm while the camera watches: no touching again
  const moved = compose(xf([0.03, 0.025, 0], qaxis([0, 0, 1], (25 * Math.PI) / 180)), BASE_ON_BENCH);
  const m0 = t0;
  partAt = (t) => (t < m0 + 0.3 ? BASE_ON_BENCH : t > m0 + 1.8 ? moved : xlerp(BASE_ON_BENCH, moved, (t - m0 - 0.3) / 1.5));
  const hover = compose(BASE_ON_BENCH, SCREWS[2].frame);
  drive({ session: s, from: t0, to: t0 + 3, latency: 0.04, world, disturbance: CALM, toolAt: () => ({ toolW: toolPose(applyDir(hover, [0, 0, -0.06]).map((v, k) => v + hover.p[k]) as V3, applyDir(hover, [0, 0, 1]), toward(hover.p)) }) });
  t0 += 3.1;
  partTrue = moved;
  partAt = () => moved;
  check("the part moved 4 cm and 25°: the engine follows it (holes < 0.8 mm)", holeErrMm(s, moved) < 0.8, `worst hole ${f2(holeErrMm(s, moved))} mm after the move`);

  // 4. drive a top screw on the moved part. The part now hides most of the sheet from S3: turned toward the sheet's
  // centre the camera reads only 3 of its markers, the camera's pose has fewer than the gate's 4 and the screw is never
  // ready. So the person turns the drill about the bit (as the screen asks: "Show more markers") until the camera
  // looks past the part's corner at the sheet: 6 of its markers, and 6 of the stickers' still in view.
  const r1 = driveScrew(s, "S3", t0, partAt, world, d, { towardDeg: -110 });
  t0 += 6.2;
  check(`S3 on the moved part: seated, tip p95 < 1 mm`, r1.ready > 0 && r1.seated && pct(r1.tips, 95) < 1 && r1.falseReady === 0 && r1.alarmBefore === 0, `ready ${r1.ready}, seated ${r1.seated}, tip p95 ${f2(pct(r1.tips, 95))} mm, angle p95 ${f3(pct(r1.angles, 95))}°, false ready ${r1.falseReady}, false slip alarms ${r1.alarmBefore}`);

  // 5. the sheet covered: the part's stickers are the only reference
  sheetCovered = true;
  const r2 = driveScrew(s, "C1", t0, partAt, world, d);
  t0 += 6.2;
  check(`C1 (35° chamfer) with the sheet covered: seated, tip p95 < 1 mm`, r2.ready > 0 && r2.seated && pct(r2.tips, 95) < 1 && r2.falseReady === 0, `ready ${r2.ready}, seated ${r2.seated}, tip p95 ${f2(pct(r2.tips, 95))} mm, angle p95 ${f3(pct(r2.angles, 95))}°`);
  sheetCovered = false;

  // 6. the part slips 1.2 mm in the vise halfway down
  const slipAt = t0 + 4.4;
  const before = partAt(0);
  partAt = (t) => (t < slipAt ? before : compose(xf([0.0012 * Math.min(1, (t - slipAt) / 0.15), 0, 0]), before));
  const r3 = driveScrew(s, "S4", t0, partAt, world, d, { slipAt });
  t0 += 6.2;
  check("a slip while driving raises the part-moved alarm within 0.3 s", !Number.isNaN(r3.alarmAt) && r3.alarmAt - slipAt < 0.3 && r3.alarmBefore === 0, `alarm ${Number.isNaN(r3.alarmAt) ? "none" : `${f2((r3.alarmAt - slipAt) * 1000 / 1000)} s after the slip`}, false alarms before ${r3.alarmBefore}`);
  s.dispose();
});

await scenario("factory", "Factory markers: the part locates itself, no touching", () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool, scene: assemblyScene({ tool, anchors: "factory" }), targetDepths: SCREW_DEPTHS, bodies: [BASE_BODY] });
  const d: Disturbance = { ...DEFAULT_DISTURBANCE, tremorMm: 0.08, tremorDeg: 0.04, vibrationMm: 0.05, vibrationDeg: 0.03 };
  const part = compose(xf([-0.02, 0.03, 0], qaxis([0, 0, 1], (-12 * Math.PI) / 180)), BASE_ON_BENCH);
  const world = (): Partial<RenderOptions> => ({ solids: baseSolids(part), stickers: stickerSpecs(BASE_BODY, part, codeList) });
  let locatedAt = NaN;
  const hover = compose(part, SCREWS[0].frame);
  drive({
    session: s, from: 0, to: 1.5, latency: 0.04, world, disturbance: CALM,
    toolAt: () => ({ toolW: toolPose(applyDir(hover, [0, 0, -0.06]).map((v, k) => v + hover.p[k]) as V3, applyDir(hover, [0, 0, 1]), [-hover.p[0], -hover.p[1], 0]) }),
    onTick: (snap) => {
      if (Number.isNaN(locatedAt) && snap.events.some((e) => e.kind === "part-located")) locatedAt = snap.t;
    },
  });
  check("located from its own markers on sight (< 0.5 s), holes < 0.8 mm", locatedAt < 0.5 && holeErrMm(s, part) < 0.8, `located at ${f2(locatedAt)} s, worst hole ${f2(holeErrMm(s, part))} mm, no touch`);
  let t0 = 1.6;
  for (const name of ["S4", "C2"]) {
    const r = driveScrew(s, name, t0, () => part, world, d);
    t0 += 6.2;
    check(`${name} (${r.face}): seated at ${r.depthMm} mm, tip p95 < 1 mm`, r.ready > 0 && r.seated && pct(r.tips, 95) < 1 && r.falseReady === 0, `ready ${r.ready}, seated ${r.seated}, tip p95 ${f2(pct(r.tips, 95))} mm, angle p95 ${f3(pct(r.angles, 95))}°`);
  }
  s.dispose();
});

await scenario("gestures", "Gestures with the tool on real camera frames: two taps confirm, a twist moves on, nothing else fires", () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
  const a2 = BOARD_TARGETS[1];
  const d: Disturbance = { ...DEFAULT_DISTURBANCE, vibrationMm: 0, vibrationDeg: 0 };
  // tip height (mm above the sheet) and roll (deg) over time
  const script = (t: number): { z: number; roll: number } => {
    if (t < 1.5) return { z: 30 * (1 - t / 1.5), roll: 0 }; // approach
    if (t < 3) return { z: 0, roll: 0 }; // rest on the mark (not a tap)
    if (t < 3.6) return { z: 4, roll: 0 };
    const tap = (t0: number) => t >= t0 && t < t0 + 0.14;
    if (tap(3.6) || tap(4.05)) return { z: 0, roll: 0 };
    if (t < 5.4) return { z: 4, roll: 0 };
    if (t < 6.2) return { z: 4, roll: 72 * (1 - Math.abs((t - 5.8) / 0.4)) }; // twist out and back
    if (t < 7) return { z: 4, roll: 0 };
    return { z: 4, roll: Math.min(80, (t - 7) * 40) }; // a slow turn that stays: not a twist
  };
  const toolAt = (t: number) => {
    const sc = script(t);
    const h = disturb({ tipWorld: [a2.x + 0.0002, a2.y, sc.z / 1000], yawDeg: 0.2, pitchDeg: -0.1, twistDeg: sc.roll }, t, "align", d);
    return { toolW: toolWorldFromHold(core, rig, h) };
  };
  const seen: { kind: string; t: number }[] = [];
  drive({ session: s, from: 0, to: 10, latency: 0.04, disturbance: d, toolAt, onTick: (snap) => snap.events.forEach((e) => e.kind.startsWith("gesture") && seen.push({ kind: e.kind, t: snap.t })) });
  const taps = seen.filter((x) => x.kind === "gesture-tap"), twists = seen.filter((x) => x.kind === "gesture-twist");
  check("two taps of the tip: one confirm, right after the second tap", taps.length === 1 && taps[0].t > 4.1 && taps[0].t < 4.7, taps.map((x) => `${f2(x.t)} s`).join(", ") || "none");
  check("a twist out and back: one next; the slow turn is not one", twists.length === 1 && twists[0].t > 5.9 && twists[0].t < 6.6, twists.map((x) => `${f2(x.t)} s`).join(", ") || "none");
  s.dispose();
});

await scenario("nogo", "No-go zones on real camera frames: a pipe behind A2 blocks it, A3 is free", () => {
  const def = smartToolsScene({ tool });
  def.nodes.push({ name: "pipe", parent: "sheet", kind: "display", local: { p: [0, -0.02, -0.018] } });
  def.navigation.keepouts = [{ node: "pipe", half: [0.2, 0.01, 0.01], marginMm: 6 }];
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool, scene: def });
  const on = (i: number) => {
    const t = BOARD_TARGETS[i];
    return (tt: number) => ({ toolW: toolWorldFromHold(core, rig, disturb({ tipWorld: [t.x + 0.0002, t.y, 0], yawDeg: 0.1, pitchDeg: -0.05, twistDeg: 0 }, tt, "align", DEFAULT_DISTURBANCE)) });
  };
  let readyA2 = 0, readyA3 = 0, gateA2 = 0;
  drive({ session: s, from: 0, to: 3, latency: 0.04, toolAt: on(1), onTick: (x) => { readyA2 += x.ready ? 1 : 0; gateA2 |= x.gate; } });
  drive({ session: s, from: 3, to: 6, latency: 0.04, toolAt: on(2), onTick: (x) => (readyA3 += x.ready ? 1 : 0) });
  check("A2 (pipe 8 mm behind it) never ready: no-go zone", readyA2 === 0 && (gateA2 & 256) === 256, `${readyA2} ready ticks, gate ${gateA2}`);
  check("A3 (clear of the pipe) is ready", readyA3 > 0, `${readyA3} ready ticks`);
  s.dispose();
});

await scenario("motor", "A running motor on the mark: the drill held square on A2 with the motor's shake (scripts/bench-sim.mts), 30 fps, 5 s", () => {
  const s = newSession({ camera, cameraCalibrated: calibrated.camera, tool, toolCalibrated: calibrated.tool });
  // the bench reference's free-spinning motor: 0.15 mm / 0.12° at 35 Hz, with the blur of a 1/60 s exposure
  const MOTOR: Disturbance = { ...CALM, vibrationMm: 0.15, vibrationDeg: 0.12, blurSamples: 3, exposureS: 1 / 60, noise: 3 };
  const onA2: Hold = { tipWorld: [BOARD_TARGETS[1].x, BOARD_TARGETS[1].y, 0], yawDeg: 0, pitchDeg: 0, twistDeg: 0 };
  const FPS = 30;
  let frames = 0, tracked = 0, ticks = 0, open = 0, angleAlarm = 0;
  const shut = new Map<string, number>();
  drive({
    session: s,
    from: 0,
    to: 5,
    cameraFps: FPS,
    latency: 0.04,
    disturbance: MOTOR,
    toolAt: (t) => {
      const blur: Xf[] = [];
      for (let i = 0; i < MOTOR.blurSamples; i++) blur.push(toolWorldFromHold(core, rig, disturb(onA2, t + (i / (MOTOR.blurSamples - 1) - 0.5) * MOTOR.exposureS, "drill", MOTOR)));
      return { toolW: toolWorldFromHold(core, rig, disturb(onA2, t, "drill", MOTOR)), blur };
    },
    onFrame: (f) => {
      frames++;
      if (f.pose) tracked++;
    },
    onTick: (x) => {
      if (x.alarms & 2 || x.events.some((e) => e.kind === "angle-alarm")) angleAlarm++;
      if (x.t <= 1) return;
      ticks++;
      if (x.gate === 0) open++;
      else for (const r of gateReasonNames(x.gate)) shut.set(r, (shut.get(r) ?? 0) + 1);
    },
  });
  const share = ticks ? open / ticks : 0;
  const why = [...shut].map(([r, n]) => `${r} ${n}`).join(", ");
  check("tracked every frame", frames > 0 && tracked === frames, `${tracked}/${frames} frames`);
  check("after 1 s the gate stays open at least 95% of the ticks", share >= 0.95, `open ${open}/${ticks} ticks (${(share * 100).toFixed(1)}%)${why ? `; closed by ${why}` : ""}`);
  check("the angle alarm never fires", angleAlarm === 0, `${angleAlarm} ticks with the angle alarm`);
  s.dispose();
});

// =============================================================================================
const failed = rows.filter((r) => !r.pass);
console.log(`\n${rows.length - failed.length}/${rows.length} checks passed in ${((performance.now() - t0) / 1000).toFixed(0)} s (rig ${RIG_NAME}${PHONE ? `, phone ${PHONE}` : ""}${TILT ? `, tilt ${TILT}°` : ""})`);
for (const f of failed) console.log(`  FAILED [${f.scenario}] ${f.name}: ${f.detail}`);
console.log(failed.length ? "E2E FAIL" : "E2E PASS");
process.exit(failed.length ? 1 : 0);
