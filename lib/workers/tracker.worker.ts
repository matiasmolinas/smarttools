// Tracker thread: detection, sub-pixel corners, undistortion and the robust pose solve run here, off
// the main thread, which keeps the engine clock and rendering smooth. In: camera frames (ImageBitmap)
// or simulated tool poses. Out: tracker results with their capture time (docs/ENGINE_SPEC.md §11).

import { AR } from "../aruco";
import { DICTIONARY } from "../board";
import { NavCore, type Camera, type ToolCalib } from "../engine";
import { MarkerTracker, type CaptureKind } from "../markertracker";
import { renderTool, DEFAULT_DISTURBANCE, type Rig } from "../scene";
import type { Xf } from "../xform";

export type ToWorker =
  | { type: "init"; camera: Camera; cameraCalibrated: boolean; maxSide: number }
  | { type: "frame"; bitmap: ImageBitmap; tCapture: number }
  | { type: "sim"; rig: Rig; codes: Uint8Array; toolW: Xf; tCapture: number; seed: number }
  | { type: "setCamera"; camera: Camera; calibrated: boolean }
  | { type: "beginCapture"; kind: CaptureKind }
  | { type: "cancelCapture" }
  | { type: "endCapture"; tool: ToolCalib; id: number };

let core: NavCore | null = null;
let tracker: MarkerTracker | null = null;
let maxSide = 960;
let canvas: OffscreenCanvas | null = null;
const ready = NavCore.load().then((c) => (core = c));

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  await ready;
  const m = e.data;
  if (m.type === "init") {
    tracker = new MarkerTracker(core!, new AR.Detector({ dictionaryName: DICTIONARY }), m.camera, m.cameraCalibrated);
    maxSide = m.maxSide;
    post({ type: "ready" });
    return;
  }
  if (!tracker || !core) return;
  switch (m.type) {
    case "frame": {
      const b = m.bitmap;
      const ds = Math.min(1, maxSide / Math.max(b.width, b.height));
      const w = Math.round(b.width * ds), h = Math.round(b.height * ds);
      if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(b, 0, 0, w, h);
      b.close();
      const f = tracker.frame(ctx.getImageData(0, 0, w, h), m.tCapture);
      post({ type: "result", frame: f, width: w, height: h, scale: 1 / ds });
      break;
    }
    case "sim": {
      const img = renderTool(core, m.rig, m.codes, [m.toolW], { ...DEFAULT_DISTURBANCE, blurSamples: 1 }, m.seed, { ss: 1 });
      const f = tracker.frame(img, m.tCapture);
      const pixels = img.data.buffer as ArrayBuffer;
      post({ type: "result", frame: f, width: img.width, height: img.height, scale: 1, pixels }, [pixels]);
      break;
    }
    case "setCamera":
      tracker.setCamera(m.camera, m.calibrated);
      break;
    case "beginCapture":
      tracker.beginCapture(m.kind);
      break;
    case "cancelCapture":
      tracker.cancelCapture();
      break;
    case "endCapture":
      post({ type: "captured", id: m.id, result: tracker.endCapture(m.tool) });
      break;
  }
};
