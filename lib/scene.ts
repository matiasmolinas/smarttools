// Scene simulator: a person drilling the three holes of the A4 marker sheet with the phone docked on
// the drill. Produces ground truth (tool pose, navigation state) and the camera frames the phone would
// see (rendered by the Rust core: lens distortion, the bit in view, motion blur, vibration, lighting,
// noise, occluders). The same frames go through the real pipeline (lib/navpipeline.ts) so every
// number can be checked against the truth: scripts/scene-test.mts (Node) and /lab (browser).

import { BOARD_MARKERS, BOARD_TARGETS } from "./board.ts";
import type { Camera, NavCore, RenderOptions, ToolCalib } from "./engine.ts";
import type { Pose, V3 } from "./pose.ts";
import { applyDir, compose, fromPose, inverse, relative, toPose, type Xf } from "./xform.ts";
import { toolLocal } from "./scenedef.ts";


export type Phase = "approach" | "align" | "drill" | "hold" | "retract";

/** The physical setup the simulation pretends is real. */
export interface Rig {
  /** the true phone camera, at the resolution the pipeline sees (detection runs at 960 px) */
  camera: Camera;
  width: number;
  height: number;
  /** the true dock geometry */
  tool: ToolCalib;
  bitLength: number;
  bitRadius: number;
}

/** A Redmi-class main camera at 960x540 with mild barrel distortion, and a dock ~1.4° off. */
export const DEFAULT_RIG: Rig = {
  camera: { f: 760, cx: 486, cy: 266, k1: -0.08, k2: 0.03, p1: 0, p2: 0 },
  width: 960,
  height: 540,
  tool: { tipCam: [0.003, 0.058, 0.172], axisCam: norm([0.018, -0.016, 1]) },
  bitLength: 0.11,
  bitRadius: 0.003,
};

/** The same rig with the camera tilted down on the dock hinge (degrees), so the bit tip moves from the
 * bottom edge of the image toward its centre. The bit is no longer parallel to the optical axis; the
 * twist calibration measures the new axis. */
