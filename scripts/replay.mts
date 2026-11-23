// Replay a camera recording made on the phone (Tests → record camera 10 s) through the tracker, with either
// marker detector or both, and report what each found: markers per frame, frames with a pose, reprojection
// error, time per frame, and how steady the pose is (useful when the drill was held still).
//
// Run: node --no-warnings scripts/replay.mts <file.strec> [--detector js|rust|both] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import jpeg from "jpeg-js";
import { NavCore } from "../lib/engine.ts";
import { MarkerTracker } from "../lib/markertracker.ts";
import { RustDetector, compareDetections, type DetectorKind } from "../lib/detectors.ts";
import { markerCodes } from "../lib/scene.ts";
import { decodeRecording } from "../lib/recording.ts";
import { toolLocal } from "../lib/scenedef.ts";
import { applyDir, compose, fromPose, inverse } from "../lib/xform.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node --no-warnings scripts/replay.mts <file.strec> [--detector js|rust|both] [--json out.json]");
  process.exit(1);
}
const which = args.includes("--detector") ? args[args.indexOf("--detector") + 1] : "both";
const jsonOut = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const core = await NavCore.load(readFileSync(new URL("../public/engine/nav_core.wasm", import.meta.url)));
const codes = markerCodes(new AR.Dictionary("ARUCO_MIP_36h12").codeList);
const { header: h, frames } = decodeRecording(new Uint8Array(readFileSync(file)));
console.log(`${file}: ${frames.length} frames ${h.width}×${h.height} · ${h.phone.name} · lens ${h.cameraCalibrated ? "calibrated" : "not calibrated"} · tool ${h.toolCalibrated ? "calibrated" : "not calibrated"} · recorded with ${h.detector}${h.notes ? ` · ${h.notes}` : ""}`);

const images = frames.map((f) => {
  const d = jpeg.decode(f, { useTArray: true, formatAsRGBA: true });
  return { width: d.width, height: d.height, data: new Uint8ClampedArray(d.data.buffer, d.data.byteOffset, d.data.byteLength) };
});

const kinds: DetectorKind[] = which === "both" ? ["js", "rust"] : [which as DetectorKind];
const report: Record<string, unknown> = { file, frames: frames.length, header: { ...h, times: undefined } };
const raw: Record<string, { id: number; corners: { x: number; y: number }[] }[][]> = {};

for (const kind of kinds) {
  const det = kind === "rust" ? new RustDetector(core, codes) : new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" });
  const tr = new MarkerTracker(core, det, h.camera, true);
  const ms: number[] = [], markers: number[] = [], rms: number[] = [];
  const tips: number[][] = [], axes: number[][] = [];
  raw[kind] = [];
  images.forEach((img, i) => {
    raw[kind].push(det.detect(img).filter((m: { id: number }) => m.id < 28));
    const t0 = performance.now();
    const f = tr.frame(img, h.times[i] ?? i / 30);
    ms.push(performance.now() - t0);
    markers.push(f.markers);
    if (!f.pose) return;
    rms.push(f.rmsPx);
    const tool = compose(inverse(fromPose(f.pose)), toolLocal(h.tool));
    tips.push(tool.p.map((v) => v * 1000));
    axes.push(applyDir(tool, [0, 0, 1]));
  });
  const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : NaN);
  // steadiness: RMS around the mean (meaningful when the drill was held still)
  const mean = (a: number[][]) => [0, 1, 2].map((k) => a.reduce((s, v) => s + v[k], 0) / a.length);
  const mt = mean(tips), ma = mean(axes);
  const ml = Math.hypot(ma[0], ma[1], ma[2]);
  const tipRms = Math.sqrt(tips.reduce((s, t) => s + (t[0] - mt[0]) ** 2 + (t[1] - mt[1]) ** 2 + (t[2] - mt[2]) ** 2, 0) / Math.max(1, tips.length));
  const angRms = Math.sqrt(axes.reduce((s, a) => s + Math.acos(Math.min(1, (a[0] * ma[0] + a[1] * ma[1] + a[2] * ma[2]) / ml)) ** 2, 0) / Math.max(1, axes.length)) * (180 / Math.PI);
  const r = {
    framesWithPose: `${tips.length}/${images.length}`,
    markersMedian: med(markers),
    rmsPxMedian: +med(rms).toFixed(3),
    msPerFrameMedian: +med(ms).toFixed(2),
    tipSteadinessMm: +tipRms.toFixed(3),
    angleSteadinessDeg: +angRms.toFixed(3),
  };
  report[kind] = r;
  console.log(`${kind.padEnd(4)} pose on ${r.framesWithPose} frames · ${r.markersMedian} markers · ${r.rmsPxMedian} px reprojection · ${r.msPerFrameMedian} ms/frame · steadiness: tip ${r.tipSteadinessMm} mm, angle ${r.angleSteadinessDeg}° RMS`);
}

if (kinds.length === 2) {
  let shared = 0, sum = 0, max = 0, onlyJs = 0, onlyRust = 0;
  raw.js.forEach((j, i) => {
    const c = compareDetections(j, raw.rust[i]);
    shared += c.shared;
    sum += c.meanCornerPx * c.shared;
    max = Math.max(max, c.maxCornerPx);
    onlyJs += c.a - c.shared;
    onlyRust += c.b - c.shared;
  });
  report.compare = { shared, onlyJs, onlyRust, meanCornerPx: shared ? sum / shared : 0, maxCornerPx: max };
  console.log(`both found ${shared} markers · only js ${onlyJs} · only rust ${onlyRust} · raw corner difference mean ${(shared ? sum / shared : 0).toFixed(2)} px, max ${max.toFixed(2)} px`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
