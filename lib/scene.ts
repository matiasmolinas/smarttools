// Scene simulator: a person drilling the three holes of the A4 marker sheet with the phone docked on
// the drill. Produces ground truth (tool pose, navigation state) and the camera frames the phone would
// see (rendered by the Rust core: lens distortion, the bit in view, motion blur, vibration, lighting,
// noise, occluders). The same frames go through the real pipeline (lib/navpipeline.ts) so every
// number can be checked against the truth: scripts/scene-test.mts (Node) and /lab (browser).

import { BOARD_MARKERS, BOARD_TARGETS, MARKER_SIZE, SHEET, sheetMarkerCorners, sheetMarkerIds } from "./board.ts";
import type { Camera, NavCore, RenderOptions, SheetSpec, SolidSpec, ToolCalib } from "./engine.ts";
import type { Pose, V3 } from "./pose.ts";
import { applyDir, compose, fromPose, inverse, qaxis, relative, toPose, type Xf } from "./xform.ts";
import { toolLocal } from "./scenedef.ts";
import { dockRig, type PhoneProfile } from "./dockrig.ts";


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

const CAMERA_960: Camera = { f: 760, cx: 486, cy: 266, k1: -0.08, k2: 0.03, p1: 0, p2: 0 };

/** The real dock (hardware/dock/dock.py -> lib/dockgeom.ts) at its default tilt, with a Redmi-class main
 * camera at 960x540 and mild barrel distortion. */
export const DEFAULT_RIG: Rig = {
  camera: CAMERA_960,
  width: 960,
  height: 540,
  tool: dockRig().tool,
  bitLength: 0.11,
  bitRadius: 0.003,
};

/** The idealised rig the first simulations used (camera 58 mm above the bit, 3 mm aside, 1.4° off). */
export const IDEAL_RIG: Rig = { ...DEFAULT_RIG, tool: { tipCam: [0.003, 0.058, 0.172], axisCam: norm([0.018, -0.016, 1]) } };

/** Dock v0.2 as designed (camera at the fixed-jaw end, top edge): 78 mm aside and 170 mm above the bit. */
export const V02_RIG: Rig = { ...DEFAULT_RIG, tool: { tipCam: [0.078, 0.1696, 0.209], axisCam: [0, 0, 1] } };

/** The dock at a given hinge tilt (default: its default tilt) (the camera moves with the arm about the pivot), optionally with
 * a phone profile (lib/phones.ts) instead of the reference phone. */
export function dockRigAt(tiltDeg?: number, base: Rig = DEFAULT_RIG, phone?: PhoneProfile | string): Rig {
  return { ...base, tool: dockRig({ tiltDeg, phone }).tool };
}

