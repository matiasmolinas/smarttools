// Marker tracker: a camera frame in, a measurement out. It sees the printed sheet and reports the
// relation T_camera_sheet with its capture time and quality; it knows nothing about tools, targets
// or the scene (docs/ENGINE_SPEC.md §6). It also collects the samples for the lens and dock
// calibrations, which are computed from what it measured.

import { markerCorners, sheetOf } from "./board.ts";
import { emptyMap, screenDetections, solveTable, type SheetView, type TableMap } from "./tablemap.ts";
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
  /** T_camera_sheet as the pose solver returns it (x_cam = R X + t), null if not seen. With a table map
   * (setTableMap) "the sheet" is the whole table: sheet 0's frame, solved from every mapped sheet's markers. */
  pose: Pose | null;
  /** markers the pose kept (what the gate counts) */
  markers: number;
  /** the table's sheets in view: markers per sheet, an observation for a sheet not mapped, the reprojection error
   * of a mapped one (lib/tablemap.ts SheetView) */
  sheets: SheetView[];
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
  timings?: {
    detectMs: number;
    refineMs: number;
    poseMs: number;
    drawMs?: number;
    bitmapMs?: number;
    /** compare mode: the other detector on the same frame */
    alt?: { kind: string; detectMs: number; markers: number; shared: number; meanCornerPx: number };
  };
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
  private table: TableMap = emptyMap(new Date(0).toISOString());
  /** markers on parts seen in the last frame, by id: undistorted corners (for learning stickers) */
  lastBodyMarkers = new Map<number, P[]>();

  /** Swap the marker detector (js-aruco2 or the Rust one, lib/detectors.ts). */
  setDetector(d: Detector) {
    this.det = d;
  }
  /** Raw detections of a frame with the current detector (for comparisons). */
  detectRaw(img: Rgba) {
    return this.det.detect(img);
  }

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

  /** The table map: which sheets are mapped and where (lib/tablemap.ts). Markers of sheets not in it never enter
   * the pose. The default has only sheet 0. */
  setTableMap(map: TableMap) {
    this.table = map;
  }
  get tableMap(): TableMap {
    return this.table;
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
    // the table's markers: any sheet's id, unless it is a marker on a part (a body's ids win). With four sheets every
    // id 0..111 is valid, so false reads are cleaned first: quads too small to be a real marker, and ids detected
    // twice (lib/tablemap.ts screenDetections). Markers on parts are left as they were (stickers on a side face are
    // seen at a grazing angle, small by nature).
    const known = screenDetections(all.filter((m) => sheetOf(m.id) != null && !this.bodyIds.has(m.id))).kept;
    const onParts = all.filter((m) => this.bodyIds.has(m.id));
    const quads = this.core.refineMany(img, known.map((m) => m.corners));
    const t2 = performance.now();
    let cam = this.effectiveCamera;
    let pose: Pose | null = null;
    let kept = 0;
    let sheets: TrackerFrame["sheets"] = [];
    if (known.length) {
      const und = this.core.undistortPoints(cam, quads.flat());
      // the lens model (focal self-calibration, lens captures) learns from sheet 0 only: never from a learned map
      const s0 = known.flatMap((m, i) => (sheetOf(m.id) === 0 ? [i] : []));
      if (!this.cameraCalibrated && this.fAuto == null && s0.length) {
        this.sampleFocal(s0.flatMap((i) => markerCorners(known[i].id)!), s0.flatMap((i) => und.slice(i * 4, i * 4 + 4)), cam);
      }
      cam = this.effectiveCamera;
      const K = { f: cam.f, cx: cam.cx, cy: cam.cy };
      const r = solveTable(this.table, known.map((m, i) => ({ id: m.id, img: und.slice(i * 4, i * 4 + 4) })), (w, p) => this.core.solvePoseRobust(w, p, K), K);
      pose = r.pose;
      kept = r.kept;
      sheets = r.sheets;
      if (pose && this.cap) {
        const world: P[] = [];
        const raw: P[] = [];
        r.used.forEach((i, j) => {
          if (!r.keep[j] || (this.cap!.kind === "camera" && sheetOf(known[i].id) !== 0)) return;
          world.push(...r.world.slice(j * 4, j * 4 + 4));
          raw.push(...quads[i]);
        });
        this.capture(world, raw, pose);
      }
    }
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
    return { tCapture, pose, markers: kept, sheets, quads, rmsPx: pose?.rms ?? Infinity, focalPx: cam.f, focalLocked: this.cameraCalibrated || this.fAuto != null, camera: cam, bodies, timings };
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
