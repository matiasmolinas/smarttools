// Marker tracker: a camera frame in, a measurement out. It sees the printed sheet and reports the
// relation T_camera_sheet with its capture time and quality; it knows nothing about tools, targets
// or the scene (docs/ENGINE_SPEC.md §6). It also collects the samples for the lens and dock
// calibrations, which are computed from what it measured.

import { markerCorners } from "./board.ts";
import { bodyIds, solveBodies, type BodyPose, type MarkerBody } from "./anchors.ts";
import type { Camera, NavCore, ToolCalib } from "./engine.ts";
import type { Pose, V3 } from "./pose.ts";

type P = { x: number; y: number };
export type Rgba = { width: number; height: number; data: Uint8ClampedArray };
export interface Detector {
  detect(img: Rgba): { id: number; corners: P[] }[];
}
export type CaptureKind = "camera" | "pivot" | "roll";

export interface TrackerFrame {
  tCapture: number;
  /** T_camera_sheet as the pose solver returns it (x_cam = R X + t), null if not seen */
  pose: Pose | null;
  markers: number;
  /** detected marker outlines (refined), image px */
  quads: P[][];
  rmsPx: number;
  focalPx: number;
  focalLocked: boolean;
  /** the camera model used for this frame (for projecting overlays) */
  camera: Camera;
  /** markers on parts (anchors): T_camera_body per body seen */
  bodies: BodyPose[];
  /** how long each stage took, ms (to find what is slow on a given phone) */
  timings?: { detectMs: number; refineMs: number; poseMs: number; drawMs?: number; bitmapMs?: number };
}

export type CaptureResult =
  | { kind: "camera"; camera: Camera; rms: number; views: number }
  | { kind: "pivot"; tipCam: V3; rmsMm: number; spreadDeg: number; frames: number }
  | { kind: "roll"; axisCam: V3; spreadDeg: number; frames: number }
  | { kind: CaptureKind; error: string };

export class MarkerTracker {
  private core: NavCore;
  private det: Detector;
  camera: Camera;
  cameraCalibrated: boolean;
  private fSamples: number[] = [];
  private fAuto: number | null = null;
  private cap: { kind: CaptureKind; poses: Pose[]; views: { world: P[]; img: P[]; pose: Pose }[] } | null = null;
  private bodies: MarkerBody[] = [];
  private bodyIds = new Set<number>();
  /** markers on parts seen in the last frame, by id: undistorted corners (for learning stickers) */
  lastBodyMarkers = new Map<number, P[]>();

  constructor(core: NavCore, detector: Detector, camera: Camera, cameraCalibrated: boolean) {
    this.core = core;
    this.det = detector;
    this.camera = camera;
    this.cameraCalibrated = cameraCalibrated;
  }

  /** The camera model in use (with the self-calibrated focal length until the lens is calibrated). */
  get effectiveCamera(): Camera {
    return this.fAuto && !this.cameraCalibrated ? { ...this.camera, f: this.fAuto } : this.camera;
  }

  /** Markers on parts to track besides the sheet (their ids must not be the sheet's). */
  setBodies(bodies: MarkerBody[]) {
    this.bodies = bodies;
    this.bodyIds = bodyIds(bodies);
  }

  setCamera(camera: Camera, calibrated: boolean) {
    this.camera = camera;
    this.cameraCalibrated = calibrated;
    this.fAuto = null;
    this.fSamples = [];
  }

  get capturing(): CaptureKind | null {
    return this.cap?.kind ?? null;
  }
  get captured(): number {
    return this.cap ? (this.cap.kind === "camera" ? this.cap.views.length : this.cap.poses.length) : 0;
  }
  beginCapture(kind: CaptureKind) {
    this.cap = { kind, poses: [], views: [] };
  }
  cancelCapture() {
    this.cap = null;
  }

