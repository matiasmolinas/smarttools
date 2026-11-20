// Browser side of the navigation. Three independent loops on two threads (docs/ENGINE_SPEC.md §7, §11):
//   frame(source, tCapture)  — at the camera rate; the tracker runs in a Web Worker and its results
//                              are pushed to the engine as they arrive
//   advance(tWall)           — at 120 Hz (a timer), the engine's clock
//   view()                   — whenever the screen refreshes, the latest snapshot for the HUD
// It also keeps the calibrations (lens, dock) in localStorage and runs the calibration flows.

import { AR } from "./aruco";
import { DICTIONARY } from "./board";
import { NavCore, cameraFromHfov, ENGINE_DEFAULTS, type Camera, type ToolCalib } from "./engine";
import { NavSession } from "./session";
import type { CaptureKind, CaptureResult } from "./markertracker";
import { TrackerClient, type WorkerResult } from "./trackerclient";
import type { Rig } from "./scene";
import type { Xf } from "./xform";
import type { Overlay } from "./hud";
import type { SimState } from "./sim";
import { hudView } from "./render/hudview";

export const DEFAULT_HFOV_DEG = 66; // typical phone main camera, long side
export const DEFAULT_TOOL: ToolCalib = { tipCam: [0, 0.055, 0.17], axisCam: [0, 0, 1] };
const MAX_SIDE = 960; // detection resolution

const CAL_SECONDS: Record<CaptureKind, number> = { pivot: 5, roll: 5, camera: 20 };
const CAL_TEXT: Record<CaptureKind, string> = {
  pivot: "Tip on A2 · circle the drill",
  roll: "Tip on A2 · twist the drill",
  camera: "Move the phone over the sheet",
};

type Stored<T> = { v: 1; width: number; height: number; value: T };

export class BrowserNav {
  readonly core: NavCore;
  session: NavSession | null = null;
  private client: TrackerClient | null = null;
  private size = { w: 0, h: 0 };
  private ending = false;
  /** simulated frames rendered by the worker, for display */
  onSimImage: (img: ImageData) => void = () => {};
  /** frame px -> source px */
  private scale = 1;
  private cal: { step: CaptureKind; t0: number; until: number; then: CaptureKind | null } | null = null;
  private ephemeral = false;
  onMessage: (m: string) => void = () => {};
  extraInfo: () => string = () => "";
  /** tracker frames processed, for the stats line */
  frames = 0;

  private constructor(core: NavCore) {
    this.core = core;
  }
  static async create(): Promise<BrowserNav> {
    return new BrowserNav(await NavCore.load());
  }

  /** Simulation: a known calibration, nothing stored. */
  useCalibration(camera: Camera, tool: ToolCalib, width: number, height: number, t0: number) {
    this.ephemeral = true;
    this.size = { w: width, h: height };
    this.session?.dispose();
    this.session = new NavSession(this.core, new AR.Detector({ dictionaryName: DICTIONARY }), { camera, cameraCalibrated: true, tool, toolCalibrated: true, t0 });
    this.attachWorker(camera, true);
  }

  private attachWorker(camera: Camera, calibrated: boolean) {
    this.client?.terminate();
    const c = new TrackerClient(camera, calibrated, MAX_SIDE);
    c.onResult = (r: WorkerResult) => this.onWorkerResult(r);
    this.client = c;
  }