/** A rig with the camera rotated down by `deg` about its own centre (used with the ideal rig). */
export function tiltedRig(deg: number, base: Rig = IDEAL_RIG): Rig {
  const a = (deg * Math.PI) / 180;
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
  const hole = Math.min(BOARD_TARGETS.length - 1, Math.max(0, Math.floor(t / HOLE_TIME)));
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
  // every id of the dictionary (the sheet's first; markers on parts use higher ids)
  const n = Math.max(BOARD_MARKERS.length, codeList.length);
  const out = new Uint8Array(n * 36);
  for (let id = 0; id < n; id++) for (let b = 0; b < 36; b++) out[id * 36 + b] = codeList[id]?.[b] === "1" ? 1 : 0;
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

// ---------------- the pilot job: a table of four sheets, a wood block on it ----------------

/** The simulator's table: four sheets in a 2 × 2 arrangement with 6 mm gaps, each laid by hand a little turned
 * (0°, 1.5°, −2°, 0.8°), sheet 0 (the world frame) bottom-left. Placements in metres and radians, as the renderer
 * takes them (RenderOptions.sheets). */
const DEG = Math.PI / 180;
export const PILOT_TABLE: SheetSpec[] = [
  { k: 0, x: 0, y: 0, yaw: 0 },
  { k: 1, x: SHEET.w + 0.006, y: 0, yaw: 1.5 * DEG },
  { k: 2, x: 0, y: SHEET.h + 0.006, yaw: -2 * DEG },
  { k: 3, x: SHEET.w + 0.006, y: SHEET.h + 0.006, yaw: 0.8 * DEG },
];
/** One sheet alone (the layout before the table: the block beside it). */
export const SHEET_ONLY: SheetSpec[] = [{ k: 0, x: 0, y: 0, yaw: 0 }];

/** The simulator's wood block: 100 × 100 × 18 mm, its centre at `centreMm` (sheet 0's frame), rotated `angleDeg`
 * counter-clockwise. By default it sits on the table, its centre where the four sheets meet. */
export interface PilotBlock {
  sideMm: number;
  heightMm: number;
  angleDeg: number;
  centreMm: [number, number];
}
export const PILOT_BLOCK: PilotBlock = { sideMm: 100, heightMm: 18, angleDeg: 4, centreMm: [((SHEET.w + 0.006) / 2) * 1000, ((SHEET.h + 0.006) / 2) * 1000] };

/** The block beside sheet 0 (the layout before the table): its nearest point `gapMm` from the sheet's right edge,
 * centred on the sheet's height at `centreYMm`. */
export function blockBeside(gapMm = 15, centreYMm = 0, b: PilotBlock = PILOT_BLOCK): PilotBlock {
  const h = b.sideMm / 2, a = (b.angleDeg * Math.PI) / 180;
  return { ...b, centreMm: [(SHEET.w * 1000) / 2 + gapMm + h * (Math.abs(Math.cos(a)) + Math.abs(Math.sin(a))), centreYMm] };
}

/** The block's centre on the bench (mm, sheet 0's frame). */
export function pilotBlockCentre(b: PilotBlock = PILOT_BLOCK): [number, number] {
  return [b.centreMm[0], b.centreMm[1]];
}

/** The block's top corners (mm, sheet frame), counter-clockwise from its origin corner (the one fitPart calls
 * the origin: its -X, -Y corner in the block's own frame). */
export function pilotBlockCorners(b: PilotBlock = PILOT_BLOCK): V3[] {
  const [cx, cy] = pilotBlockCentre(b);
  const h = b.sideMm / 2, a = (b.angleDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c, b.heightMm]);
}

/** The block as a solid for the renderer (it hides what is behind it, and the video shows it). */
export function pilotBlockSolid(b: PilotBlock = PILOT_BLOCK): SolidSpec {
  const [cx, cy] = pilotBlockCentre(b);
  const h = b.sideMm / 2000, top = b.heightMm / 1000;
  return {
    pose: { p: [cx / 1000, cy / 1000, 0], q: qaxis([0, 0, 1], (b.angleDeg * Math.PI) / 180), s: [1, 1, 1] },
    planes: [[1, 0, 0, h], [-1, 0, 0, h], [0, 1, 0, h], [0, -1, 0, h], [0, 0, 1, top], [0, 0, -1, 0.0005]],
    shade: 176,
  };
}

/** Does the segment from `a` to `b` (world, m) pass through the block? (A marker corner hidden from the camera.) */
export function blockHides(blk: PilotBlock, a: V3, b: V3): boolean {
  const [cx, cy] = pilotBlockCentre(blk);
  const ang = (-blk.angleDeg * Math.PI) / 180, c = Math.cos(ang), s = Math.sin(ang);
  const loc = (p: V3): V3 => {
    const x = p[0] - cx / 1000, y = p[1] - cy / 1000;
    return [c * x - s * y, s * x + c * y, p[2]];
  };
  const p = loc(a), q = loc(b), d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const h = blk.sideMm / 2000, lo = [-h, -h, 0], hi = [h, h, blk.heightMm / 1000];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-15) {
      if (p[i] < lo[i] || p[i] > hi[i]) return false;
      continue;
    }
    let u = (lo[i] - p[i]) / d[i], v = (hi[i] - p[i]) / d[i];
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u);
    t1 = Math.min(t1, v);
    if (t0 > t1) return false;
  }
  // the end on the bench itself touches the block's bottom face when it is under it: that counts as hidden
  return t1 > t0 && t0 < 1 - 1e-9;
}

/** The twist (deg) that turns the docked camera toward `look` (m, on the sheet) while the tip is at `tip` and the
 * bit is square: the camera sees a strip that starts at the tip and runs toward the side the camera is on. */
export function twistToward(core: NavCore, rig: Rig, tip: V3, look: [number, number]): number {
  const bearing = (twist: number) => {
    const p = core.rigPose(0, 0, twist, tip, rig.tool);
    // camera centre in the world: -Rᵀ t
    const R = p.R, t = p.t;
    const c = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2])];
    return Math.atan2(c[1] - tip[1], c[0] - tip[0]);
  };
  const a0 = bearing(0), a90 = bearing(90);
  const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
  const sign = Math.sign(wrap(a90 - a0)) || 1;
  return (wrap(Math.atan2(look[1] - tip[1], look[0] - tip[0]) - a0) * sign * 180) / Math.PI;
}

