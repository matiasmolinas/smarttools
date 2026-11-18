// Optical tracker: printed ArUco markers -> 6-DoF camera pose -> drill state for the HUD.
// 100% optical: no IMU. The phone camera is rigid with the drill (dock), so the bit tip and axis
// are fixed in the camera frame (calibrated once on a known mark).

import { AR } from "./aruco";
import { BIT_LEN, ANGLE_TOL_DEG, DEPTH_TARGET_MM, OFFSET_TOL_MM, type SimState } from "./sim";
import { BOARD_TARGETS, DICTIONARY, markerCorners } from "./board";
import { refineCorners } from "./subpix";
import {
  dirToWorld,
  focalFromHomography,
  homography,
  poseFromHomography,
  project,
  refinePose,
  toWorld,
  type Intrinsics,
  type Pose,
  type V3,
} from "./pose";
import type { Overlay } from "./hud";

const DEFAULT_HFOV_DEG = 66; // typical phone main camera, long side
const DEFAULT_TIP_CAM: V3 = [0, 0.055, 0.17]; // tip below (y+) and ahead (z+) of the lens, metres
const AXIS_CAM: V3 = [0, 0, 1]; // dock keeps the bit parallel to the optical axis

export interface TrackResult {
  state: SimState;
  overlay: Overlay;
  ok: boolean;
  focalPx: number;
  rmsPx: number;
}

export class OpticalTracker {
  private det = new AR.Detector({ dictionaryName: DICTIONARY });
  private work = typeof document !== "undefined" ? document.createElement("canvas") : null;
  private wctx = this.work?.getContext("2d", { willReadFrequently: true }) ?? null;
  private fSamples: number[] = [];
  private fAuto: number | null = null;
  private fLocked = false;
  tipCam: V3 = load("st-tipcam") ?? DEFAULT_TIP_CAM;
  private smooth: { tip: V3; axis: V3 } | null = null;
  private lastPose: Pose | null = null;
  private lastSeen = -1;
  private targetIndex = 0;
  private drilled = BOARD_TARGETS.map(() => false);
  private doneAt: number | null = null;
  private lastK: Intrinsics | null = null;

