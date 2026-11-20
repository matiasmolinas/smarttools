// TypeScript wrapper for the Rust navigation core (engine/, compiled to public/engine/nav_core.wasm).
// Pose and corner functions give the same results as lib/pose.ts and lib/subpix.ts
// (scripts/engine-parity.mts); the rest (lens model, calibration, navigation, gate, simulator) is
// tested end to end by scripts/scene-test.mts.

import type { Intrinsics, M3, Pose, V3 } from "./pose.ts";
import { fromArray, toArray, type Xf } from "./xform.ts";

type P = { x: number; y: number };

/** Pinhole + Brown-Conrady distortion. */
export interface Camera {
  f: number;
  cx: number;
  cy: number;
  k1: number;
  k2: number;
  p1: number;
  p2: number;
}
export const pinhole = (f: number, cx: number, cy: number): Camera => ({ f, cx, cy, k1: 0, k2: 0, p1: 0, p2: 0 });
export const cameraFromHfov = (w: number, h: number, hfovDeg: number): Camera =>
  pinhole(w / 2 / Math.tan(((hfovDeg / 2) * Math.PI) / 180), w / 2, h / 2);

/** Where the bit is relative to the camera (dock calibration). */
export interface ToolCalib {
  tipCam: V3;
  axisCam: V3;
}

export interface NavState {
  tip: V3;
  axis: V3;
  aim: P;
  yawDeg: number;
  pitchDeg: number;
  angleErrDeg: number;
  offsetMm: number;
  gapMm: number;
  depthMm: number;
}

export interface GateInput {
  calibrated: boolean;
  poseAgeS: number;
  rmsPx: number;
  markers: number;
  angleErrDeg: number;
  offsetMm: number;
  jitterMm: number;
  jitterDeg: number;
}
export interface GateLimits {
  maxAngleDeg: number;
  maxOffsetMm: number;
  maxRmsPx: number;
  minMarkers: number;
  maxPoseAgeS: number;
  maxJitterMm: number;
  maxJitterDeg: number;
}
export const GATE_DEFAULTS: GateLimits = {
  maxAngleDeg: 0.5,
  maxOffsetMm: 1.0,
  maxRmsPx: 1.5,
  minMarkers: 2,
  maxPoseAgeS: 0.15,
  maxJitterMm: 0.4,
  maxJitterDeg: 0.25,
};
export const GATE_REASONS = {
  NOT_CALIBRATED: 1,
  STALE: 2,
  POOR_FIT: 4,
  FEW_MARKERS: 8,
  TILTED: 16,
  OFF_TARGET: 32,
  UNSTEADY: 64,
  NOT_LOCATED: 128,
  KEEP_OUT: 256,
} as const;
export function gateReasonNames(bits: number): string[] {
  return Object.entries(GATE_REASONS)
    .filter(([, b]) => bits & b)
    .map(([k]) => k);
}

export interface RenderOptions {
  width: number;
  height: number;
  /** supersampling per axis */
  ss?: number;
  /** 36 bits per marker id, 1 = white (scene.markerCodes) */
  codes: Uint8Array;
  wall?: number;
  paper?: number;
  ink?: number;
  crosses?: boolean;
  gain?: number;
  vignette?: number;
  gradient?: number;
  noise?: number;
  seed?: number;
  bit?: { tipCam: V3; axisCam: V3; length: number; radius: number } | null;
  occluders?: { cx: number; cy: number; r: number }[];
  /** parts in the scene: convex solids (half-spaces n·x <= d in their own frame) */
  solids?: SolidSpec[];
  /** marker stickers (or printed markers) on parts, in the plane z = 0 of their frame */
  stickers?: StickerSpec[];
}

export interface SolidSpec {
  /** local → world */
  pose: Xf;
  planes: [number, number, number, number][];
  shade: number;
}
export interface StickerSpec {
  pose: Xf;
  /** half size of the paper, m */
  half: [number, number];
  /** marker centre, edge (m) and 36-bit code (first cell = most significant bit) */
  markers: { x: number; y: number; size: number; code: number }[];
}

function encodeScene(solids: SolidSpec[] = [], stickers: StickerSpec[] = []): number[] {
  const v: number[] = [solids.length];
  for (const s of solids) v.push(...s.pose.p, ...s.pose.q, s.shade, s.planes.length, ...s.planes.flat());
  v.push(stickers.length);
  for (const t of stickers) {
    v.push(...t.pose.p, ...t.pose.q, t.half[0], t.half[1], t.markers.length);
    for (const m of t.markers) v.push(m.x, m.y, m.size, m.code);
  }
  return v;
}

export interface PoseFilterHandle {
  step(t: number, tip: V3, axis: V3): { tip: V3; axis: V3 };
  reset(): void;
  free(): void;
}
export interface SteadinessHandle {
  push(t: number, tip: V3, axis: V3): void;
  jitter(): { mm: number; deg: number; span: number };
  reset(): void;
  free(): void;
}

