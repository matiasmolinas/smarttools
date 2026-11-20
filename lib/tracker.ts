// Browser side of the navigation: camera (or simulated) frames -> NavPipeline (js-aruco2 + Rust core)
// -> HUD state. Keeps the calibrations (lens, dock) in localStorage and runs the calibration flows.
// 100% optical: no IMU.

import { AR } from "./aruco";
import { BIT_LEN, type SimState } from "./sim";
import { BOARD_TARGETS, DICTIONARY } from "./board";
import { NavCore, cameraFromHfov, type Camera, type ToolCalib } from "./engine";
import { NavPipeline, PIPELINE_LIMITS, gateMessage, type PipelineResult, type Rgba } from "./navpipeline";
import type { Overlay } from "./hud";

export const DEFAULT_HFOV_DEG = 66; // typical phone main camera, long side
export const DEFAULT_TOOL: ToolCalib = { tipCam: [0, 0.055, 0.17], axisCam: [0, 0, 1] };
const MAX_SIDE = 960; // detection resolution

export type CalStep = "pivot" | "roll" | "camera";
const CAL_SECONDS: Record<CalStep, number> = { pivot: 5, roll: 5, camera: 20 };
const CAL_TEXT: Record<CalStep, string> = {
  pivot: "Tip on A2 · circle the drill",
  roll: "Tip on A2 · twist the drill",
  camera: "Move the phone over the sheet",
};

export interface TrackResult {
  state: SimState;
  overlay: Overlay;
  result: PipelineResult;
}

type Stored<T> = { v: 1; width: number; height: number; value: T };

export class OpticalTracker {
  private core: NavCore;
  private pipe: NavPipeline | null = null;
  private work: HTMLCanvasElement = document.createElement("canvas");
  private wctx = this.work.getContext("2d", { willReadFrequently: true })!;
  private size = { w: 0, h: 0 };
  private cal: { step: CalStep; until: number; then: CalStep | null; t0: number } | null = null;
  /** messages for the UI (toasts) */
  onMessage: (m: string) => void = () => {};
  /** set by the caller for simulated runs: the calibration is known, nothing is stored */
  ephemeral = false;
  extraInfo: (r: PipelineResult) => string = () => "";

  private constructor(core: NavCore) {
    this.core = core;
  }

  static async create(): Promise<OpticalTracker> {
    return new OpticalTracker(await NavCore.load());
  }

  get engine() {
    return this.core;
  }

  /** Use a known calibration (simulation) instead of the stored one. */
  useCalibration(camera: Camera, tool: ToolCalib, width: number, height: number) {
    this.ephemeral = true;
    this.size = { w: width, h: height };
    this.pipe?.dispose();
    this.pipe = new NavPipeline(this.core, new AR.Detector({ dictionaryName: DICTIONARY }), {
      camera,
      cameraCalibrated: true,
      tool,
      toolCalibrated: true,
      limits: PIPELINE_LIMITS,
    });
  }

  private ensurePipeline(w: number, h: number) {
    if (this.pipe && this.size.w === w && this.size.h === h) return this.pipe;
    this.size = { w, h };
    const cam = load<Camera>("st-camera", w, h, scaleCamera);
    const tool = load<ToolCalib>("st-tool", w, h, (t) => t);
    this.pipe?.dispose();
    this.pipe = new NavPipeline(this.core, new AR.Detector({ dictionaryName: DICTIONARY }), {
      camera: cam ?? cameraFromHfov(w, h, DEFAULT_HFOV_DEG),
      cameraCalibrated: !!cam,
      tool: tool ?? DEFAULT_TOOL,
      toolCalibrated: !!tool,
      limits: PIPELINE_LIMITS,
    });
    return this.pipe;
  }

  get calibrated() {
    return { camera: !!this.pipe?.opts.cameraCalibrated, tool: !!this.pipe?.opts.toolCalibrated };
  }

  /** Dock calibration: wobble around the tip on A2 (tip), then twist around the bit (axis). */
  startToolCalibration(t: number) {
    if (!this.pipe) return;
    this.pipe.beginCapture("pivot");
    this.cal = { step: "pivot", until: t + CAL_SECONDS.pivot, then: "roll", t0: t };
  }
  /** Lens calibration: 20 s of varied views of the sheet. */
  startCameraCalibration(t: number) {
    if (!this.pipe) return;
    this.pipe.beginCapture("camera");
    this.cal = { step: "camera", until: t + CAL_SECONDS.camera, then: null, t0: t };
  }
  cancelCalibration() {
    this.pipe?.cancelCapture();
    this.cal = null;
  }
  forgetCalibration() {
    try {
      localStorage.removeItem("st-camera");
      localStorage.removeItem("st-tool");
    } catch {}
    this.pipe = null;
  }