  /** process one video frame; t in seconds */
  update(video: HTMLVideoElement, t: number): TrackResult | null {
    if (!this.wctx || !this.work || video.readyState < 2 || !video.videoWidth) return null;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    // detect on a downscaled frame for speed, keep corners in video px
    const ds = Math.min(1, 960 / Math.max(vw, vh));
    const w = Math.round(vw * ds);
    const h = Math.round(vh * ds);
    if (this.work.width !== w || this.work.height !== h) {
      this.work.width = w;
      this.work.height = h;
    }
    this.wctx.drawImage(video, 0, 0, w, h);
    const img = this.wctx.getImageData(0, 0, w, h);
    const markers = this.det.detect(img);

    const world: { x: number; y: number }[] = [];
    const pix: { x: number; y: number }[] = [];
    const quads: { x: number; y: number }[][] = [];
    for (const m of markers) {
      const wc = markerCorners(m.id);
      if (!wc) continue;
      const rc = refineCorners(img, m.corners).map((p) => ({ x: p.x / ds, y: p.y / ds }));
      quads.push(rc);
      for (let i = 0; i < 4; i++) {
        world.push(wc[i]);
        pix.push(rc[i]);
      }
    }

    const fDefault = vw / 2 / Math.tan(((DEFAULT_HFOV_DEG / 2) * Math.PI) / 180);
    const K: Intrinsics = { f: this.fAuto ?? fDefault, cx: vw / 2, cy: vh / 2 };
    this.lastK = K;

    let pose: Pose | null = null;
    if (world.length >= 4) {
      const H = homography(world, pix);
      if (H) {
        const p0 = poseFromHomography(H, K);
        // self-calibrate focal length, only from clearly tilted views (frontal views are ill-conditioned),
        // median of 30 samples, then frozen
        if (p0 && !this.fLocked) {
          const tilt = (Math.acos(Math.min(1, Math.abs(dirToWorld(p0, AXIS_CAM)[2]))) * 180) / Math.PI;
          const fe = tilt > 20 ? focalFromHomography(H, K.cx, K.cy) : null;
          if (fe && fe > fDefault * 0.6 && fe < fDefault * 1.6) {
            this.fSamples.push(fe);
            if (this.fSamples.length >= 30) {
              const sorted = [...this.fSamples].sort((a, b) => a - b);
              this.fAuto = sorted[Math.floor(sorted.length / 2)];
              this.fLocked = true;
            }
          }
        }
        if (p0) pose = refinePose(p0, world, pix, K);
      }
    }
    if (pose && pose.rms < 4) {
      this.lastPose = pose;
      this.lastSeen = t;
    }
    const fresh = this.lastPose && t - this.lastSeen < 0.35;
    const P = fresh ? this.lastPose! : null;

    // tool state in world (sheet) frame
    let tip: V3 = [0, 0, 0.2];
    let axis: V3 = [0, 0, -1];
    if (P) {
      const tipW = toWorld(P, this.tipCam);
      const axW = dirToWorld(P, AXIS_CAM);
      if (this.smooth) {
        const a = 0.45;
        this.smooth.tip = lerp3(this.smooth.tip, tipW, a);
        this.smooth.axis = norm3(lerp3(this.smooth.axis, axW, a));
      } else this.smooth = { tip: tipW, axis: axW };
      tip = this.smooth.tip;
      axis = this.smooth.axis;
    }

    // where the axis meets the surface (z = 0)
    const k = axis[2] < -1e-6 ? -tip[2] / axis[2] : 0;
    const aim: V3 = [tip[0] + axis[0] * k, tip[1] + axis[1] * k, 0];

    // current target: keep until drilled, then the nearest remaining one
    if (this.drilled[this.targetIndex]) {
      const left = BOARD_TARGETS.map((b, i) => ({ i, d: Math.hypot(b.x - aim[0], b.y - aim[1]) })).filter((o) => !this.drilled[o.i]);
      if (left.length) this.targetIndex = left.sort((a, b) => a.d - b.d)[0].i;
      else this.drilled = BOARD_TARGETS.map(() => false);
    }
    const target = BOARD_TARGETS[this.targetIndex];

    const yawDeg = (Math.atan2(axis[0], -axis[2]) * 180) / Math.PI;
    const pitchDeg = (Math.atan2(axis[1], -axis[2]) * 180) / Math.PI;
    const angleErrDeg = (Math.acos(Math.min(1, Math.max(-1, -axis[2]))) * 180) / Math.PI;
    const offsetMm = Math.hypot(aim[0] - target.x, aim[1] - target.y) * 1000;
    const gapMm = Math.max(0, tip[2] * 1000);
    const depthMm = Math.max(0, -tip[2] * 1000);

    let phase: SimState["phase"];
    if (depthMm >= DEPTH_TARGET_MM - 0.2) {
      phase = "hold";
      this.drilled[this.targetIndex] = true;
      this.doneAt = t;
    } else if (depthMm > 0.3) phase = "drill";
    else if (this.doneAt != null && t - this.doneAt < 1.5) phase = "retract";
    else if (gapMm > 0.8 || offsetMm > OFFSET_TOL_MM) phase = "approach";
    else phase = "align";

    const state: SimState = {
      t,
      phase,
      targetIndex: this.targetIndex,
      target: { x: target.x, y: target.y },
      tip: { x: tip[0], y: tip[1], z: tip[2] },
      chuck: { x: tip[0] - axis[0] * BIT_LEN, y: tip[1] - axis[1] * BIT_LEN, z: tip[2] - axis[2] * BIT_LEN },
      axis: { x: axis[0], y: axis[1], z: axis[2] },
      yawDeg,
      pitchDeg,
      angleErrDeg,
      offsetMm,
      gapMm,
      depthMm,
      aligned: angleErrDeg < ANGLE_TOL_DEG,
      onTarget: offsetMm < OFFSET_TOL_MM,
      drilled: [...this.drilled],
      bitSpin: 0,
      label: target.label,
    };

    const aimPx = P ? project(aim, P, K) : null;
    const markPx = P ? project([target.x, target.y, 0], P, K) : null;
    const overlay: Overlay = {
      lost: !P,
      aim: aimPx,
      mark: markPx,
      quads,
      info: P ? `${quads.length} tag${quads.length === 1 ? "" : "s"} · f ${Math.round(K.f)}${this.fLocked ? "" : "?"}` : "searching",
    };
    return { state, overlay, ok: !!P, focalPx: K.f, rmsPx: P?.rms ?? 0 };
  }

  /** Dock calibration: the tip is resting on mark A2 (sheet centre). Stores the tip in the camera frame. */
  calibrateTipOn(label = "A2"): boolean {
    const P = this.lastPose;
    const tg = BOARD_TARGETS.find((b) => b.label === label);
    if (!P || !tg || !this.lastK) return false;
    const R = P.R;
    const w: V3 = [tg.x, tg.y, 0];
    this.tipCam = [
      R[0] * w[0] + R[1] * w[1] + R[2] * w[2] + P.t[0],
      R[3] * w[0] + R[4] * w[1] + R[5] * w[2] + P.t[1],
      R[6] * w[0] + R[7] * w[1] + R[8] * w[2] + P.t[2],
    ];
    this.smooth = null;
    save("st-tipcam", this.tipCam);
    return true;
  }

  reset() {
    this.drilled = BOARD_TARGETS.map(() => false);
    this.targetIndex = 0;
    this.doneAt = null;
  }
}

const lerp3 = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const norm3 = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

function load(key: string): V3 | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(v) && v.length === 3 ? (v as V3) : null;
  } catch {
    return null;
  }
}
function save(key: string, v: V3) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}