  private onWorkerResult(r: WorkerResult) {
    this.scale = r.scale;
    this.session?.pushTrackerFrame(r.frame);
    this.frames++;
    if (r.pixels) this.onSimImage(new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height));
  }

  /** frames dropped because the tracker was still busy */
  get dropped() {
    return this.client?.dropped ?? 0;
  }

  private ensureSession(w: number, h: number, t0: number) {
    if (this.session && (this.ephemeral || (this.size.w === w && this.size.h === h))) return this.session;
    this.size = { w, h };
    const cam = load<Camera>("st-camera", w, h, (c, k) => ({ ...c, f: c.f * k, cx: c.cx * k, cy: c.cy * k }));
    const tool = load<ToolCalib>("st-tool", w, h, (t) => t);
    this.session?.dispose();
    const camera = cam ?? cameraFromHfov(w, h, DEFAULT_HFOV_DEG);
    this.session = new NavSession(this.core, new AR.Detector({ dictionaryName: DICTIONARY }), {
      camera,
      cameraCalibrated: !!cam,
      tool: tool ?? DEFAULT_TOOL,
      toolCalibrated: !!tool,
      t0,
    });
    this.attachWorker(camera, !!cam);
    return this.session;
  }

  get calibrated() {
    return { camera: !!this.session?.tracker.cameraCalibrated, tool: !!this.session?.toolCalibrated };
  }

  // ---------------- loop 1: frames (tracked in the worker) ----------------
  /** A frame from a <video> or <canvas>, captured at tCapture (s, performance.now() timebase).
   * Dropped if the tracker is still busy with the previous one. */
  frame(source: HTMLVideoElement | HTMLCanvasElement, tCapture: number) {
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!sw || !sh || (source instanceof HTMLVideoElement && source.readyState < 2)) return;
    const ds = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    this.ensureSession(Math.round(sw * ds), Math.round(sh * ds), tCapture);
    void this.client?.frame(source, tCapture);
  }
  /** Simulation: the worker renders what the docked camera sees for this tool pose, then tracks it. */
  simFrame(rig: Rig, codes: Uint8Array, toolW: Xf, tCapture: number, seed: number) {
    this.client?.sim(rig, codes, toolW, tCapture, seed);
  }

  // ---------------- loop 2: the engine clock ----------------
  advance(tWall: number) {
    const s = this.session;
    if (!s) return 0;
    const n = s.advance(tWall);
    this.stepCalibration(tWall);
    return n;
  }

  // ---------------- loop 3: what to draw ----------------
  view(): { state: SimState; overlay: Overlay } | null {
    const s = this.session;
    const snap = s?.snapshot;
    if (!s || !snap) return null;
    const pts = s.overlayPoints();
    const c = this.calibrated;
    const lf = s.lastFrame;
    const cal = this.cal;
    return hudView({
      def: s.scene.def,
      ids: s.scene.ids,
      snapshot: snap,
      image: { aim: pts.aim, mark: pts.mark, quads: lf?.quads ?? [], scale: this.scale },
      info: `${snap.markers} tags · ${c.camera ? "lens ✓" : `f ${Math.round(lf?.focalPx ?? 0)}${lf?.focalLocked ? "" : "?"}`} · ${c.tool ? "dock ✓" : "dock ?"} · ${Math.round(snap.stats.latencyS * 1000)} ms${this.extraInfo()}`,
      calibrating: cal ? { text: CAL_TEXT[cal.step], progress: Math.min(1, (snap.t - cal.t0) / CAL_SECONDS[cal.step]), count: s.tracker.captured } : null,
      limits: ENGINE_DEFAULTS.limits,
    });
  }

  // ---------------- calibration flows ----------------
  startToolCalibration(t: number) {
    if (!this.session) return;
    this.client?.beginCapture("pivot");
    this.cal = { step: "pivot", t0: t, until: t + CAL_SECONDS.pivot, then: "roll" };
  }
  startCameraCalibration(t: number) {
    if (!this.session) return;
    this.client?.beginCapture("camera");
    this.cal = { step: "camera", t0: t, until: t + CAL_SECONDS.camera, then: null };
  }
  cancelCalibration() {
    this.client?.cancelCapture();
    this.cal = null;
  }
  /** Stop the worker and free the engine without touching stored calibrations. */
  forgetCalibrationSilently() {
    this.session?.dispose();
    this.session = null;
    this.client?.terminate();
    this.client = null;
  }
  forgetCalibration() {
    try {
      localStorage.removeItem("st-camera");
      localStorage.removeItem("st-tool");
    } catch {}
    this.session?.dispose();
    this.session = null;
    this.client?.terminate();
    this.client = null;
  }
  private stepCalibration(t: number) {
    const c = this.cal, s = this.session;
    if (!c || !s || !this.client || t < c.until || this.ending) return;
    this.ending = true;
    this.client.endCapture(s.tool).then((r) => {
      this.ending = false;
      this.finishStep(c, s, r, performance.now() / 1000);
    });
  }
  private finishStep(c: NonNullable<BrowserNav["cal"]>, s: NavSession, r0: CaptureResult, t: number) {
    const r = s.applyCapture(r0);
    if ("camera" in r) this.client?.setCamera(r.camera, true);
    if ("error" in r) {
      this.onMessage(r.error.toUpperCase());
      this.cal = null;
      return;
    }
    if ("camera" in r) {
      if (!this.ephemeral) save("st-camera", this.size, r.camera);
      this.onMessage(`LENS OK · ${r.views} VIEWS · ${r.rms.toFixed(2)} PX`);
    }
    if ("tipCam" in r) this.onMessage(`TIP OK · ${r.rmsMm.toFixed(2)} MM`);
    if ("axisCam" in r) {
      if (!this.ephemeral) save("st-tool", this.size, s.tool);
      this.onMessage("DOCK CALIBRATED");
    }
    if (c.then) {
      this.client?.beginCapture(c.then);
      this.cal = { step: c.then, t0: t, until: t + CAL_SECONDS[c.then], then: null };
    } else this.cal = null;
  }
}

function load<T>(key: string, w: number, h: number, rescale: (v: T, k: number) => T): T | null {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "null") as Stored<T> | null;
    if (!s || s.v !== 1) return null;
    const k = w / s.width;
    if (Math.abs(h / s.height - k) > 0.01) return null;
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
