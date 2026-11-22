// The two marker detectors, behind the same interface (markertracker.Detector):
//   "js"    js-aruco2, the default (what the app has always used)
//   "rust"  engine/src/detect.rs compiled to WebAssembly: ~3× faster in the tests, no false or duplicate ids
// "compare" runs both on the same frame (the tracker uses the one chosen) and reports the difference, so the
// two can be judged side by side on a real phone.

import { AR } from "./aruco.ts";
import { DICTIONARY } from "./board.ts";
import type { NavCore } from "./engine.ts";
import type { Detector, Rgba } from "./markertracker.ts";

export type DetectorKind = "js" | "rust";
export const DETECTORS: DetectorKind[] = ["js", "rust"];

/** The sheet's markers are ids 0..27; anything else a detector reports is a false detection. */
type Found = { id: number; corners: { x: number; y: number }[] };

export class RustDetector implements Detector {
  private core: NavCore;
  private codes: Uint8Array;
  constructor(core: NavCore, codes: Uint8Array) {
    this.core = core;
    this.codes = codes;
  }
  detect(img: Rgba): Found[] {
    return this.core.detectMarkers(img, this.codes).map(({ id, corners }) => ({ id, corners }));
  }
}

export function makeDetector(kind: DetectorKind, core: NavCore, codes: Uint8Array): Detector {
  return kind === "rust" ? new RustDetector(core, codes) : new AR.Detector({ dictionaryName: DICTIONARY });
}

/** How two detections of one frame differ: markers only one found, and corner distance on shared ids. */
export function compareDetections(a0: Found[], b0: Found[]) {
  // one marker per id (js-aruco2 can report an id twice: a false small copy)
  const once = (l: Found[]) => [...new Map(l.map((m) => [m.id, m] as const)).values()];
  const a = once(a0), b = once(b0);
  const bm = new Map(b.map((m) => [m.id, m]));
  let shared = 0, sum = 0, max = 0;
  for (const m of a) {
    const o = bm.get(m.id);
    if (!o) continue;
    shared++;
    for (let k = 0; k < 4; k++) {
      const d = Math.hypot(m.corners[k].x - o.corners[k].x, m.corners[k].y - o.corners[k].y);
      sum += d;
      max = Math.max(max, d);
    }
  }
  return { a: a.length, b: b.length, shared, meanCornerPx: shared ? sum / (shared * 4) : 0, maxCornerPx: max };
}
