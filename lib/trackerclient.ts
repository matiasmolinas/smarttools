// Main-thread side of the tracker worker: sends frames (one in flight at a time; newer frames are
// dropped while the worker is busy) and receives tracker results with their capture times.

import type { Camera, SheetSpec, SolidSpec, ToolCalib } from "./engine";
import type { CaptureKind, CaptureResult, TrackerFrame } from "./markertracker";
import type { Rig } from "./scene";
import type { Xf } from "./xform";
import type { ToWorker } from "./workers/tracker.worker";
import type { DetectorKind } from "./detectors";
import type { TableMap } from "./tablemap";

export interface WorkerResult {
  frame: TrackerFrame;
  width: number;
  height: number;
  /** frame px -> source px */
  scale: number;
  /** the rendered RGBA image (simulation only) */
  pixels?: ArrayBuffer;
}

function scaleWhileCopying(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes("Macintosh") && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1);
  return !ios && /Chrome\/|Chromium\//.test(ua);
}

/** What a pending calibration gets when the tracker stops before it answers. */
export const TRACKER_STOPPED = "the tracker stopped: try again";

/** Calibrations waiting for the worker's answer, with their kind, so each one can be settled even if the worker
 * dies: a promise that never settles would block every later calibration. */
export class CaptureWaits {
  private m = new Map<number, { kind: CaptureKind; res: (r: CaptureResult) => void }>();
  get size() {
    return this.m.size;
  }
  add(id: number, kind: CaptureKind, res: (r: CaptureResult) => void) {
    this.m.set(id, { kind, res });
  }
  /** The worker answered: settle that wait (false if it is not pending). */
  settle(id: number, r: CaptureResult): boolean {
    const w = this.m.get(id);
    if (!w) return false;
    this.m.delete(id);
    w.res(r);
    return true;
  }
  /** Settle every pending wait with an error of its own kind. Returns how many there were. */
  failAll(error: string): number {
    const all = [...this.m.values()];
    this.m.clear();
    for (const w of all) w.res({ kind: w.kind, error });
    return all.length;
  }
}

/** What the worker sends back for a recording. */
export interface RecordedFrames {
  times: number[];
  frames: ArrayBuffer[];
  width: number;
  height: number;
}

/** The one recording waiting for the worker. It always settles: with the frames, or with null when it is cancelled,
 * replaced by a newer one, or the tracker stops. A late answer for an old recording is ignored. */
export class RecordWait {
  private w: { id: number; res: (r: RecordedFrames | null) => void } | null = null;
  get pending() {
    return this.w !== null;
  }
  /** Wait for recording `id` (a recording still waiting is settled with null first). */
  start(id: number, res: (r: RecordedFrames | null) => void) {
    this.cancel();
    this.w = { id, res };
  }
  /** The worker sent recording `id`: settle it (false if it is not the one waiting). */
  done(id: number, r: RecordedFrames): boolean {
    if (!this.w || this.w.id !== id) return false;
    const w = this.w;
    this.w = null;
    w.res(r);
    return true;
  }
  /** Settle the waiting recording with null. False if none was waiting. */
  cancel(): boolean {
    const w = this.w;
    if (!w) return false;
    this.w = null;
    w.res(null);
    return true;
  }
}

export class TrackerClient {
  private w: Worker;
  private busy = false;
  private nextId = 1;
  private waits = new CaptureWaits();
  /** the capture running in the worker (its kind goes with the wait for its result) */
  private capturing: CaptureKind | null = null;
  private stopped = false;
  private faulted = false;
  readyPromise: Promise<void>;
  onResult: (r: WorkerResult) => void = () => {};
  /** The worker failed for good (engine error, or its script did not load). Not called after terminate(). */
  onFatal: (message: string) => void = () => {};
  private recWait = new RecordWait();
  /** frames sent / dropped because the worker was busy */
  sent = 0;
  dropped = 0;

  private maxSide: number;
  /** createImageBitmap can scale while it copies. Only on Chromium (desktop and Android): Safari (and every iOS
   * browser, which runs WebKit) returns the frame scaled into a corner of the bitmap, which silently puts every
   * detection in the wrong place. Elsewhere the worker scales the full frame. */
  private resizeOk: boolean | null = scaleWhileCopying() ? null : false;