interface Exports {
  memory: WebAssembly.Memory;
  st_abi_version(): number;
  st_alloc(bytes: number): number;
  st_free(ptr: number, bytes: number): void;
  st_homography(world: number, img: number, n: number, out: number): number;
  st_pose_from_homography(h: number, f: number, cx: number, cy: number, out: number): number;
  st_refine_pose(pose: number, world: number, img: number, n: number, f: number, cx: number, cy: number, iters: number, out: number): number;
  st_solve_pose(world: number, img: number, n: number, f: number, cx: number, cy: number, out: number): number;
  st_focal_from_homography(h: number, cx: number, cy: number): number;
  st_refine_corners(rgba: number, width: number, height: number, corners: number, out: number): number;
  st_undistort_points(cam: number, pts: number, n: number, out: number): number;
  st_project_points(cam: number, pose: number, world: number, n: number, out: number): number;
  st_calibrate_camera(init: number, nViews: number, counts: number, world: number, img: number, flags: number, outCam: number, outRms: number): number;
  st_pivot(poses: number, n: number, out: number): number;
  st_axis_from_roll(poses: number, n: number, out: number): number;
  st_nav_evaluate(pose: number, tool: number, target: number, out: number): number;
  st_nav_evaluate_world(tip: number, axis: number, target: number, out: number): number;
  st_gate(input: number, limits: number): number;
  st_filter_new(tipMin: number, tipBeta: number, axisMin: number, axisBeta: number, dCut: number): number;
  st_filter_step(h: number, t: number, tip: number, axis: number, out: number): void;
  st_filter_reset(h: number): void;
  st_filter_free(h: number): void;
  st_steady_new(window: number): number;
  st_steady_push(h: number, t: number, tip: number, axis: number): void;
  st_steady_jitter(h: number, out: number): void;
  st_steady_reset(h: number): void;
  st_steady_free(h: number): void;
  st_rig_pose(yaw: number, pitch: number, twist: number, tipWorld: number, tipCam: number, axisCam: number, out: number): number;
  st_render(cam: number, poses: number, n: number, w: number, h: number, ss: number, codes: number, cfg: number, out: number): number;
  st_render_scene(cam: number, poses: number, n: number, w: number, h: number, ss: number, codes: number, cfg: number, scene: number, sceneLen: number, out: number): number;
  st_refine_pose3(pose: number, world: number, img: number, n: number, f: number, cx: number, cy: number, iters: number, out: number): number;
  st_engine_set_movable(h: number, node: number, on: number): void;
  st_engine_set_feed_limit(h: number, mmS: number): void;
  st_engine_add_keepout(h: number, node: number, hx: number, hy: number, hz: number, marginMm: number): void;
  st_board_info(out: number, cap: number): number;
  st_engine_new(): number;
  st_engine_free(h: number): void;
  st_engine_configure(h: number, c: number): number;
  st_engine_add_node(h: number, name: number, len: number, parent: number, kind: number, local: number): number;
  st_engine_set_local(h: number, node: number, local: number): number;
  st_engine_reparent(h: number, node: number, parent: number, keep: number): number;
  st_engine_set_calibrated(h: number, node: number, ok: number): void;
  st_engine_set_nav(h: number, tool: number, targets: number, n: number): void;
  st_engine_start(h: number, t0: number): void;
  st_engine_reset_job(h: number): void;
  st_engine_push(h: number, from: number, to: number, t: number, tCapture: number, markers: number, rms: number): void;
  st_engine_advance(h: number, tWall: number): number;
  st_engine_now(h: number): number;
  st_engine_snapshot(h: number, out: number, cap: number): number;
  st_engine_set_target_depths(h: number, depths: number, n: number): void;
  st_register_points(model: number, measured: number, n: number, out: number): number;
  st_solve_pose_robust(world: number, img: number, n: number, f: number, cx: number, cy: number, minPx: number, out: number, keep: number): number;
}

export const ENGINE_ABI = 5;

// ---------------- engine (scene graph + clock) ----------------

export type NodeKindName = "reference" | "tracked" | "calibrated" | "planned" | "derived" | "display";
export const NODE_KINDS: NodeKindName[] = ["reference", "tracked", "calibrated", "planned", "derived", "display"];
export type NodeStatus = "static" | "valid" | "predicted" | "stale" | "lost" | "uncalibrated";
export const NODE_STATUS: NodeStatus[] = ["static", "valid", "predicted", "stale", "lost", "uncalibrated"];
export type EnginePhase = "approach" | "align" | "drill" | "hold" | "retract";
export const ENGINE_PHASES: EnginePhase[] = ["approach", "align", "drill", "hold", "retract"];
export const EVENT_KINDS = ["", "target", "ready", "not-ready", "depth-reached", "drilled", "lost", "found", "angle-alarm", "overrun", "job-reset", "part-located", "part-moved", "gesture-tap", "gesture-twist", "keep-out", "feed-fast", "stalled"] as const;
export type EngineEventKind = (typeof EVENT_KINDS)[number];
export const ALARMS = { DEPTH: 1, ANGLE: 2, LOST: 4, PART_MOVED: 8, KEEP_OUT: 16 } as const;

