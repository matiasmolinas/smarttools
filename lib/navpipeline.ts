// The navigation pipeline, the same in the phone (lib/tracker.ts) and in the tests
// (scripts/scene-test.mts, /lab): frame -> markers -> sub-pixel corners -> undistort -> pose ->
// tip & axis -> filter -> navigation -> steadiness -> go / no-go gate -> phase.
// No DOM: it takes RGBA frames, so the simulator can feed it exactly what a camera would.

import { BOARD_TARGETS, markerCorners } from "./board.ts";
import { DEPTH_TARGET_MM } from "./sim.ts";
import type { Camera, GateLimits, NavCore, NavState, PoseFilterHandle, SteadinessHandle, ToolCalib } from "./engine.ts";
import { GATE_DEFAULTS, GATE_REASONS } from "./engine.ts";
import type { Pose, V3 } from "./pose.ts";

type P = { x: number; y: number };
export type Rgba = { width: number; height: number; data: Uint8ClampedArray };
export interface Detector {
  detect(img: Rgba): { id: number; corners: P[] }[];
}
export type NavPhase = "approach" | "align" | "drill" | "hold" | "retract";
export type CaptureKind = "camera" | "pivot" | "roll";

export interface PipelineOptions {
  /** intrinsics in the pixel space of the frames given to process() */
  camera: Camera;
  /** false: estimate the focal length from tilted views (median of 30, then frozen) */
  cameraCalibrated: boolean;
  tool: ToolCalib;
  toolCalibrated: boolean;
  /** the gate limits: stricter than the requirement (0.5°, 1 mm) by the measured error margin */
  limits?: GateLimits;
  filter?: boolean;
}

/** Requirement the user is promised; the gate uses a margin inside it. */
export const REQUIREMENT = { angleDeg: 0.5, offsetMm: 1.0 };
export const PIPELINE_LIMITS: GateLimits = { ...GATE_DEFAULTS, maxAngleDeg: 0.4, maxOffsetMm: 0.75 };

export interface PipelineResult {
  t: number;
  markers: number;
  quads: P[][];
  pose: Pose | null;
  fresh: boolean;
  rmsPx: number;
  focalPx: number;
  focalLocked: boolean;
  raw: NavState | null;
  nav: NavState | null;
  jitter: { mm: number; deg: number };
  gate: number;
  ready: boolean;
  targetIndex: number;
  phase: NavPhase;
  drilled: boolean[];
  aimPx: P | null;
  markPx: P | null;
  capturing: CaptureKind | null;
  captured: number;
}

const HOLD_S = 0.35;

export class NavPipeline {
  private core: NavCore;
  private det: Detector;
  opts: Required<PipelineOptions>;
  private filter: PoseFilterHandle;
  private steady: SteadinessHandle;
  private lastPose: Pose | null = null;
  private lastSeen = -1;
  private lastRms = 0;
  private fSamples: number[] = [];
  private fAuto: number | null = null;
  private targetIndex = 0;
  private drilled = BOARD_TARGETS.map(() => false);
  private doneAt: number | null = null;
  private cap: { kind: CaptureKind; poses: Pose[]; views: { world: P[]; img: P[]; pose: Pose }[] } | null = null;

  constructor(core: NavCore, detector: Detector, opts: PipelineOptions) {
    this.core = core;
    this.det = detector;
    this.opts = { limits: PIPELINE_LIMITS, filter: true, ...opts };
    this.filter = core.createFilter();
    this.steady = core.createSteadiness(0.3);
  }

  dispose() {
    this.filter.free();
    this.steady.free();
  }

  get camera(): Camera {
    const c = this.opts.camera;
    return this.fAuto && !this.opts.cameraCalibrated ? { ...c, f: this.fAuto } : c;
  }
  setCamera(camera: Camera, calibrated: boolean) {
    this.opts.camera = camera;
    this.opts.cameraCalibrated = calibrated;
    this.fAuto = null;
    this.fSamples = [];
  }
  setTool(tool: ToolCalib, calibrated: boolean) {
    this.opts.tool = tool;
    this.opts.toolCalibrated = calibrated;
    this.filter.reset();
    this.steady.reset();
  }
  resetTargets() {
    this.drilled = BOARD_TARGETS.map(() => false);
    this.targetIndex = 0;
    this.doneAt = null;
  }

