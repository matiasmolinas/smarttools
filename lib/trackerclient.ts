// Main-thread side of the tracker worker: sends frames (one in flight at a time; newer frames are
// dropped while the worker is busy) and receives tracker results with their capture times.

import type { Camera, ToolCalib } from "./engine";
import type { CaptureKind, CaptureResult, TrackerFrame } from "./markertracker";
import type { Rig } from "./scene";
import type { Xf } from "./xform";
import type { ToWorker } from "./workers/tracker.worker";

export interface WorkerResult {
  frame: TrackerFrame;
  width: number;
  height: number;
  /** frame px -> source px */
  scale: number;
  /** the rendered RGBA image (simulation only) */
  pixels?: ArrayBuffer;
}

export class TrackerClient {
  private w: Worker;
  private busy = false;
  private nextId = 1;
  private waits = new Map<number, (r: CaptureResult) => void>();
  readyPromise: Promise<void>;
  onResult: (r: WorkerResult) => void = () => {};
  /** frames sent / dropped because the worker was busy */
  sent = 0;
  dropped = 0;

  private maxSide: number;
  /** createImageBitmap can scale while it copies (Chrome; not every browser): tried once, then remembered */
  private resizeOk: boolean | null = null;

  constructor(camera: Camera, cameraCalibrated: boolean, maxSide = 960) {
    this.maxSide = maxSide;
    this.w = new Worker(new URL("./workers/tracker.worker.ts", import.meta.url), { type: "module" });
    let resolveReady!: () => void;
    this.readyPromise = new Promise((r) => (resolveReady = r));
    this.w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "ready") resolveReady();
      if (m.type === "result") {
        this.busy = false;
        this.onResult(m as WorkerResult);
      }
      if (m.type === "captured") {
        this.waits.get(m.id)?.(m.result);
        this.waits.delete(m.id);
      }
    };
    this.send({ type: "init", camera, cameraCalibrated, maxSide });
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

  /** The detection resolution (longest side, px). */
  setMaxSide(maxSide: number) {
    this.maxSide = maxSide;
    this.send({ type: "setMaxSide", maxSide });
  }

  /** A simulated frame: the worker renders the camera view for the tool pose and tracks it. */
  sim(rig: Rig, codes: Uint8Array, toolW: Xf, tCapture: number, seed: number): boolean {
    if (this.busy) {
      this.dropped++;
      return false;
    }
    this.busy = true;
    this.send({ type: "sim", rig, codes, toolW, tCapture, seed });
    this.sent++;
    return true;
  }

  setCamera(camera: Camera, calibrated: boolean) {
    this.send({ type: "setCamera", camera, calibrated });
  }
  beginCapture(kind: CaptureKind) {
    this.send({ type: "beginCapture", kind });
  }
  cancelCapture() {
    this.send({ type: "cancelCapture" });
  }
  endCapture(tool: ToolCalib): Promise<CaptureResult> {
    const id = this.nextId++;
    return new Promise((res) => {
      this.waits.set(id, res);
      this.send({ type: "endCapture", tool, id });
    });
  }

  terminate() {
    this.w.terminate();
  }
}