export interface EngineConfig {
  tickHz: number;
  maxCatchup: number;
  predictMaxS: number;
  predict: boolean;
  staleAfterS: number;
  lostAfterS: number;
  historyS: number;
  lockTimeS: number;
  steadyWindowS: number;
  depthTargetMm: number;
  engageGapMm: number;
  engageOffsetMm: number;
  requirementAngleDeg: number;
  limits: GateLimits;
  posMinCutoff: number;
  posBeta: number;
  rotMinCutoff: number;
  rotBeta: number;
  dCutoff: number;
}
export const ENGINE_DEFAULTS: EngineConfig = {
  tickHz: 120,
  maxCatchup: 4,
  predictMaxS: 0.12,
  predict: true,
  staleAfterS: 0.25,
  lostAfterS: 0.6,
  historyS: 0.25,
  lockTimeS: 0.4,
  steadyWindowS: 0.5,
  depthTargetMm: 35,
  engageGapMm: 3,
  engageOffsetMm: 6,
  requirementAngleDeg: 0.5,
  limits: { maxAngleDeg: 0.4, maxOffsetMm: 0.75, maxRmsPx: 1.5, minMarkers: 2, maxPoseAgeS: 0.25, maxJitterMm: 0.4, maxJitterDeg: 0.25 },
  posMinCutoff: 2,
  posBeta: 3000,
  rotMinCutoff: 2,
  rotBeta: 300,
  dCutoff: 1,
};

export interface TargetNav {
  id: number;
  drilled: boolean;
  /** tip and bit axis in the target frame (+Z = planned drilling direction) */
  tip: V3;
  axis: V3;
  aim: [number, number];
  yawDeg: number;
  pitchDeg: number;
  angleErrDeg: number;
  offsetMm: number;
  gapMm: number;
  depthMm: number;
}
export interface EngineEvent {
  tick: number;
  t: number;
  kind: EngineEventKind;
  node: number;
  value: number;
}
export interface EngineSnapshot {
  tick: number;
  t: number;
  nodes: { id: number; status: NodeStatus; age: number; world: Xf }[];
  targets: TargetNav[];
  /** index into targets, or -1 */
  active: number;
  phase: EnginePhase;
  gate: number;
  ready: boolean;
  locking: boolean;
  alarms: number;
  jitterMm: number;
  jitterDeg: number;
  markers: number;
  rmsPx: number;
  poseAgeS: number;
  events: EngineEvent[];
  stats: { ticks: number; overruns: number; measurements: number; lateMerged: number; lateDropped: number; latencyS: number };
}

export interface NavEngine {
  readonly handle: number;
  configure(c: Partial<EngineConfig>): void;
  addNode(name: string, parent: number, kind: NodeKindName, local: Xf): number;
  setLocal(node: number, local: Xf): void;
  reparent(node: number, parent: number, keepWorld?: boolean): void;
  setCalibrated(node: number, ok: boolean): void;
  setNavigation(tool: number, targets: number[]): void;
  /** depth to reach per target (mm), in setNavigation's order */
  setTargetDepths(depths: number[]): void;
  /** a part that moves: measurements against markers on it (calibrated nodes under it) update it, and locate it */
  setMovable(node: number, on: boolean): void;
  /** a no-go zone: a box (half sizes, m) in a node's frame, kept clear by a margin (mm) */
  addKeepout(node: number, half: V3, marginMm: number): void;
  /** feed above which drilling is "pushing too hard" (mm/s, default 12) */
  setFeedLimit(mmS: number): void;
  start(t0: number): void;
  resetJob(): void;
  /** a relation T_from_to seen by a tracker at tCapture */
  push(from: number, to: number, t: Xf, tCapture: number, markers: number, rmsPx: number): void;
  /** run the ticks due up to tWall; returns how many ran */
  advance(tWall: number): number;
  now(): number;
  /** latest snapshot; its events are handed over once */
  snapshot(): EngineSnapshot;
  free(): void;
}

const SCENE_ERR: Record<number, string> = { [-1]: "bad arguments", [-2]: "unknown node", [-3]: "name taken", [-4]: "cycle", [-5]: "scale on a rigid node", [-6]: "the root is fixed" };
export const ENGINE_URL = "/engine/nav_core.wasm";

export class NavCore {
  private x: Exports;
  private constructor(x: Exports) {
    this.x = x;
  }