  // ---- calibration capture ----
  beginCapture(kind: CaptureKind) {
    this.cap = { kind, poses: [], views: [] };
  }
  cancelCapture() {
    this.cap = null;
  }
  /** Finish a capture and compute the calibration. Applies it when it succeeds. */
  endCapture():
    | { kind: "camera"; camera: Camera; rms: number; views: number }
    | { kind: "pivot"; tipCam: V3; rmsMm: number; spreadDeg: number; frames: number }
    | { kind: "roll"; axisCam: V3; spreadDeg: number; frames: number }
    | { kind: CaptureKind; error: string } {
    const c = this.cap;
    this.cap = null;
    if (!c) return { kind: "pivot", error: "no capture running" };
    if (c.kind === "camera") {
      if (c.views.length < 6) return { kind: "camera", error: `only ${c.views.length} views: tilt the phone more` };
      const r = this.core.calibrateCamera(c.views, this.opts.camera);
      if (!r) return { kind: "camera", error: "calibration failed" };
      this.setCamera(r.camera, true);
      return { kind: "camera", camera: r.camera, rms: r.rms, views: c.views.length };
    }
    if (c.kind === "pivot") {
      const r = this.core.pivot(c.poses);
      if (!r || r.spreadDeg < 10) return { kind: "pivot", error: "wobble the drill more around the tip" };
      this.setTool({ ...this.opts.tool, tipCam: r.tipCam }, this.opts.toolCalibrated);
      return { kind: "pivot", tipCam: r.tipCam, rmsMm: r.rmsM * 1000, spreadDeg: r.spreadDeg, frames: c.poses.length };
    }
    const r = this.core.axisFromRoll(c.poses);
    if (!r || r.spreadDeg < 15) return { kind: "roll", error: "twist the drill more around the bit" };
    this.setTool({ ...this.opts.tool, axisCam: r.axisCam }, true);
    return { kind: "roll", axisCam: r.axisCam, spreadDeg: r.spreadDeg, frames: c.poses.length };
  }

  /** Process one frame; t in seconds. */
  process(img: Rgba, t: number): PipelineResult {
    const markers = this.det.detect(img);
    const world: P[] = [];
    const raw: P[] = [];
    const quadsIn: P[][] = [];
    const known = markers.filter((m) => markerCorners(m.id));
    for (const m of known) quadsIn.push(m.corners);
    const quads = this.core.refineMany(img, quadsIn);
    known.forEach((m, i) => {
      const wc = markerCorners(m.id)!;
      for (let k = 0; k < 4; k++) {
        world.push(wc[k]);
        raw.push(quads[i][k]);
      }
    });

    let cam = this.camera;
    let pose: Pose | null = null;
    if (world.length >= 4) {
      const und = this.core.undistortPoints(cam, raw);
      const K = { f: cam.f, cx: cam.cx, cy: cam.cy };
      if (!this.opts.cameraCalibrated && this.fAuto == null) this.sampleFocal(world, und, K);
      cam = this.camera;
      pose = this.core.solvePose(world, und, { f: cam.f, cx: cam.cx, cy: cam.cy });
    }
    if (pose && pose.rms < 4) {
      this.lastPose = pose;
      this.lastSeen = t;
      this.lastRms = pose.rms;
      if (this.cap) this.capture(world, raw, pose);
    }
    const fresh = !!this.lastPose && t - this.lastSeen < HOLD_S;
    const P = fresh ? this.lastPose : null;
    if (!fresh) {
      this.filter.reset();
      this.steady.reset();
    }

    // which mark: while the tip is off the surface or far from the current mark, the nearest mark not
    // yet drilled (so the user chooses by pointing); sticky once the tip is on it or drilling
    if (P) {
      const probe = this.core.navEvaluate(P, this.opts.tool, BOARD_TARGETS[this.targetIndex]);
      const engaged = probe.depthMm > 0.3 || (probe.gapMm < 3 && probe.offsetMm < 6);
      if (!engaged && (this.doneAt == null || t - this.doneAt > 0.5)) {
        const left = BOARD_TARGETS.map((b, i) => ({ i, d: Math.hypot(b.x - probe.aim.x, b.y - probe.aim.y) })).filter((o) => !this.drilled[o.i]);
        if (!left.length) this.resetTargets();
        else this.targetIndex = left.sort((a, b) => a.d - b.d)[0].i;
      }
    }
    const target = BOARD_TARGETS[this.targetIndex];
    let rawNav: NavState | null = null;
    let nav: NavState | null = null;
    let jitter = { mm: Infinity, deg: Infinity };
    if (P) {
      rawNav = this.core.navEvaluate(P, this.opts.tool, target);
      if (this.lastSeen === t) this.steady.push(t, rawNav.tip, rawNav.axis);
      const j = this.steady.jitter();
      jitter = { mm: j.mm, deg: j.span > 0.15 ? j.deg : Infinity };
      if (j.span <= 0.15) jitter.mm = Infinity;
      if (this.opts.filter) {
        const f = this.filter.step(t, rawNav.tip, rawNav.axis);
        nav = this.core.navEvaluateWorld(f.tip, f.axis, target);
      } else nav = rawNav;
    }

    // phase and target bookkeeping
    let phase: NavPhase = "approach";
    if (nav) {
      if (nav.depthMm >= DEPTH_TARGET_MM - 0.2) {
        phase = "hold";
        this.drilled[this.targetIndex] = true;
        this.doneAt = t;
      } else if (nav.depthMm > 0.3) phase = "drill";
      else if (this.doneAt != null && t - this.doneAt < 1.5) phase = "retract";
      else if (nav.gapMm > 0.8 || nav.offsetMm > REQUIREMENT.offsetMm) phase = "approach";
      else phase = "align";
    }

    const gate = this.core.gate(
      {
        calibrated: this.opts.toolCalibrated,
        poseAgeS: P ? t - this.lastSeen : Infinity,
        rmsPx: P ? this.lastRms : Infinity,
        markers: P ? known.length : 0,
        angleErrDeg: nav?.angleErrDeg ?? Infinity,
        offsetMm: nav?.offsetMm ?? Infinity,
        jitterMm: jitter.mm,
        jitterDeg: jitter.deg,
      },
      this.opts.limits,
    );
    // gate only applies before drilling; while drilling the user follows depth and angle
    const ready = gate === 0 && (phase === "align" || phase === "approach");

    let aimPx: P | null = null;
    let markPx: P | null = null;
    if (P && nav) {
      const tg = BOARD_TARGETS[this.targetIndex];
      [aimPx, markPx] = this.core.projectPoints(cam, P, [
        [nav.aim.x, nav.aim.y, 0],
        [tg.x, tg.y, 0],
      ]);
    }
    return {
      t,
      markers: known.length,
      quads,
      pose: P,
      fresh,
      rmsPx: P ? this.lastRms : 0,
      focalPx: cam.f,
      focalLocked: this.opts.cameraCalibrated || this.fAuto != null,
      raw: rawNav,
      nav,
      jitter,
      gate,
      ready,
      targetIndex: this.targetIndex,
      phase,
      drilled: [...this.drilled],
      aimPx,
      markPx,
      capturing: this.cap?.kind ?? null,
      captured: this.cap ? (this.cap.kind === "camera" ? this.cap.views.length : this.cap.poses.length) : 0,
    };
  }