  constructor(camera: Camera, cameraCalibrated: boolean, maxSide = 960, detector: DetectorKind = "js", compare = false) {
    this.maxSide = maxSide;
    this.w = new Worker(new URL("./workers/tracker.worker.ts", import.meta.url), { type: "module" });
    let resolveReady!: () => void;
    this.readyPromise = new Promise((r) => (resolveReady = r));
    this.w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "ready") resolveReady();
      if (m.type === "fatal") this.fail(String(m.message ?? "the tracker failed"));
      if (m.type === "result") {
        this.busy = false;
        this.onResult(m as WorkerResult);
      }
      if (m.type === "recorded") this.recWait.done(m.id, m as RecordedFrames);
      if (m.type === "captured") {
        this.waits.settle(m.id, m.result);
      }
    };
    // the worker script failed to load or threw outside a message, or a message could not be read
    this.w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      this.fail(e.message || "the tracker did not load");
    };
    this.w.onmessageerror = () => this.fail("the tracker could not read a message");
    this.send({ type: "init", camera, cameraCalibrated, maxSide, detector, compare });
  }

  /** A fatal worker error: log it, settle every pending calibration and recording, and tell the page once. */
  private fail(message: string) {
    console.error(`[SmartTools] ${message}`);
    this.busy = false;
    this.waits.failAll(TRACKER_STOPPED);
    this.recWait.cancel();
    if (this.stopped || this.faulted) return;
    this.faulted = true;
    this.onFatal(message);
  }

  private send(m: ToWorker, transfer: Transferable[] = []) {
    this.w.postMessage(m, transfer);
  }

  get idle() {
    return !this.busy;
  }

  /** A camera frame (video or canvas) captured at tCapture. Returns false if dropped. */
  async frame(source: CanvasImageSource, tCapture: number): Promise<boolean> {
    if (this.busy) {
      this.dropped++;
      return false;
    }
    this.busy = true;
    try {
      const v = source as HTMLVideoElement & HTMLCanvasElement;
      const sw = v.videoWidth || v.width, sh = v.videoHeight || v.height;
      const ds = Math.min(1, this.maxSide / Math.max(sw, sh));
      const t0 = performance.now();
      let bitmap: ImageBitmap | null = null;
      if (ds < 1 && this.resizeOk !== false) {
        try {
          bitmap = await createImageBitmap(source as ImageBitmapSource, { resizeWidth: Math.round(sw * ds), resizeHeight: Math.round(sh * ds), resizeQuality: "medium" });
          this.resizeOk = bitmap.width === Math.round(sw * ds);
          if (!this.resizeOk) {
            bitmap.close();
            bitmap = null;
          }
        } catch {
          this.resizeOk = false;
        }
      }
      bitmap ??= await createImageBitmap(source as ImageBitmapSource);
      const bitmapMs = performance.now() - t0;
      this.send({ type: "frame", bitmap, tCapture, srcWidth: sw, bitmapMs }, [bitmap]);
      this.sent++;
      return true;
    } catch {
      this.busy = false;
      return false;
    }
  }

  /** Record the next `frames` analysed frames (JPEG at the detection size) with their capture times. Null when
   * cancelled (cancelRecord, a newer recording, or the tracker stopped). */
  record(frames: number): Promise<RecordedFrames | null> {
    if (this.stopped || this.faulted) return Promise.resolve(null);
    const id = this.nextId++;
    return new Promise((res) => {
      this.recWait.start(id, res);
      this.send({ type: "record", frames, id });
    });
  }
  /** Stop the recording in progress: its promise resolves null. */
  cancelRecord() {
    if (this.recWait.cancel() && !this.stopped) this.send({ type: "cancelRecord" });
  }

  /** Which marker detector the worker uses, and whether it also runs the other one to compare. */
  setDetector(detector: DetectorKind, compare: boolean) {
    this.send({ type: "setDetector", detector, compare });
  }

  /** The detection resolution (longest side, px). */
  setMaxSide(maxSide: number) {
    this.maxSide = maxSide;
    this.send({ type: "setMaxSide", maxSide });
  }

  /** A simulated frame: the worker renders the camera view for the tool pose and tracks it (with parts in the scene,
   * and a table of several sheets instead of sheet 0 alone). */
  sim(rig: Rig, codes: Uint8Array, toolW: Xf, tCapture: number, seed: number, solids?: SolidSpec[], sheets?: SheetSpec[]): boolean {
    if (this.busy) {
      this.dropped++;
      return false;
    }
    this.busy = true;
    this.send({ type: "sim", rig, codes, toolW, tCapture, seed, solids, sheets });
    this.sent++;
    return true;
  }

  setCamera(camera: Camera, calibrated: boolean) {
    this.send({ type: "setCamera", camera, calibrated });
  }
  /** The table map the worker's tracker solves with (lib/tablemap.ts); results carry each frame's sheets. */
  setTableMap(map: TableMap) {
    this.send({ type: "setTableMap", map });
  }
  beginCapture(kind: CaptureKind) {
    this.capturing = kind;
    this.send({ type: "beginCapture", kind });
  }
  cancelCapture() {
    this.capturing = null;
    this.send({ type: "cancelCapture" });
  }
  endCapture(tool: ToolCalib): Promise<CaptureResult> {
    const kind = this.capturing ?? "pivot";
    this.capturing = null;
    if (this.stopped) return Promise.resolve({ kind, error: TRACKER_STOPPED });
    const id = this.nextId++;
    return new Promise((res) => {
      this.waits.add(id, kind, res);
      this.send({ type: "endCapture", tool, id });
    });
  }

  /** Stop the worker. A calibration still waiting for it gets an error, a recording null, instead of waiting forever. */
  terminate() {
    this.stopped = true;
    this.w.terminate();
    this.waits.failAll(TRACKER_STOPPED);
    this.recWait.cancel();
  }
}