  /** Load from a URL (browser) or from the .wasm bytes (Node, tests). */
  static async load(source: string | BufferSource = ENGINE_URL): Promise<NavCore> {
    const { instance } =
      typeof source === "string"
        ? await WebAssembly.instantiateStreaming(fetch(source), {})
        : await WebAssembly.instantiate(source, {});
    const x = instance.exports as unknown as Exports;
    const abi = x.st_abi_version();
    if (abi !== ENGINE_ABI) throw new Error(`nav_core ABI ${abi}, expected ${ENGINE_ABI}`);
    return new NavCore(x);
  }

  // ---- linear-memory helpers: allocate, run, always free ----
  private with<T>(sizes: number[], run: (ptrs: number[]) => T): T {
    const ptrs = sizes.map((b) => this.x.st_alloc(b));
    try {
      return run(ptrs);
    } finally {
      ptrs.forEach((p, i) => this.x.st_free(p, sizes[i]));
    }
  }
  private f64(ptr: number, len: number) {
    return new Float64Array(this.x.memory.buffer, ptr, len); // re-create after any alloc (memory may grow)
  }
  private putPts(ptr: number, pts: P[]) {
    const a = this.f64(ptr, pts.length * 2);
    pts.forEach((p, i) => {
      a[i * 2] = p.x;
      a[i * 2 + 1] = p.y;
    });
  }
  private getPose(ptr: number): Pose {
    const a = this.f64(ptr, 13);
    return { R: Array.from(a.subarray(0, 9)) as M3, t: [a[9], a[10], a[11]], rms: a[12] };
  }
  private putPose(ptr: number, p: Pose) {
    const a = this.f64(ptr, 13);
    a.set(p.R, 0);
    a.set(p.t, 9);
    a[12] = p.rms;
  }

  homography(world: P[], img: P[]): M3 | null {
    const n = world.length;
    if (n < 4 || img.length !== n) return null;
    return this.with([n * 16, n * 16, 72], ([w, i, o]) => {
      this.putPts(w, world);
      this.putPts(i, img);
      return this.x.st_homography(w, i, n, o) === 1 ? (Array.from(this.f64(o, 9)) as M3) : null;
    });
  }

  poseFromHomography(H: M3, K: Intrinsics): Pose | null {
    return this.with([72, 104], ([h, o]) => {
      this.f64(h, 9).set(H);
      return this.x.st_pose_from_homography(h, K.f, K.cx, K.cy, o) === 1 ? this.getPose(o) : null;
    });
  }

  refinePose(pose: Pose, world: P[], img: P[], K: Intrinsics, iters = 8): Pose {
    const n = world.length;
    return this.with([104, n * 16, n * 16], ([p, w, i]) => {
      this.putPose(p, pose);
      this.putPts(w, world);
      this.putPts(i, img);
      this.x.st_refine_pose(p, w, i, n, K.f, K.cx, K.cy, iters, p);
      return this.getPose(p);
    });
  }

  /** Gauss-Newton on 3D points (markers on several faces of a part). */
  refinePose3(pose: Pose, world: V3[], img: P[], K: Intrinsics, iters = 10): Pose {
    const n = world.length;
    return this.with([104, n * 24, n * 16], ([p, w, i]) => {
      this.putPose(p, pose);
      this.f64(w, n * 3).set(world.flat());
      this.putPts(i, img);
      this.x.st_refine_pose3(p, w, i, n, K.f, K.cx, K.cy, iters, p);
      return this.getPose(p);
    });
  }

  /** homography + decomposition + Gauss-Newton, the per-frame solve */
  solvePose(world: P[], img: P[], K: Intrinsics): Pose | null {
    const n = world.length;
    if (n < 4 || img.length !== n) return null;
    return this.with([n * 16, n * 16, 104], ([w, i, o]) => {
      this.putPts(w, world);
      this.putPts(i, img);
      return this.x.st_solve_pose(w, i, n, K.f, K.cx, K.cy, o) === 1 ? this.getPose(o) : null;
    });
  }

  /** Per-frame solve that drops markers (4 points each) inconsistent with the rest (e.g. half hidden by the bit). */
  solvePoseRobust(world: P[], img: P[], K: Intrinsics, minPx = 0.8): { pose: Pose; kept: number; keep: boolean[] } | null {
    const n = world.length;
    if (n < 4 || img.length !== n || n % 4) return null;
    return this.with([n * 16, n * 16, 104, n / 4], ([w, i, o, k]) => {
      this.putPts(w, world);
      this.putPts(i, img);
      const kept = this.x.st_solve_pose_robust(w, i, n, K.f, K.cx, K.cy, minPx, o, k);
      if (kept <= 0) return null;
      const keep = Array.from(new Uint8Array(this.x.memory.buffer, k, n / 4), (v) => v === 1);
      return { pose: this.getPose(o), kept, keep };
    });
  }

  focalFromHomography(H: M3, cx: number, cy: number): number | null {
    return this.with([72], ([h]) => {
      this.f64(h, 9).set(H);
      const f = this.x.st_focal_from_homography(h, cx, cy);
      return Number.isNaN(f) ? null : f;
    });
  }