  private stepCalibration(t: number) {
    const c = this.cal;
    if (!c || !this.pipe || t < c.until) return;
    const r = this.pipe.endCapture();
    if ("error" in r) {
      this.onMessage(r.error.toUpperCase());
      this.cal = null;
      return;
    }
    if (r.kind === "camera" && "camera" in r) {
      if (!this.ephemeral) save("st-camera", this.size, r.camera);
      this.onMessage(`LENS OK · ${r.views} VIEWS · ${r.rms.toFixed(2)} PX`);
    }
    if (r.kind === "pivot" && "tipCam" in r) this.onMessage(`TIP OK · ${r.rmsMm.toFixed(2)} MM`);
    if (r.kind === "roll" && "axisCam" in r) {
      if (!this.ephemeral) save("st-tool", this.size, this.pipe.opts.tool);
      this.onMessage("DOCK CALIBRATED");
    }
    if (c.then) {
      this.pipe.beginCapture(c.then);
      this.cal = { step: c.then, until: t + CAL_SECONDS[c.then], then: null, t0: t };
    } else this.cal = null;
  }

  /** Process one frame from a <video> or <canvas>; t in seconds. */
  update(source: HTMLVideoElement | HTMLCanvasElement, t: number): TrackResult | null {
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!sw || !sh || (source instanceof HTMLVideoElement && source.readyState < 2)) return null;
    const ds = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.round(sw * ds);
    const h = Math.round(sh * ds);
    if (this.work.width !== w || this.work.height !== h) {
      this.work.width = w;
      this.work.height = h;
    }
    this.wctx.drawImage(source, 0, 0, w, h);
    return this.process(this.wctx.getImageData(0, 0, w, h), t, 1 / ds);
  }

  /** Process an RGBA frame directly (simulation). `scale` maps frame px to source px. */
  process(img: Rgba, t: number, scale = 1): TrackResult {
    const pipe = this.pipe && this.ephemeral ? this.pipe : this.ensurePipeline(img.width, img.height);
    const r = pipe.process(img, t);
    this.stepCalibration(t);
    return { state: toState(r, t), overlay: this.overlay(r, t, scale), result: r };
  }

  private overlay(r: PipelineResult, t: number, s: number): Overlay {
    const px = (p: { x: number; y: number } | null) => (p ? { x: p.x * s, y: p.y * s } : null);
    const cal = this.cal;
    const c = this.calibrated;
    return {
      lost: !r.fresh,
      aim: px(r.aimPx),
      mark: px(r.markPx),
      quads: r.quads.map((q) => q.map((p) => ({ x: p.x * s, y: p.y * s }))),
      info: r.fresh
        ? `${r.markers} tags · ${c.camera ? "lens ✓" : `f ${Math.round(r.focalPx)}${r.focalLocked ? "" : "?"}`} · ${c.tool ? "dock ✓" : "dock ?"}${this.extraInfo(r)}`
        : "searching",
      gate: { ready: r.ready, message: gateMessage(r.gate) },
      calibrating: cal
        ? { text: CAL_TEXT[cal.step], progress: Math.min(1, (t - cal.t0) / CAL_SECONDS[cal.step]), count: r.captured }
        : null,
    };
  }
}

function toState(r: PipelineResult, t: number): SimState {
  const n = r.nav;
  const tg = BOARD_TARGETS[r.targetIndex];
  const tip = n?.tip ?? [0, 0, 0.2];
  const axis = n?.axis ?? [0, 0, -1];
  return {
    t,
    phase: r.phase,
    targetIndex: r.targetIndex,
    target: { x: tg.x, y: tg.y },
    tip: { x: tip[0], y: tip[1], z: tip[2] },
    chuck: { x: tip[0] - axis[0] * BIT_LEN, y: tip[1] - axis[1] * BIT_LEN, z: tip[2] - axis[2] * BIT_LEN },
    axis: { x: axis[0], y: axis[1], z: axis[2] },
    yawDeg: n?.yawDeg ?? 0,
    pitchDeg: n?.pitchDeg ?? 0,
    angleErrDeg: n?.angleErrDeg ?? 90,
    offsetMm: n?.offsetMm ?? 1e3,
    gapMm: n?.gapMm ?? 200,
    depthMm: n?.depthMm ?? 0,
    aligned: !!n && n.angleErrDeg < PIPELINE_LIMITS.maxAngleDeg,
    onTarget: !!n && n.offsetMm < PIPELINE_LIMITS.maxOffsetMm,
    drilled: r.drilled,
    bitSpin: 0,
    label: tg.label,
  };
}

function scaleCamera(c: Camera, k: number): Camera {
  return { ...c, f: c.f * k, cx: c.cx * k, cy: c.cy * k };
}

function load<T>(key: string, w: number, h: number, rescale: (v: T, k: number) => T): T | null {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "null") as Stored<T> | null;
    if (!s || s.v !== 1) return null;
    const k = w / s.width;
    if (Math.abs(h / s.height - k) > 0.01) return null; // different aspect ratio: recalibrate
    return rescale(s.value, k);
  } catch {
    return null;
  }
}
function save<T>(key: string, size: { w: number; h: number }, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: 1, width: size.w, height: size.h, value } satisfies Stored<T>));
  } catch {}
}