  private sampleFocal(world: P[], und: P[], K: { f: number; cx: number; cy: number }) {
    const H = this.core.homography(world, und);
    if (!H) return;
    const p0 = this.core.poseFromHomography(H, K);
    if (!p0) return;
    const R = p0.R;
    const tilt = (Math.acos(Math.min(1, Math.abs(R[8]))) * 180) / Math.PI; // camera z vs sheet normal
    if (tilt <= 20) return;
    const fe = this.core.focalFromHomography(H, K.cx, K.cy);
    if (fe && fe > K.f * 0.6 && fe < K.f * 1.6) {
      this.fSamples.push(fe);
      if (this.fSamples.length >= 30) {
        const s = [...this.fSamples].sort((a, b) => a - b);
        this.fAuto = s[Math.floor(s.length / 2)];
      }
    }
  }

  private capture(world: P[], raw: P[], pose: Pose) {
    const c = this.cap!;
    if (c.kind !== "camera") {
      c.poses.push(pose);
      return;
    }
    if (world.length < 12) return;
    // keep views that differ from the ones already captured (rotation > 6° or position > 3 cm)
    const differs = c.views.every((v) => {
      const a = v.pose.R, b = pose.R;
      const tr = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] + a[7] * b[7] + a[8] * b[8];
      const ang = (Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180) / Math.PI;
      const d = Math.hypot(v.pose.t[0] - pose.t[0], v.pose.t[1] - pose.t[1], v.pose.t[2] - pose.t[2]);
      return ang > 6 || d > 0.03;
    });
    if (differs && c.views.length < 30) c.views.push({ world: [...world], img: [...raw], pose });
  }
}

export function gateMessage(bits: number): string | null {
  if (!bits) return null;
  if (bits & GATE_REASONS.NOT_CALIBRATED) return "Calibrate first";
  if (bits & (GATE_REASONS.STALE | GATE_REASONS.FEW_MARKERS)) return "Show more markers";
  if (bits & GATE_REASONS.POOR_FIT) return "Markers unclear";
  if (bits & GATE_REASONS.UNSTEADY) return "Hold steady";
  if (bits & GATE_REASONS.TILTED) return "Line up the rings";
  if (bits & GATE_REASONS.OFF_TARGET) return "Tip to the mark";
  return null;
}