  /** Sub-pixel corners of one marker; returns the input corners when refinement is rejected. */
  refineCorners(img: { width: number; height: number; data: Uint8ClampedArray }, corners: P[]): P[] {
    const bytes = img.width * img.height * 4;
    return this.with([bytes, 64, 64], ([d, c, o]) => {
      new Uint8Array(this.x.memory.buffer, d, bytes).set(img.data);
      this.putPts(c, corners);
      if (this.x.st_refine_corners(d, img.width, img.height, c, o) !== 1) return corners;
      const a = this.f64(o, 8);
      return [0, 1, 2, 3].map((k) => ({ x: a[k * 2], y: a[k * 2 + 1] }));
    });
  }

  // ---- staged image: copy a frame into WASM memory once, refine every marker on it ----
  private img = { ptr: 0, bytes: 0 };
  private stage(img: { width: number; height: number; data: Uint8ClampedArray }) {
    const bytes = img.width * img.height * 4;
    if (bytes > this.img.bytes) {
      if (this.img.ptr) this.x.st_free(this.img.ptr, this.img.bytes);
      this.img = { ptr: this.x.st_alloc(bytes), bytes };
    }
    new Uint8Array(this.x.memory.buffer, this.img.ptr, bytes).set(img.data);
  }
  /** Sub-pixel corners of several markers on one frame (one copy of the image). */
  refineMany(img: { width: number; height: number; data: Uint8ClampedArray }, quads: P[][]): P[][] {
    this.stage(img);
    return this.with([64, 64], ([c, o]) =>
      quads.map((q) => {
        this.putPts(c, q);
        if (this.x.st_refine_corners(this.img.ptr, img.width, img.height, c, o) !== 1) return q;
        const a = this.f64(o, 8);
        return [0, 1, 2, 3].map((k) => ({ x: a[k * 2], y: a[k * 2 + 1] }));
      }),
    );
  }

  // ---- lens model ----
  private putCam(ptr: number, c: Camera) {
    this.f64(ptr, 7).set([c.f, c.cx, c.cy, c.k1, c.k2, c.p1, c.p2]);
  }
  private putV3(ptr: number, v: V3) {
    this.f64(ptr, 3).set(v);
  }
  undistortPoints(cam: Camera, pts: P[]): P[] {
    const n = pts.length;
    if (!n) return [];
    return this.with([56, n * 16], ([c, p]) => {
      this.putCam(c, cam);
      this.putPts(p, pts);
      this.x.st_undistort_points(c, p, n, p);
      const a = this.f64(p, n * 2);
      return pts.map((_, i) => ({ x: a[i * 2], y: a[i * 2 + 1] }));
    });
  }
  /** World points -> pixels with distortion (null behind the camera). */
  projectPoints(cam: Camera, pose: Pose, world: V3[]): (P | null)[] {
    const n = world.length;
    if (!n) return [];
    return this.with([56, 104, n * 24, n * 16], ([c, ps, w, o]) => {
      this.putCam(c, cam);
      this.putPose(ps, pose);
      this.f64(w, n * 3).set(world.flat());
      this.x.st_project_points(c, ps, w, n, o);
      const a = this.f64(o, n * 2);
      return world.map((_, i) => (Number.isNaN(a[i * 2]) ? null : { x: a[i * 2], y: a[i * 2 + 1] }));
    });
  }

  // ---- calibration ----
  calibrateCamera(views: { world: P[]; img: P[] }[], init: Camera, opts: { fixPrincipalPoint?: boolean; k1Only?: boolean } = {}): { camera: Camera; rms: number } | null {
    const n = views.reduce((s, v) => s + v.world.length, 0);
    return this.with([56, views.length * 4, n * 16, n * 16, 56, 8], ([ci, cnt, w, im, oc, orms]) => {
      this.putCam(ci, init);
      new Uint32Array(this.x.memory.buffer, cnt, views.length).set(views.map((v) => v.world.length));
      this.putPts(w, views.flatMap((v) => v.world));
      this.putPts(im, views.flatMap((v) => v.img));
      const flags = (opts.fixPrincipalPoint ? 1 : 0) | (opts.k1Only ? 2 : 0);
      if (this.x.st_calibrate_camera(ci, views.length, cnt, w, im, flags, oc, orms) !== 1) return null;
      const a = this.f64(oc, 7);
      return { camera: { f: a[0], cx: a[1], cy: a[2], k1: a[3], k2: a[4], p1: a[5], p2: a[6] }, rms: this.f64(orms, 1)[0] };
    });
  }
  private putPoses(ptr: number, poses: Pose[]) {
    poses.forEach((p, i) => this.putPose(ptr + i * 104, p));
  }
  /** Tip in the camera frame from a wobble around a fixed point. */
  pivot(poses: Pose[]): { tipCam: V3; pivotWorld: V3; rmsM: number; spreadDeg: number } | null {
    return this.with([Math.max(1, poses.length) * 104, 64], ([ps, o]) => {
      this.putPoses(ps, poses);
      if (this.x.st_pivot(ps, poses.length, o) !== 1) return null;
      const a = this.f64(o, 8);
      return { tipCam: [a[0], a[1], a[2]], pivotWorld: [a[3], a[4], a[5]], rmsM: a[6], spreadDeg: a[7] };
    });
  }
  /** Bit axis in the camera frame from a twist around the bit. */
  axisFromRoll(poses: Pose[]): { axisCam: V3; spreadDeg: number; rms: number } | null {
    return this.with([Math.max(1, poses.length) * 104, 40], ([ps, o]) => {
      this.putPoses(ps, poses);
      if (this.x.st_axis_from_roll(ps, poses.length, o) !== 1) return null;
      const a = this.f64(o, 5);
      return { axisCam: [a[0], a[1], a[2]], spreadDeg: a[3], rms: a[4] };
    });
  }