/** What the simulated camera looks at: the sheets on the bench and the block that may hide some of their markers. */
export interface ViewScene {
  /** default: sheet 0 alone */
  table?: readonly SheetSpec[];
  block?: PilotBlock | null;
}

/** Sheet markers whose four corners fall inside the image (with a margin), each side at least `minPx` long, and
 * none hidden by the block: the markers the camera can read for this pose (a projection, no rendering: fast enough
 * to search with). Every sheet of `scene.table` counts (default: sheet 0 alone). */
export function markersInView(core: NavCore, rig: Rig, pose: Pose, marginPx = 6, minPx = 14, scene: ViewScene = {}): number {
  const table = scene.table ?? SHEET_ONLY, blk = scene.block ?? null;
  const pts: V3[] = [];
  for (const sh of table) {
    const c = Math.cos(sh.yaw), s = Math.sin(sh.yaw);
    for (const id of sheetMarkerIds(sh.k)) for (const p of sheetMarkerCorners(id)!) pts.push([sh.x + c * p.x - s * p.y, sh.y + s * p.x + c * p.y, 0]);
  }
  const px = core.projectPoints(rig.camera, pose, pts);
  // the camera's centre in the world (-Rᵀ t), for the block's shadow
  const R = pose.R, t = pose.t;
  const cam: V3 = [0, 1, 2].map((j) => -(R[j] * t[0] + R[3 + j] * t[1] + R[6 + j] * t[2])) as V3;
  let n = 0;
  for (let i = 0; i < pts.length / 4; i++) {
    const q = px.slice(i * 4, i * 4 + 4);
    if (q.some((p) => !p || p.x < marginPx || p.y < marginPx || p.x > rig.width - marginPx || p.y > rig.height - marginPx)) continue;
    const side = Math.min(...q.map((p, k) => Math.hypot(p!.x - q[(k + 1) % 4]!.x, p!.y - q[(k + 1) % 4]!.y)));
    if (side < minPx) continue;
    if (blk && pts.slice(i * 4, i * 4 + 4).some((w) => blockHides(blk, cam, w))) continue;
    n++;
  }
  return n;
}

/** How a person holds the drill on a point off the sheet (the tip at `tip`, m) so the camera keeps reading the
 * sheet while pivoting ±`pivotDeg`: the smallest lean of the bit (deg, 0..maxLeanDeg, any direction) and the twist that
 * keep at least `want` markers in view over the whole pivot, else the hold with the most. markers: the fewest over
 * the pivot (markersInView). Searched once per point and rig, then cached. */
export function pilotView(core: NavCore, rig: Rig, tip: V3, o: { pivotDeg?: number; want?: number; maxLeanDeg?: number } & ViewScene = {}): { yawDeg: number; pitchDeg: number; twistDeg: number; leanDeg: number; markers: number } {
  const pivotDeg = o.pivotDeg ?? PILOT_PIVOT_DEG, want = o.want ?? 8, maxLean = o.maxLeanDeg ?? 25;
  const scene: ViewScene = { table: o.table, block: o.block };
  const key = `${tip.map((v) => v.toFixed(4))}|${rig.tool.tipCam.map((v) => v.toFixed(5))}|${rig.tool.axisCam.map((v) => v.toFixed(5))}|${pivotDeg}|${want}|${maxLean}|${JSON.stringify(scene)}`;
  const hit = viewCache.get(key);
  if (hit) return hit;
  const cone: [number, number][] = [[0, 0], [pivotDeg, 0], [-pivotDeg, 0], [0, pivotDeg], [0, -pivotDeg]];
  let best = { yawDeg: 0, pitchDeg: 0, twistDeg: 0, leanDeg: 0, markers: -1 };
  for (const lean of [0, 5, 10, 15, 20, 25].filter((l) => l <= maxLean)) {
    for (let d = 0; d < (lean ? 16 : 1); d++) {
      const phi = (d * Math.PI) / 8;
      const yaw = lean * Math.cos(phi), pitch = lean * Math.sin(phi);
      for (let tw = -180; tw < 180; tw += 15) {
        let min = Infinity;
        for (const [dy, dp] of cone) {
          min = Math.min(min, markersInView(core, rig, core.rigPose(yaw + dy, pitch + dp, tw, tip, rig.tool), 6, 14, scene));
          if (min <= best.markers) break;
        }
        if (min > best.markers) best = { yawDeg: yaw, pitchDeg: pitch, twistDeg: tw, leanDeg: lean, markers: min };
      }
    }
    if (best.markers >= want) break;
  }
  viewCache.set(key, best);
  return best;
}
const viewCache = new Map<string, ReturnType<typeof pilotView>>();