  /** Finish a capture and compute it. A lens result is applied here; dock results are returned. */
  endCapture(tool: ToolCalib): CaptureResult {
    const c = this.cap;
    this.cap = null;
    if (!c) return { kind: "pivot", error: "no capture running" };
    if (c.kind === "camera") {
      if (c.views.length < 6) return { kind: "camera", error: `only ${c.views.length} views: tilt the phone more` };
      const r = this.core.calibrateCamera(c.views, this.camera);
      if (!r) return { kind: "camera", error: "lens calibration failed" };
      this.setCamera(r.camera, true);
      return { kind: "camera", camera: r.camera, rms: r.rms, views: c.views.length };
    }
    if (c.kind === "pivot") {
      const r = this.core.pivot(c.poses);
      if (!r || r.spreadDeg < 10) return { kind: "pivot", error: "circle the drill more around the tip" };
      return { kind: "pivot", tipCam: r.tipCam, rmsMm: r.rmsM * 1000, spreadDeg: r.spreadDeg, frames: c.poses.length };
    }
    const r = this.core.axisFromRoll(c.poses);
    if (!r || r.spreadDeg < 15) return { kind: "roll", error: "twist the drill more around the bit" };
    void tool;
    return { kind: "roll", axisCam: r.axisCam, spreadDeg: r.spreadDeg, frames: c.poses.length };
  }

  /** Process one frame captured at tCapture (seconds). */
  frame(img: Rgba, tCapture: number): TrackerFrame {
    const t0 = performance.now();
    const all = this.det.detect(img);
    const t1 = performance.now();
    const known = all.filter((m) => markerCorners(m.id));
    const onParts = all.filter((m) => this.bodyIds.has(m.id));
    const quads = this.core.refineMany(img, known.map((m) => m.corners));
    const t2 = performance.now();
    const world: P[] = [];
    const raw: P[] = [];
    known.forEach((m, i) => {
      const wc = markerCorners(m.id)!;
      for (let k = 0; k < 4; k++) {
        world.push(wc[k]);
        raw.push(quads[i][k]);
      }
    });
    let cam = this.effectiveCamera;
    let pose: Pose | null = null;
    let kept = 0;
    let keep: boolean[] = [];
    if (world.length >= 4) {
      const und = this.core.undistortPoints(cam, raw);
      if (!this.cameraCalibrated && this.fAuto == null) this.sampleFocal(world, und, cam);
      cam = this.effectiveCamera;
      const sol = this.core.solvePoseRobust(world, und, { f: cam.f, cx: cam.cx, cy: cam.cy });
      if (sol && sol.pose.rms < 4) {
        pose = sol.pose;
        kept = sol.kept;
        keep = sol.keep;
      }
    }
    if (pose && this.cap) this.capture(world.filter((_, i) => keep[i >> 2]), raw.filter((_, i) => keep[i >> 2]), pose);
    let bodies: BodyPose[] = [];
    this.lastBodyMarkers = new Map();
    if (onParts.length) {
      const pq = this.core.refineMany(img, onParts.map((m) => m.corners));
      const und = this.core.undistortPoints(cam, pq.flat());
      onParts.forEach((m, i) => this.lastBodyMarkers.set(m.id, und.slice(i * 4, i * 4 + 4)));
      bodies = solveBodies(this.core, this.bodies, this.lastBodyMarkers, { f: cam.f, cx: cam.cx, cy: cam.cy });
      quads.push(...pq);
    }
    const t3 = performance.now();
    const timings = { detectMs: t1 - t0, refineMs: t2 - t1, poseMs: t3 - t2 };
    return { tCapture, pose, markers: kept, quads, rmsPx: pose?.rms ?? Infinity, focalPx: cam.f, focalLocked: this.cameraCalibrated || this.fAuto != null, camera: cam, bodies, timings };
  }

  private sampleFocal(world: P[], und: P[], cam: Camera) {
    const H = this.core.homography(world, und);
    if (!H) return;
    const p0 = this.core.poseFromHomography(H, cam);
    if (!p0) return;
    const tilt = (Math.acos(Math.min(1, Math.abs(p0.R[8]))) * 180) / Math.PI;
    if (tilt <= 20) return;
    const fe = this.core.focalFromHomography(H, cam.cx, cam.cy);
    if (fe && fe > cam.f * 0.6 && fe < cam.f * 1.6) {
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
    const differs = c.views.every((v) => {
      const a = v.pose.R, b = pose.R;
      let tr = 0;
      for (let i = 0; i < 9; i++) tr += a[i] * b[i];
      const ang = (Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180) / Math.PI;
      return ang > 6 || Math.hypot(v.pose.t[0] - pose.t[0], v.pose.t[1] - pose.t[1], v.pose.t[2] - pose.t[2]) > 0.03;
    });
    if (differs && c.views.length < 30) c.views.push({ world: [...world], img: [...raw], pose });
  }
}