  // ---- navigation ----
  private getNav(ptr: number): NavState {
    const a = this.f64(ptr, 14);
    return {
      tip: [a[0], a[1], a[2]],
      axis: [a[3], a[4], a[5]],
      aim: { x: a[6], y: a[7] },
      yawDeg: a[8],
      pitchDeg: a[9],
      angleErrDeg: a[10],
      offsetMm: a[11],
      gapMm: a[12],
      depthMm: a[13],
    };
  }
  navEvaluate(pose: Pose, tool: ToolCalib, target: P): NavState {
    return this.with([104, 48, 16, 112], ([ps, tl, tg, o]) => {
      this.putPose(ps, pose);
      this.f64(tl, 6).set([...tool.tipCam, ...tool.axisCam]);
      this.f64(tg, 2).set([target.x, target.y]);
      this.x.st_nav_evaluate(ps, tl, tg, o);
      return this.getNav(o);
    });
  }
  navEvaluateWorld(tip: V3, axis: V3, target: P): NavState {
    return this.with([24, 24, 16, 112], ([t, a, tg, o]) => {
      this.putV3(t, tip);
      this.putV3(a, axis);
      this.f64(tg, 2).set([target.x, target.y]);
      this.x.st_nav_evaluate_world(t, a, tg, o);
      return this.getNav(o);
    });
  }
  /** Go / no-go: 0 = ready, otherwise GATE_REASONS bits. */
  gate(i: GateInput, l: GateLimits = GATE_DEFAULTS): number {
    return this.with([64, 56], ([pi, pl]) => {
      this.f64(pi, 8).set([i.calibrated ? 1 : 0, i.poseAgeS, i.rmsPx, i.markers, i.angleErrDeg, i.offsetMm, i.jitterMm, i.jitterDeg]);
      this.f64(pl, 7).set([l.maxAngleDeg, l.maxOffsetMm, l.maxRmsPx, l.minMarkers, l.maxPoseAgeS, l.maxJitterMm, l.maxJitterDeg]);
      return this.x.st_gate(pi, pl) >>> 0;
    });
  }
  /** One Euro filter on tip (m) and axis; defaults tuned with the scene simulator. */
  createFilter(p = { tipMinCutoff: 2, tipBeta: 3000, axisMinCutoff: 2, axisBeta: 300, dCutoff: 1 }): PoseFilterHandle {
    const h = this.x.st_filter_new(p.tipMinCutoff, p.tipBeta, p.axisMinCutoff, p.axisBeta, p.dCutoff);
    return {
      step: (t, tip, axis) =>
        this.with([24, 24, 48], ([a, b, o]) => {
          this.putV3(a, tip);
          this.putV3(b, axis);
          this.x.st_filter_step(h, t, a, b, o);
          const r = this.f64(o, 6);
          return { tip: [r[0], r[1], r[2]] as V3, axis: [r[3], r[4], r[5]] as V3 };
        }),
      reset: () => this.x.st_filter_reset(h),
      free: () => this.x.st_filter_free(h),
    };
  }
  createSteadiness(windowS = 0.3): SteadinessHandle {
    const h = this.x.st_steady_new(windowS);
    return {
      push: (t, tip, axis) =>
        this.with([24, 24], ([a, b]) => {
          this.putV3(a, tip);
          this.putV3(b, axis);
          this.x.st_steady_push(h, t, a, b);
        }),
      jitter: () =>
        this.with([24], ([o]) => {
          this.x.st_steady_jitter(h, o);
          const r = this.f64(o, 3);
          return { mm: r[0], deg: r[1], span: r[2] };
        }),
      reset: () => this.x.st_steady_reset(h),
      free: () => this.x.st_steady_free(h),
    };
  }