/** Where the simulated person looks while hovering over the block: on a table, toward sheet 0's centre; with one
 * sheet, the sheet's centre column of markers at the tip's own height (clamped to the sheet). */
export function pilotLook(tip: V3, table: readonly SheetSpec[] = SHEET_ONLY): [number, number] {
  if (table.length > 1) return [0, 0];
  return [0.02, Math.max(-0.1, Math.min(0.1, tip[1]))];
}

/** What the simulated person does for the app's current pilot phase. */
export interface PilotHoldInput {
  phase: "sheet" | "part" | "work";
  /** corners captured so far (part): the person goes to corner `corners % 4` of the block */
  corners: number;
  /** the screw to drive (work), mm in the sheet's frame (z: the top of the block), or null (hover) */
  screw: { x: number; y: number; z: number; depthMm: number } | null;
  /** default PILOT_BLOCK (on the table) */
  block?: PilotBlock;
  /** the sheets on the bench (default PILOT_TABLE); the person looks at them all in the sheet phase */
  table?: readonly SheetSpec[];
  /** on the corners, how far the person may lean the drill to keep markers in view (deg, default 0: the drill
   * square, only twisted toward the markers) */
  maxLeanDeg?: number;
}

/** The sheet phase on a table: the person holds the drill about 8 cm over the bench and looks at each seam between
 * two sheets in turn (a mapped one and the next), swaying a little, so every sheet is seen together with one already
 * mapped. Stations: tip (m) and the point the camera turns toward. */
const TABLE_SWEEP_S = 3.5;
function tableStations(table: readonly SheetSpec[]): { tip: V3; look: [number, number] }[] {
  const at = (k: number) => table.find((s) => s.k === k);
  const out: { tip: V3; look: [number, number] }[] = [];
  const seam = (a: SheetSpec, b: SheetSpec) => {
    // from a point on sheet a, 4 cm in from its centre toward b, look across the seam
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
    const tip: V3 = [a.x + (dx / l) * 0.04 - (dy / l) * 0.03, a.y + (dy / l) * 0.04 + (dx / l) * 0.03, 0.08];
    out.push({ tip, look: [a.x + dx * 0.8, a.y + dy * 0.8] });
  };
  const s0 = at(0), s1 = at(1), s2 = at(2), s3 = at(3);
  if (s0 && s1) seam(s0, s1);
  if (s0 && s2) seam(s0, s2);
  if (s1 && s3) seam(s1, s3);
  if (s2 && s3) seam(s2, s3);
  return out;
}

// the pilot's timelines, s
const PT = { travel: 1.5, pivot: 3, approach: 2.4, align: 2.2, drill: 3.0, hold: 0.8, retract: 1.6, rest: 1.5 };
/** one screw, start to retracted and resting */
export const PILOT_SCREW_TIME = PT.approach + PT.align + PT.drill + PT.hold + PT.retract + PT.rest;
/** degrees the drill pivots on a corner */
export const PILOT_PIVOT_DEG = 8;

/** The tool's hold for the pilot job, `t` seconds after the current step began (a phase entered, a corner
 * captured, a screw done). sheet: on a table, looking at each seam between two sheets in turn (tableStations), with
 * one sheet hovering over it, swaying a little; part: travel to the next corner (1.5 s), then pivot ±8° on it until
 * it is captured, holding the drill with the lean (none by default) and twist that keep the most markers in view
 * (pilotView, the block hiding what is under and behind it); work: approach, align, drill to the depth, hold, retract and rest above the screw,
 * again and again until it is recorded, square, twisted for the best view of the markers.
 * phase: the simulator's phase, for the disturbances (tremor; motor vibration while drilling). */
