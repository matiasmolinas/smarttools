// Tracker thread: detection, sub-pixel corners, undistortion and the robust pose solve run here, off
// the main thread, which keeps the engine clock and rendering smooth. In: camera frames (ImageBitmap)
// or simulated tool poses. Out: tracker results with their capture time (docs/ENGINE_SPEC.md §11).

import { AR } from "../aruco";
import { DICTIONARY, sheetOf } from "../board";
import { NavCore, type Camera, type SheetSpec, type SolidSpec, type ToolCalib } from "../engine";
import { MarkerTracker, type CaptureKind } from "../markertracker";
import { renderTool, DEFAULT_DISTURBANCE, markerCodes, type Rig } from "../scene";
import { compareDetections, makeDetector, type DetectorKind } from "../detectors";
import type { Xf } from "../xform";
import type { TableMap } from "../tablemap";

export type ToWorker =
  | { type: "init"; camera: Camera; cameraCalibrated: boolean; maxSide: number; detector?: DetectorKind; compare?: boolean }
  | { type: "setDetector"; detector: DetectorKind; compare: boolean }
  | { type: "record"; frames: number; id: number }
  | { type: "cancelRecord" }
  | { type: "frame"; bitmap: ImageBitmap; tCapture: number; srcWidth: number; bitmapMs: number }
  | { type: "setMaxSide"; maxSide: number }
  | { type: "sim"; rig: Rig; codes: Uint8Array; toolW: Xf; tCapture: number; seed: number; solids?: SolidSpec[]; sheets?: SheetSpec[] }
  | { type: "setCamera"; camera: Camera; calibrated: boolean }
  | { type: "setTableMap"; map: TableMap }
  | { type: "beginCapture"; kind: CaptureKind }
  | { type: "cancelCapture" }
  | { type: "endCapture"; tool: ToolCalib; id: number };

let core: NavCore | null = null;
let tracker: MarkerTracker | null = null;
let maxSide = 960;
let canvas: OffscreenCanvas | null = null;
let detectorKind: DetectorKind = "js";
let compare = false;
let altDet: { kind: DetectorKind; det: ReturnType<typeof makeDetector> } | null = null;
// a recording in progress: frames left, and the JPEGs (encoded as the frames are analysed)
let rec: { id: number; left: number; times: number[]; jpegs: Promise<ArrayBuffer>[] } | null = null;
/** Compare mode: run the other detector on the same frame and note its time, markers and corner distance. */
function compareOn(img: { width: number; height: number; data: Uint8ClampedArray }, f: ReturnType<MarkerTracker["frame"]>) {
  if (!compare || !tracker || !core) return;
  const other: DetectorKind = detectorKind === "js" ? "rust" : "js";
  if (!altDet || altDet.kind !== other) altDet = { kind: other, det: makeDetector(other, core, (codes ??= markerCodes(new AR.Dictionary(DICTIONARY).codeList))) };
  const t0 = performance.now();
  const alt = sheetIds(altDet.det.detect(img));
  const altMs = performance.now() - t0;
  const c = compareDetections(sheetIds(tracker.detectRaw(img)), alt);
  f.timings = { ...f.timings!, alt: { kind: other, detectMs: altMs, markers: alt.length, shared: c.shared, meanCornerPx: c.meanCornerPx } };
}

function recordFrame(img: ImageData, t: number) {
  if (!rec) return;
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext("2d")!.putImageData(img, 0, 0);
  rec.times.push(t);
  rec.jpegs.push(c.convertToBlob({ type: "image/jpeg", quality: 0.92 }).then((b) => b.arrayBuffer()));
  if (--rec.left <= 0) {
    const r = rec;
    rec = null;
    Promise.all(r.jpegs).then((frames) => post({ type: "recorded", id: r.id, times: r.times, frames, width: img.width, height: img.height }, frames));
  }
}
let codes: Uint8Array | null = null;
const sheetIds = (l: { id: number; corners: { x: number; y: number }[] }[]) => l.filter((m) => sheetOf(m.id) != null);
function useDetector(kind: DetectorKind) {
  detectorKind = kind;
  codes ??= markerCodes(new AR.Dictionary(DICTIONARY).codeList);
  tracker?.setDetector(makeDetector(kind, core!, codes));
}
const ready = NavCore.load().then((c) => (core = c));
// never fail silently: a worker error otherwise leaves the screen black with nothing in the console
ready.catch((e) => post({ type: "fatal", message: `engine failed to load: ${e?.message ?? e}` }));

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  try {
    await handle(e);
  } catch (err) {
    post({ type: "fatal", message: `tracker worker: ${(err as Error)?.message ?? err}` });
  }
};

async function handle(e: MessageEvent<ToWorker>) {
  await ready;
  const m = e.data;
  if (m.type === "init") {
    tracker = new MarkerTracker(core!, new AR.Detector({ dictionaryName: DICTIONARY }), m.camera, m.cameraCalibrated);
    maxSide = m.maxSide;
    useDetector(m.detector ?? "js");
    compare = !!m.compare;
    post({ type: "ready" });
    return;
  }
  if (!tracker || !core) return;
  switch (m.type) {
    case "frame": {
      // the bitmap usually arrives already scaled down to the detection size (createImageBitmap's resize)
      const t0 = performance.now();
      const b = m.bitmap;
      const ds = Math.min(1, maxSide / Math.max(b.width, b.height));
      const w = Math.round(b.width * ds), h = Math.round(b.height * ds);
      if (!canvas || canvas.width !== w || canvas.height !== h) canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(b, 0, 0, w, h);
      b.close();
      const img = ctx.getImageData(0, 0, w, h);
      const drawMs = performance.now() - t0;
      const f = tracker.frame(img, m.tCapture);
      f.timings = { ...f.timings!, drawMs, bitmapMs: m.bitmapMs };
      recordFrame(img, m.tCapture);
      compareOn(img, f);
      // frame px -> source (video) px
      post({ type: "result", frame: f, width: w, height: h, scale: m.srcWidth / w });
      break;
    }
    case "setMaxSide":
      maxSide = m.maxSide;
      break;
    case "record":
      rec = { id: m.id, left: m.frames, times: [], jpegs: [] };
      break;
    case "cancelRecord":
      rec = null;
      break;
    case "setDetector":
      useDetector(m.detector);
      compare = m.compare;
      break;
    case "sim": {
      const img = renderTool(core, m.rig, m.codes, [m.toolW], { ...DEFAULT_DISTURBANCE, blurSamples: 1 }, m.seed, { ss: 1, solids: m.solids, sheets: m.sheets });
      const f = tracker.frame(img, m.tCapture);
      compareOn(img, f);
      if (rec) recordFrame(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), m.tCapture);
      const pixels = img.data.buffer as ArrayBuffer;
      post({ type: "result", frame: f, width: img.width, height: img.height, scale: 1, pixels }, [pixels]);
      break;
    }
    case "setCamera":
      tracker.setCamera(m.camera, m.calibrated);
      break;
    case "setTableMap":
      tracker.setTableMap(m.map);
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
}