  // ---- simulator ----
  /** Camera pose of the docked phone for a tool held at yaw/pitch/twist (deg) with its tip at tipWorld. */
  rigPose(yawDeg: number, pitchDeg: number, twistDeg: number, tipWorld: V3, tool: ToolCalib): Pose {
    return this.with([24, 24, 24, 104], ([tw, tc, ac, o]) => {
      this.putV3(tw, tipWorld);
      this.putV3(tc, tool.tipCam);
      this.putV3(ac, tool.axisCam);
      this.x.st_rig_pose(yawDeg, pitchDeg, twistDeg, tw, tc, ac, o);
      return this.getPose(o);
    });
  }
  /** Render a simulated camera frame (RGBA). Several poses = motion blur over the exposure. */
  render(cam: Camera, poses: Pose[], o: RenderOptions): Uint8ClampedArray {
    const bytes = o.width * o.height * 4;
    const scene = encodeScene(o.solids, o.stickers);
    return this.with([56, poses.length * 104, o.codes.length, 512, scene.length * 8, bytes], ([c, ps, cd, cfg, sc, out]) => {
      this.f64(sc, scene.length).set(scene);
      this.putCam(c, cam);
      this.putPoses(ps, poses);
      new Uint8Array(this.x.memory.buffer, cd, o.codes.length).set(o.codes);
      const occ = (o.occluders ?? []).slice(0, 14);
      const b = o.bit;
      const v = new Array(64).fill(0);
      v.splice(0, 19, o.wall ?? 150, o.paper ?? 232, o.ink ?? 22, o.crosses === false ? 0 : 1, o.gain ?? 1, o.vignette ?? 0.25, o.gradient ?? 0.15, o.noise ?? 3, o.seed ?? 1,
        b ? 1 : 0, ...(b ? b.tipCam : [0, 0, 0]), ...(b ? b.axisCam : [0, 0, 1]), b?.length ?? 0, b?.radius ?? 0, occ.length);
      occ.forEach((q, i) => v.splice(19 + i * 3, 3, q.cx, q.cy, q.r));
      this.f64(cfg, 64).set(v);
      const r = this.x.st_render_scene(c, ps, poses.length, o.width, o.height, o.ss ?? 2, cd, cfg, sc, scene.length, out);
      if (r !== 1) throw new Error(`render failed (${r})`);
      return new Uint8ClampedArray(this.x.memory.buffer.slice(out, out + bytes));
    });
  }

  /** Board geometry compiled into the core (for parity with lib/board.ts). */
  boardInfo(): { markerSize: number; markers: P[]; targets: P[] } {
    return this.with([8 * 256], ([o]) => {
      const n = this.x.st_board_info(o, 256);
      if (n < 0) throw new Error("board info buffer too small");
      const a = this.f64(o, n);
      const count = a[0];
      const pts = (from: number, k: number) => Array.from({ length: k }, (_, i) => ({ x: a[from + i * 2], y: a[from + i * 2 + 1] }));
      return { markerSize: a[1], markers: pts(2, count), targets: pts(2 + count * 2, (n - 2 - count * 2) / 2) };
    });
  }

  /** Paired-point registration: the pose that maps `model` points onto `measured` ones (Horn).
   * FRE = RMS residual, in mm. Null for fewer than 3 points or a collinear set. */
  registerPoints(model: V3[], measured: V3[]): { transform: Xf; freMm: number; maxMm: number } | null {
    const n = model.length;
    if (n < 3 || measured.length !== n) return null;
    return this.with([n * 24, n * 24, 96], ([m, d, o]) => {
      this.f64(m, n * 3).set(model.flat());
      this.f64(d, n * 3).set(measured.flat());
      if (this.x.st_register_points(m, d, n, o) !== 1) return null;
      const a = this.f64(o, 12);
      return { transform: fromArray(a, 0), freMm: a[10] * 1000, maxMm: a[11] * 1000 };
    });
  }