export function pilotHold(core: NavCore, rig: Rig, i: PilotHoldInput, t: number): { hold: Hold; phase: Phase } {
  const b = i.block ?? PILOT_BLOCK;
  const table = i.table ?? PILOT_TABLE;
  const scene: ViewScene = { table, block: b };
  const toward = (tip: V3, yawDeg: number, pitchDeg: number, phase: Phase) => ({ hold: { tipWorld: tip, yawDeg, pitchDeg, twistDeg: twistToward(core, rig, tip, pilotLook(tip, table)) }, phase });
  if (i.phase === "sheet") {
    const st = table.length > 1 ? tableStations(table) : [];
    if (!st.length) {
      const tip: V3 = [0.012 * Math.sin(t * 0.7), -0.03 + 0.01 * Math.sin(t * 0.45), 0.05 + 0.01 * Math.sin(t * 0.3)];
      return { hold: { tipWorld: tip, yawDeg: 3 * Math.sin(t * 0.5), pitchDeg: 2 * Math.sin(t * 0.4), twistDeg: 0 }, phase: "approach" };
    }
    // station by station, round and round: 1 s to move to the next, then a slow sway over it
    const n = Math.floor(t / TABLE_SWEEP_S), l = t - n * TABLE_SWEEP_S;
    const from = st[(n + st.length - 1) % st.length], to = st[n % st.length];
    const e = ease(l / 1);
    const sway: V3 = [0.012 * Math.sin(t * 1.3), 0.01 * Math.sin(t * 0.9), 0.012 * Math.sin(t * 0.7)];
    const tip: V3 = [lerp(from.tip[0], to.tip[0], e) + sway[0], lerp(from.tip[1], to.tip[1], e) + sway[1], lerp(from.tip[2], to.tip[2], e) + sway[2]];
    const twA = twistToward(core, rig, from.tip, from.look), twB = twistToward(core, rig, to.tip, to.look);
    const dTw = ((((twB - twA) % 360) + 540) % 360) - 180;
    return { hold: { tipWorld: tip, yawDeg: 4 * Math.sin(t * 0.8), pitchDeg: 3 * Math.sin(t * 0.6), twistDeg: twA + dTw * e }, phase: "approach" };
  }
  if (i.phase === "part") {
    const cs = pilotBlockCorners(b).map((c) => [c[0] / 1000, c[1] / 1000, c[2] / 1000] as V3);
    const k = i.corners % 4;
    const to = cs[k], from = k === 0 ? ([to[0] - 0.03, to[1], to[2] + 0.03] as V3) : cs[k - 1];
    // the person holds the drill so the camera keeps the sheet in view (a lean and a twist), and pivots around that
    const lean = { maxLeanDeg: i.maxLeanDeg ?? 0, ...scene };
    const v = pilotView(core, rig, to, lean), v0 = k === 0 ? { yawDeg: 2, pitchDeg: 2, twistDeg: v.twistDeg } : pilotView(core, rig, from, lean);
    if (t < PT.travel) {
      const e = ease(t / PT.travel);
      const lift = 0.025 * Math.sin(Math.PI * e);
      const dTw = ((((v.twistDeg - v0.twistDeg) % 360) + 540) % 360) - 180;
      return {
        hold: { tipWorld: [lerp(from[0], to[0], e), lerp(from[1], to[1], e), lerp(from[2], to[2], e) + lift], yawDeg: lerp(v0.yawDeg, v.yawDeg, e), pitchDeg: lerp(v0.pitchDeg, v.pitchDeg, e), twistDeg: v0.twistDeg + dTw * e },
        phase: "approach",
      };
    }
    // pivot on the corner: the bit circles a cone of PILOT_PIVOT_DEG around the held lean
    const w = (2 * Math.PI * (t - PT.travel)) / PT.pivot;
    return { hold: { tipWorld: to, yawDeg: v.yawDeg + PILOT_PIVOT_DEG * Math.sin(w), pitchDeg: v.pitchDeg + PILOT_PIVOT_DEG * Math.cos(w), twistDeg: v.twistDeg }, phase: "align" };
  }
  const s = i.screw;
  if (!s) {
    const c = pilotBlockCentre(b);
    return toward([c[0] / 1000, c[1] / 1000, (b.heightMm + 60) / 1000], 2, 2, "approach");
  }
  const top: V3 = [s.x / 1000, s.y / 1000, s.z / 1000];
  // drilling is square: only the twist can turn the camera toward the sheet
  const tw = pilotView(core, rig, top, { pivotDeg: 2, want: 99, maxLeanDeg: 0, ...scene }).twistDeg;
  const at = (tip: V3, yawDeg: number, pitchDeg: number, phase: Phase) => ({ hold: { tipWorld: tip, yawDeg, pitchDeg, twistDeg: tw }, phase });
  let l = t % PILOT_SCREW_TIME;
  // where the person ends up "aligned": inside the tolerance, not perfect
  const endYaw = 0.12, endPitch = -0.08;
  if (l < PT.approach) {
    const k = ease(l / PT.approach);
    return at([top[0] + lerp(0.012, 0, k), top[1] + lerp(-0.008, 0, k), top[2] + lerp(0.045, 0, k)], lerp(6, 2, k), lerp(-4, -1.6, k), "approach");
  }
  l -= PT.approach;
  if (l < PT.align) {
    const k = ease(l / (PT.align * 0.8));
    return at(top, lerp(2, endYaw, k), lerp(-1.6, endPitch, k), "align");
  }
  l -= PT.align;
  // along the bit's actual axis (as truthAt)
  const along = (d: number): V3 => {
    const y = (endYaw * Math.PI) / 180, p = (endPitch * Math.PI) / 180;
    return [top[0] + Math.sin(y) * Math.cos(p) * d, top[1] + Math.sin(p) * d, top[2] - Math.cos(y) * Math.cos(p) * d];
  };
  const depth = s.depthMm / 1000;
  if (l < PT.drill) return at(along(depth * ease(l / PT.drill)), endYaw, endPitch, "drill");
  l -= PT.drill;
  if (l < PT.hold) return at(along(depth), endYaw, endPitch, "hold");
  l -= PT.hold;
  if (l < PT.retract) return at(along(lerp(depth, -0.05, ease(l / PT.retract))), endYaw, endPitch, "retract");
  return at(along(-0.05), endYaw, endPitch, "retract");
}