export function tiltedRig(deg: number, base: Rig = DEFAULT_RIG): Rig {
  const a = (deg * Math.PI) / 180;
  // camera pitched down by a = points in the camera frame rotate up by a about the camera x axis
  const rot = (v: V3): V3 => [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
  return { ...base, tool: { tipCam: rot(base.tool.tipCam), axisCam: norm(rot(base.tool.axisCam)) } };
}

export interface Disturbance {
  /** hand tremor amplitude: tip mm / axis deg (8-12 Hz physiological tremor) */
  tremorMm: number;
  tremorDeg: number;
  /** motor vibration while drilling: tip mm / axis deg (~35 Hz) */
  vibrationMm: number;
  vibrationDeg: number;
  /** poses averaged per frame (motion blur over the exposure) */
  blurSamples: number;
  exposureS: number;
  noise: number;
  vignette: number;
  gradient: number;
  gain: number;
  /** discs in image px hiding the scene (a finger over the markers) */
  occluders: { cx: number; cy: number; r: number }[];
}

export const DEFAULT_DISTURBANCE: Disturbance = {
  tremorMm: 0.15,
  tremorDeg: 0.06,
  vibrationMm: 0.06,
  vibrationDeg: 0.04,
  blurSamples: 3,
  exposureS: 1 / 60,
  noise: 3,
  vignette: 0.3,
  gradient: 0.2,
  gain: 1,
  occluders: [],
};

export const CALM: Disturbance = { ...DEFAULT_DISTURBANCE, tremorMm: 0, tremorDeg: 0, vibrationMm: 0, vibrationDeg: 0, blurSamples: 1, noise: 1 };

/** How the tool is held at one instant. */
export interface Hold {
  tipWorld: V3;
  yawDeg: number;
  pitchDeg: number;
  twistDeg: number;
}

export interface TruthStep {
  t: number;
  phase: Phase;
  targetIndex: number;
  hold: Hold;
}

// per-hole timeline, seconds
const T = { approach: 2.6, align: 2.4, drill: 3.0, hold: 0.6, retract: 1.6 };
export const HOLE_TIME = T.approach + T.align + T.drill + T.hold + T.retract;
export const RUN_TIME = HOLE_TIME * BOARD_TARGETS.length;

const ease = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** Deterministic per-hole variation (start offset, tilt, twist, residual error) */
function holeStyle(i: number) {
  const r = (k: number) => Math.sin((i + 1) * 12.9898 + k * 78.233) * 0.5 + 0.5;
  return {
    startDx: (r(1) - 0.5) * 0.02,
    startDy: (r(2) - 0.5) * 0.016,
    startYaw: (r(3) - 0.5) * 12,
    startPitch: (r(4) - 0.5) * 10,
    twist: (r(5) - 0.5) * 20,
    // where the person ends up when "aligned": inside tolerance but not perfect
    endYaw: (r(6) - 0.5) * 0.3,
    endPitch: (r(7) - 0.5) * 0.3,
    endDx: (r(8) - 0.5) * 0.0005,
    endDy: (r(9) - 0.5) * 0.0005,
  };
}

/** Ground-truth intention (no tremor) at time t of a full three-hole run. */
export function truthAt(t: number): TruthStep {
  const hole = Math.min(BOARD_TARGETS.length - 1, Math.floor(t / HOLE_TIME));
  let local = t - hole * HOLE_TIME;
  const tg = BOARD_TARGETS[hole];
  const s = holeStyle(hole);
  const gap0 = 0.045;
  const at = (dx: number, dy: number, z: number): V3 => [tg.x + dx, tg.y + dy, z];
  if (local < T.approach) {
    const k = ease(local / T.approach);
    // the tip reaches the surface near the mark, still tilted (2° residual)
    return {
      t,
      phase: "approach",
      targetIndex: hole,
      hold: {
        tipWorld: at(lerp(s.startDx, s.endDx * 3, k), lerp(s.startDy, s.endDy * 3, k), lerp(gap0, 0, k)),
        yawDeg: lerp(s.startYaw, Math.sign(s.startYaw) * 2, k),
        pitchDeg: lerp(s.startPitch, Math.sign(s.startPitch) * 1.6, k),
        twistDeg: s.twist,
      },
    };
  }
  local -= T.approach;
  if (local < T.align) {
    // pivot around the tip: tilt from ~2° down to the final small error, crossing the 0.5° limit
    const k = ease(local / (T.align * 0.8));
    return {
      t,
      phase: "align",
      targetIndex: hole,
      hold: {
        tipWorld: at(lerp(s.endDx * 3, s.endDx, k), lerp(s.endDy * 3, s.endDy, k), 0),
        yawDeg: lerp(Math.sign(s.startYaw) * 2, s.endYaw, k),
        pitchDeg: lerp(Math.sign(s.startPitch) * 1.6, s.endPitch, k),
        twistDeg: s.twist,
      },
    };
  }
  local -= T.align;
  const aligned = { yawDeg: s.endYaw, pitchDeg: s.endPitch, twistDeg: s.twist };
  const depthAxis = (d: number): V3 => {
    // move along the actual bit axis
    const y = (s.endYaw * Math.PI) / 180, p = (s.endPitch * Math.PI) / 180;
    const ax = [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
    return at(s.endDx + ax[0] * d, s.endDy + ax[1] * d, ax[2] * d);
  };
  if (local < T.drill) {
    return { t, phase: "drill", targetIndex: hole, hold: { tipWorld: depthAxis(0.035 * ease(local / T.drill)), ...aligned } };
  }
  local -= T.drill;
  if (local < T.hold) return { t, phase: "hold", targetIndex: hole, hold: { tipWorld: depthAxis(0.035), ...aligned } };
  local -= T.hold;
  const k = ease(local / T.retract);
  return { t, phase: "retract", targetIndex: hole, hold: { tipWorld: depthAxis(lerp(0.035, -0.05, k)), ...aligned } };
}

/** Tremor + vibration added to a hold (deterministic in t). */
export function disturb(h: Hold, t: number, phase: Phase, d: Disturbance): Hold {
  const tremor = (k: number) => Math.sin(t * 2 * Math.PI * 9.3 + k) * 0.6 + Math.sin(t * 2 * Math.PI * 11.7 + 2 * k) * 0.4;
  const vib = (k: number) => (phase === "drill" ? Math.sin(t * 2 * Math.PI * 35 + k) : 0);
  const mm = (k: number) => (d.tremorMm * tremor(k) + d.vibrationMm * vib(k + 5)) / 1000;
  const deg = (k: number) => d.tremorDeg * tremor(k + 10) + d.vibrationDeg * vib(k + 20);
  // the tip is held on the surface by the bit while aligning/drilling: tremor mostly rocks the tool
  const onSurface = phase === "align" || phase === "drill" || phase === "hold";
  const tipK = onSurface ? 0.2 : 1;
  return {
    tipWorld: [h.tipWorld[0] + mm(1) * tipK, h.tipWorld[1] + mm(2) * tipK, h.tipWorld[2] + (onSurface ? 0 : mm(3))],
    yawDeg: h.yawDeg + deg(4),
    pitchDeg: h.pitchDeg + deg(5),
    twistDeg: h.twistDeg + deg(6) * 3,
  };
}

/** True navigation numbers for a hold (independent of the engine): tip, axis, aim, errors. */
export function truthNav(core: NavCore, rig: Rig, h: Hold, targetIndex: number) {
  const pose = core.rigPose(h.yawDeg, h.pitchDeg, h.twistDeg, h.tipWorld, rig.tool);
  const tg = BOARD_TARGETS[targetIndex];
  return { pose, nav: core.navEvaluate(pose, rig.tool, { x: tg.x, y: tg.y }) };
}

export interface SimFrame {
  t: number;
  image: { width: number; height: number; data: Uint8ClampedArray };
  truth: TruthStep & { pose: Pose; nav: ReturnType<NavCore["navEvaluate"]> };
}

/** Marker codes for the renderer from the ArUco dictionary code list ("0101..." per id). */
export function markerCodes(codeList: string[]): Uint8Array {
  const out = new Uint8Array(BOARD_MARKERS.length * 36);
  for (const m of BOARD_MARKERS) for (let b = 0; b < 36; b++) out[m.id * 36 + b] = codeList[m.id][b] === "1" ? 1 : 0;
  return out;
}

/** Render the frame for a hold, with motion blur from the disturbance over the exposure. */
export function renderHold(
  core: NavCore,
  rig: Rig,
  codes: Uint8Array,
  t: number,
  phase: Phase,
  base: Hold,
  d: Disturbance,
  seed: number,
  extra: Partial<RenderOptions> = {},
) {
  const n = Math.max(1, d.blurSamples);
  const poses: Pose[] = [];
  for (let i = 0; i < n; i++) {
    const ts = t + (n === 1 ? 0 : (i / (n - 1) - 0.5) * d.exposureS);
    const h = disturb(base, ts, phase, d);
    poses.push(core.rigPose(h.yawDeg, h.pitchDeg, h.twistDeg, h.tipWorld, rig.tool));
  }
  const data = core.render(rig.camera, poses, {
    width: rig.width,
    height: rig.height,
    ss: 2,
    codes,
    noise: d.noise,
    vignette: d.vignette,
    gradient: d.gradient,
    gain: d.gain,
    seed,
    bit: { tipCam: rig.tool.tipCam, axisCam: rig.tool.axisCam, length: rig.bitLength, radius: rig.bitRadius },
    occluders: d.occluders,
    ...extra,
  });
  return { width: rig.width, height: rig.height, data };
}

/** One frame of the three-hole run. */
export function runFrame(core: NavCore, rig: Rig, codes: Uint8Array, t: number, d: Disturbance, seed = 1): SimFrame {
  const step = truthAt(t);
  const held = disturb(step.hold, t, step.phase, d);
  const truth = truthNav(core, rig, held, step.targetIndex);
  const image = renderHold(core, rig, codes, t, step.phase, step.hold, d, seed + Math.round(t * 1000));
  return { t, image, truth: { ...step, hold: held, ...truth } };
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

// ---------------- general poses (any tool orientation, any target frame) ----------------


/** World transform of the tool (origin at the bit tip, +Z = drilling direction) for a hold. */
export function toolWorldFromHold(core: NavCore, rig: Rig, h: Hold): Xf {
  const pose = core.rigPose(h.yawDeg, h.pitchDeg, h.twistDeg, h.tipWorld, rig.tool);
  return compose(inverse(fromPose(pose)), toolLocal(rig.tool));
}

/** Camera pose (x_cam = R X + t) for a tool world transform, given the dock geometry. */
export function cameraPoseForTool(rig: Rig, toolW: Xf): Pose {
  const camW = compose(toolW, inverse(toolLocal(rig.tool)));
  return toPose(inverse(camW));
}

/** Navigation of a tool against a target frame (+Z = drilling direction), same math as the engine. */
export function navInTarget(targetW: Xf, toolW: Xf) {
  const t = relative(targetW, toolW);
  const tip = t.p;
  const axis = applyDir(t, [0, 0, 1]);
  const s = axis[2] > 1e-6 ? -tip[2] / axis[2] : NaN;
  const aim: [number, number] = Number.isFinite(s) ? [tip[0] + axis[0] * s, tip[1] + axis[1] * s] : [tip[0], tip[1]];
  return {
    tip,
    axis,
    aim,
    angleErrDeg: (Math.acos(Math.min(1, Math.max(-1, axis[2]))) * 180) / Math.PI,
    offsetMm: Number.isFinite(s) ? Math.hypot(aim[0], aim[1]) * 1000 : Infinity,
    gapMm: Math.max(0, -tip[2] * 1000),
    depthMm: Math.max(0, tip[2] * 1000),
  };
}

/** Render the camera frame for a tool held at toolW (with motion blur from a list of tool poses). */
export function renderTool(core: NavCore, rig: Rig, codes: Uint8Array, toolWs: Xf[], d: Disturbance, seed: number, extra: Partial<RenderOptions> = {}) {
  const poses = toolWs.map((w) => cameraPoseForTool(rig, w));
  const data = core.render(rig.camera, poses, {
    width: rig.width,
    height: rig.height,
    ss: 2,
    codes,
    noise: d.noise,
    vignette: d.vignette,
    gradient: d.gradient,
    gain: d.gain,
    seed,
    bit: { tipCam: rig.tool.tipCam, axisCam: rig.tool.axisCam, length: rig.bitLength, radius: rig.bitRadius },
    occluders: d.occluders,
    ...extra,
  });
  return { width: rig.width, height: rig.height, data };
}