  /** A navigation engine (scene graph + clock + checks), see docs/ENGINE_SPEC.md. */
  createEngine(): NavEngine {
    const x = this.x;
    const h = x.st_engine_new();
    let snapCap = 4096;
    let snapPtr = x.st_alloc(snapCap * 8);
    const xfIn = (ptr: number, t: Xf) => this.f64(ptr, 10).set(toArray(t));
    const check = (r: number, what: string) => {
      if (r < 0) throw new Error(`${what}: ${SCENE_ERR[r] ?? r}`);
      return r;
    };
    return {
      handle: h,
      configure: (c) => {
        const k = { ...ENGINE_DEFAULTS, ...c, limits: { ...ENGINE_DEFAULTS.limits, ...(c.limits ?? {}) } };
        const l = k.limits;
        this.with([26 * 8], ([p]) => {
          this.f64(p, 26).set([k.tickHz, k.maxCatchup, k.predictMaxS, k.predict ? 1 : 0, k.staleAfterS, k.lostAfterS, k.historyS, k.lockTimeS, k.steadyWindowS, k.depthTargetMm, k.engageGapMm, k.engageOffsetMm, k.requirementAngleDeg, l.maxAngleDeg, l.maxOffsetMm, l.maxRmsPx, l.minMarkers, l.maxPoseAgeS, l.maxJitterMm, l.maxJitterDeg, k.posMinCutoff, k.posBeta, k.rotMinCutoff, k.rotBeta, k.dCutoff, 0]);
          x.st_engine_configure(h, p);
        });
      },
      addNode: (name, parent, kind, local) => {
        const bytes = new TextEncoder().encode(name);
        return this.with([Math.max(1, bytes.length), 80], ([n, l]) => {
          new Uint8Array(x.memory.buffer, n, bytes.length).set(bytes);
          xfIn(l, local);
          return check(x.st_engine_add_node(h, n, bytes.length, parent, NODE_KINDS.indexOf(kind), l), `add node "${name}"`);
        });
      },
      setLocal: (node, local) =>
        this.with([80], ([l]) => {
          xfIn(l, local);
          check(x.st_engine_set_local(h, node, l), `set local of node ${node}`);
        }),
      reparent: (node, parent, keep = true) => {
        check(x.st_engine_reparent(h, node, parent, keep ? 1 : 0), `reparent node ${node}`);
      },
      setCalibrated: (node, ok) => x.st_engine_set_calibrated(h, node, ok ? 1 : 0),
      setNavigation: (tool, targets) =>
        this.with([Math.max(4, targets.length * 4)], ([p]) => {
          new Uint32Array(x.memory.buffer, p, targets.length).set(targets);
          x.st_engine_set_nav(h, tool, p, targets.length);
        }),
      setTargetDepths: (depths) =>
        this.with([Math.max(8, depths.length * 8)], ([p]) => {
          this.f64(p, depths.length).set(depths);
          x.st_engine_set_target_depths(h, p, depths.length);
        }),
      setMovable: (node, on) => x.st_engine_set_movable(h, node, on ? 1 : 0),
      setFeedLimit: (v) => x.st_engine_set_feed_limit(h, v),
      addKeepout: (node, half, m) => x.st_engine_add_keepout(h, node, half[0], half[1], half[2], m),
      start: (t0) => x.st_engine_start(h, t0),
      resetJob: () => x.st_engine_reset_job(h),
      push: (from, to, t, tc, markers, rms) =>
        this.with([80], ([p]) => {
          xfIn(p, t);
          x.st_engine_push(h, from, to, p, tc, markers, rms);
        }),
      advance: (tw) => x.st_engine_advance(h, tw),
      now: () => x.st_engine_now(h),
      snapshot: () => {
        let n = x.st_engine_snapshot(h, snapPtr, snapCap);
        if (n < 0) {
          x.st_free(snapPtr, snapCap * 8);
          snapCap = -n * 2;
          snapPtr = x.st_alloc(snapCap * 8);
          n = x.st_engine_snapshot(h, snapPtr, snapCap);
        }
        return parseSnapshot(this.f64(snapPtr, n));
      },
      free: () => {
        x.st_free(snapPtr, snapCap * 8);
        x.st_engine_free(h);
      },
    };
  }
}

function parseSnapshot(a: Float64Array): EngineSnapshot {
  const H = 24, N = 13, T = 16, E = 5;
  const nNodes = a[2], nTargets = a[3], nEvents = a[15];
  const nodes: EngineSnapshot["nodes"] = [];
  let k = H;
  for (let i = 0; i < nNodes; i++, k += N) nodes.push({ id: a[k], status: NODE_STATUS[a[k + 1]] ?? "lost", age: a[k + 2], world: fromArray(a, k + 3) });
  const targets: TargetNav[] = [];
  for (let i = 0; i < nTargets; i++, k += T)
    targets.push({
      id: a[k],
      drilled: a[k + 1] === 1,
      tip: [a[k + 2], a[k + 3], a[k + 4]],
      axis: [a[k + 5], a[k + 6], a[k + 7]],
      aim: [a[k + 8], a[k + 9]],
      yawDeg: a[k + 10],
      pitchDeg: a[k + 11],
      angleErrDeg: a[k + 12],
      offsetMm: a[k + 13],
      gapMm: a[k + 14],
      depthMm: a[k + 15],
    });
  const events: EngineEvent[] = [];
  for (let i = 0; i < nEvents; i++, k += E) events.push({ tick: a[k], t: a[k + 1], kind: EVENT_KINDS[a[k + 2]] ?? "", node: a[k + 3], value: a[k + 4] });
  return {
    tick: a[0],
    t: a[1],
    nodes,
    targets,
    active: a[4],
    phase: ENGINE_PHASES[a[5]] ?? "approach",
    gate: a[6],
    ready: a[7] === 1,
    locking: a[8] === 1,
    alarms: a[9],
    jitterMm: a[10],
    jitterDeg: a[11],
    markers: a[12],
    rmsPx: a[13],
    poseAgeS: a[14],
    events,
    stats: { ticks: a[16], overruns: a[17], measurements: a[18], lateMerged: a[19], lateDropped: a[20], latencyS: a[21] },
  };
}