// ---------------- the browser simulator's clock ----------------

/** The simulated camera's rate (frames per simulated second), as on a phone. */
export const SIM_FPS = 15;
/** How long after its capture a simulated frame reaches the engine (simulated s), as scripts/pilot-sim.mts. */
export const SIM_LATENCY_S = 0.03;
/** The engine's tick (s). */
export const SIM_TICK_S = 1 / 120;
/** At most this much wall time is caught up at once after the clock waited (s). */
const SIM_CATCHUP_S = 0.1;

/** The browser simulator's clock (/hud?sim=1): simulated time, so the scene plays in slow motion but consistently
 * however slowly a frame is rendered and tracked. Frames are captured every 1/fps of simulated time; the clock moves
 * by one engine tick at a time and never past the moment the oldest frame not yet tracked is due at the engine
 * (its capture + latency): it waits for it. It never runs faster than the wall clock either. The capture times, the
 * engine's clock and every timer read from the engine's snapshot (the pilot's steady second, a corner's 1.5 s) are on
 * this clock. Pure: the caller says when a frame was sent and when its result came back.
 *
 *   due()        the capture time of the next frame, when it is time to send it (none in flight); null otherwise
 *   sent(t)      that frame went to the tracker
 *   delivered()  its result came back (pushed to the engine)
 *   run(wall, f) advance as far as allowed, calling f(t) at every tick */
export class SimClock {
  t: number;
  readonly fps: number;
  readonly latency: number;
  readonly tick: number;
  private next: number;
  private inFlight: number | null = null;
  private wall: number | null = null;
  private budget = 0;
  constructor(t0: number, fps = SIM_FPS, latency = SIM_LATENCY_S, tick = SIM_TICK_S) {
    this.t = t0;
    this.next = t0;
    this.fps = fps;
    this.latency = latency;
    this.tick = tick;
  }
  due(): number | null {
    return this.inFlight == null && this.t >= this.next - 1e-9 ? this.next : null;
  }
  sent(tCapture: number) {
    this.inFlight = tCapture;
    this.next = tCapture + 1 / this.fps;
  }
  delivered() {
    this.inFlight = null;
  }
  /** The time the clock may not pass now: the oldest frame not yet tracked (in flight, or still to send) is due. */
  get limit(): number {
    return (this.inFlight ?? this.next) + Math.max(this.latency, this.tick);
  }
  run(wall: number, onTick: (t: number) => void): number {
    this.budget = Math.min(SIM_CATCHUP_S, this.budget + Math.max(0, wall - (this.wall ?? wall)));
    this.wall = wall;
    let n = 0;
    while (this.budget >= this.tick - 1e-9 && this.t + this.tick <= this.limit + 1e-9) {
      this.t += this.tick;
      this.budget -= this.tick;
      onTick(this.t);
      n++;
    }
    return n;
  }
}
