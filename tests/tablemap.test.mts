// The table map (lib/tablemap.ts, lib/board.ts sheets): placements, storage, one frame of the table, learning the
// map from synthetic frames of four sheets, the flatness and moved checks, and the tracker's wiring
// (lib/markertracker.ts: markers on parts win, lens captures keep sheet 0).

import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mts";
import { BOARD_MARKERS, MARKERS_PER_SHEET, SHEET, SHEETS, markerCorners, sheetMarkerCorners, sheetMarkerIds, sheetOf, sheetOutline } from "../lib/board.ts";
import {
  MAP_MIN_OBS, MIN_MARKER_SIDE_PX, MOVED_MIN_MARKERS, MOVED_S, SHEET0_ONLY, SheetMapper, emptyMap, mappedSheets, placePoint, placementFromPoses, readTableMap,
  reprojOutliers, screenDetections, shortestSide, solveTable, summarize, worldCorners,
  type Placement, type SheetObs, type SheetView, type SolvePose, type TableMap,
} from "../lib/tablemap.ts";
import { MarkerTracker, type Detector } from "../lib/markertracker.ts";
import { BASE_STICKERS } from "../lib/assembly.ts";
import { bodyIds } from "../lib/anchors.ts";
import { pinhole, type NavCore } from "../lib/engine.ts";
import { compose, fromPose, inverse, qaxis, qmul, toPose, xf } from "../lib/xform.ts";
import type { Intrinsics, Pose, V3 } from "../lib/pose.ts";

type P = { x: number; y: number };
const AT = "2026-11-24T10:00:00.000Z";
const D = Math.PI / 180;

// ---------------- the sheets on the board ----------------

test("sheets: ids, local corners, outline", () => {
  assert.equal(SHEETS, 4);
  assert.equal(MARKERS_PER_SHEET, 28);
  assert.equal(sheetOf(0), 0);
  assert.equal(sheetOf(27), 0);
  assert.equal(sheetOf(28), 1);
  assert.equal(sheetOf(111), 3);
  assert.equal(sheetOf(112), null);
  assert.equal(sheetOf(-1), null);
  assert.equal(sheetOf(3.5), null);
  assert.deepEqual(sheetMarkerIds(2).slice(0, 3), [56, 57, 58]);
  assert.equal(sheetMarkerIds(3).length, BOARD_MARKERS.length);
  // a marker of any sheet sits where the same marker of sheet 0 does, on its own sheet
  assert.deepEqual(sheetMarkerCorners(28 * 3 + 5), markerCorners(5));
  assert.deepEqual(sheetMarkerCorners(7), markerCorners(7));
  assert.equal(sheetMarkerCorners(200), null);
  // markerCorners keeps its meaning: sheet 0 only
  assert.equal(markerCorners(30), null);
  const o = sheetOutline();
  assert.deepEqual(o[0], { x: -SHEET.w / 2, y: -SHEET.h / 2 });
  assert.deepEqual(o[2], { x: SHEET.w / 2, y: SHEET.h / 2 });
});

test("the demo part's sticker ids overlap sheets 2 and 3 (ids 40..65): known, and a body's ids win in the tracker", () => {
  const ids = [...bodyIds([{ name: "base", stickers: BASE_STICKERS }])];
  assert.ok(ids.every((id) => sheetOf(id) !== 0), "never on sheet 0");
  assert.deepEqual([...new Set(ids.map((id) => sheetOf(id)))].sort(), [1, 2]);
});

// ---------------- the map ----------------

test("emptyMap, readTableMap: sheet 0 forced to the origin, bad data refused", () => {
  const m = emptyMap(AT);
  assert.deepEqual(m, { v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, null, null, null], at: AT });
  assert.deepEqual(readTableMap(JSON.parse(JSON.stringify(m))), m);
  const placed = { v: 1, sheets: [{ x: 1, y: 1, yaw: 1 }, { x: 0.216, y: 0, yaw: 0.02 }, null], at: AT };
  assert.deepEqual(readTableMap(placed), { v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, { x: 0.216, y: 0, yaw: 0.02 }, null, null], at: AT });
  assert.equal(readTableMap(null), null);
  assert.equal(readTableMap({ ...m, v: 2 }), null);
  assert.equal(readTableMap({ ...m, at: "yesterday" }), null);
  assert.equal(readTableMap({ ...m, sheets: [null, { x: 5, y: 0, yaw: 0 }] }), null);
  assert.equal(readTableMap({ ...m, sheets: [null, { x: 0, y: "1", yaw: 0 }] }), null);
  assert.equal(readTableMap({ ...m, sheets: [null, null, null, null, null] }), null);
  assert.deepEqual(mappedSheets(readTableMap(placed)!), [0, 1]);
});

test("placePoint, worldCorners: a sheet placed by x, y, yaw; null when not mapped", () => {
  const pl: Placement = { x: 0.2, y: 0.1, yaw: 90 * D };
  const p = placePoint(pl, { x: 0.01, y: 0 });
  assert.ok(Math.abs(p.x - 0.2) < 1e-12 && Math.abs(p.y - 0.11) < 1e-12);
  const map: TableMap = { v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, pl, null, null], at: AT };
  assert.deepEqual(worldCorners(map, 3), markerCorners(3));
  const wc = worldCorners(map, 28 + 3)!;
  markerCorners(3)!.forEach((c, i) => {
    const q = placePoint(pl, c);
    assert.ok(Math.abs(wc[i].x - q.x) < 1e-12 && Math.abs(wc[i].y - q.y) < 1e-12);
  });
  assert.equal(worldCorners(map, 56), null);
  assert.equal(worldCorners(map, 500), null);
});

// ---------------- synthetic camera ----------------

const K: Intrinsics = { f: 800, cx: 480, cy: 360 };
const W = 960, H = 720;
const solve: SolvePose = (w, i) => core.solvePoseRobust(w, i, K);

/** A camera at `c` (world, m) looking straight down, tilted by `tiltDeg` about a horizontal axis at `dirDeg`. */
function camPose(c: V3, tiltDeg: number, dirDeg: number, rollDeg = 0): Pose {
  const down = qmul(qaxis([0, 0, 1], rollDeg * D), qaxis([1, 0, 0], Math.PI));
  const q = qmul(qaxis([Math.cos(dirDeg * D), Math.sin(dirDeg * D), 0], tiltDeg * D), down);
  return toPose(inverse(xf(c, q)));
}
function rng(seed: number) {
  let s = seed >>> 0;
  const u = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296;
  return { u, g: () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()) };
}
/** The truth: where each sheet lies, and its height over the bench (a lifted sheet). */
type Truth = { pl: Placement; zM: number }[];
const TRUTH: Truth = [
  { pl: { x: 0, y: 0, yaw: 0 }, zM: 0 },
  { pl: { x: 0.2165, y: 0.0021, yaw: 1.5 * D }, zM: 0 },
  { pl: { x: -0.0012, y: 0.3034, yaw: -2 * D }, zM: 0 },
  { pl: { x: 0.2181, y: 0.3052, yaw: 0.8 * D }, zM: 0 },
];
function projectPt(pose: Pose, p: V3): P | null {
  const R = pose.R, t = pose.t;
  const x = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0];
  const y = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1];
  const z = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2];
  return z > 1e-6 ? { x: (K.f * x) / z + K.cx, y: (K.f * y) / z + K.cy } : null;
}
/** What the camera sees: every whole marker of every sheet inside the image, its corners with noise (px). */
function view(pose: Pose, truth: Truth, r: ReturnType<typeof rng>, noisePx = 0.3): { id: number; img: P[] }[] {
  const out: { id: number; img: P[] }[] = [];
  truth.forEach(({ pl, zM }, k) => {
    for (const id of sheetMarkerIds(k)) {
      const img = sheetMarkerCorners(id)!.map((c) => {
        const w = placePoint(pl, c);
        return projectPt(pose, [w.x, w.y, zM]);
      });
      if (img.some((q) => !q || q.x < 2 || q.y < 2 || q.x > W - 2 || q.y > H - 2)) continue;
      out.push({ id, img: (img as P[]).map((q) => ({ x: q.x + noisePx * r.g(), y: q.y + noisePx * r.g() })) });
    }
  });
  return out;
}
/** A sweep over the table: the camera 0.45..0.6 m up, around the middle of the four sheets, tilted up to 20°. */
function sweepPose(i: number, r: ReturnType<typeof rng>): Pose {
  const cx = 0.108 + 0.12 * Math.sin(i * 0.37), cy = 0.15 + 0.16 * Math.sin(i * 0.23 + 1);
  return camPose([cx + 0.01 * r.g(), cy + 0.01 * r.g(), 0.5 + 0.05 * Math.sin(i * 0.5)], 5 + 15 * Math.abs(Math.sin(i * 0.41)), (i * 47) % 360, 20 * Math.sin(i * 0.3));
}
/** Run frames at 15 Hz through solveTable and the mapper (the map given to the next frame as the tracker gets it). */
function run(mapper: SheetMapper, truth: Truth, frames: number, t0: number, seed: number, onFrame?: (f: ReturnType<typeof solveTable>, pose: Pose) => void) {
  const r = rng(seed);
  let t = t0;
  for (let i = 0; i < frames; i++, t += 1 / 15) {
    const pose = sweepPose(i + seed, r);
    const f = solveTable(mapper.map(), view(pose, truth, r), solve, K);
    mapper.feed(t, f.sheets);
    onFrame?.(f, pose);
  }
  return t;
}
const errOf = (a: Placement, b: Placement) => ({ mm: Math.hypot(a.x - b.x, a.y - b.y) * 1000, deg: Math.abs(a.yaw - b.yaw) / D });

// ---------------- one frame of the table ----------------

test("placementFromPoses: a sheet's placement, height and tilt from two poses of the same frame", () => {
  const cam = camPose([0.1, 0.12, 0.5], 12, 30, 10);
  // the sheet's pose: T_cam_sheet = T_cam_world · T_world_sheet, with the sheet lifted 3 mm and tilted 1° about x
  const sheetW = xf([0.2165, 0.0021, 0.003], qmul(qaxis([0, 0, 1], 1.5 * D), qaxis([1, 0, 0], 1 * D)));
  const camSheet = toPose(compose(fromPose(cam), sheetW));
  const p = placementFromPoses(cam, camSheet);
  assert.ok(Math.abs(p.x - 0.2165) < 1e-9 && Math.abs(p.y - 0.0021) < 1e-9, `x ${p.x} y ${p.y}`);
  assert.ok(Math.abs(p.zMm - 3) < 1e-6, `z ${p.zMm}`);
  assert.ok(Math.abs(p.tiltDeg - 1) < 1e-6, `tilt ${p.tiltDeg}`);
  assert.ok(Math.abs(p.yaw - 1.5 * D) < 1e-3 * D, `yaw ${p.yaw / D}`);
});

test("solveTable: a sheet not mapped never enters the world pose; it is solved on its own once", () => {
  const r = rng(5);
  const pose = camPose([0.108, 0.0, 0.5], 0, 0);
  const seen = view(pose, TRUTH, r);
  assert.ok(seen.some((m) => sheetOf(m.id) === 1) && seen.some((m) => sheetOf(m.id) === 0), "both sheets in view");
  let calls = 0;
  const counting: SolvePose = (w, i) => (calls++, solve(w, i));
  const f = solveTable(emptyMap(AT), seen, counting, K);
  assert.ok(f.pose && f.kept >= 6);
  assert.ok(f.used.every((i) => sheetOf(seen[i].id) === 0), "only sheet 0's markers in the pose");
  assert.equal(f.world.length, f.used.length * 4);
  const inView = new Set(seen.map((m) => sheetOf(m.id)));
  assert.equal(calls, inView.size, "once for the world, once per sheet not mapped in view");
  const s1 = f.sheets.find((v) => v.k === 1)!;
  assert.ok(s1.pose && s1.obs, "sheet 1 solved, with an observation");
  const e = errOf(s1.obs!, TRUTH[1].pl);
  assert.ok(e.mm < 1 && e.deg < 0.2, `one observation within ${e.mm.toFixed(2)} mm, ${e.deg.toFixed(3)}°`);
  assert.equal(f.sheets.find((v) => v.k === 0)!.obs, undefined);
  // only sheet 1 in view: no world pose, but its own pose for the outline (no observation)
  const only1 = solveTable(emptyMap(AT), seen.filter((m) => sheetOf(m.id) === 1), solve, K);
  assert.equal(only1.pose, null);
  assert.ok(only1.sheets[0].pose && !only1.sheets[0].obs);
  // with sheet 1 mapped, its markers join the pose and it gets a reprojection error instead (no extra solve)
  calls = 0;
  const map: TableMap = { v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, TRUTH[1].pl, null, null], at: AT };
  const g = solveTable(map, seen, counting, K);
  assert.ok(g.used.some((i) => sheetOf(seen[i].id) === 1));
  assert.equal(calls, 1 + [...inView].filter((k) => k! > 1).length);
  const v1 = g.sheets.find((v) => v.k === 1)!;
  assert.ok(v1.reprojPx! < 1, `reprojection ${v1.reprojPx}`);
  assert.equal(v1.pose, undefined);
});

test("solveTable's guard: a moved sheet is left out with one more solve; never sheet 0, never below 4 markers", () => {
  const shifted: Truth = TRUTH.map((s, k) => (k === 1 ? { ...s, pl: { ...s.pl, x: s.pl.x + 0.005 } } : s));
  const map: TableMap = { v: 1, sheets: TRUTH.map((s) => s.pl), at: AT };
  const pose = camPose([0.1, 0.02, 0.32], 8, 40);
  const seen = view(pose, shifted, rng(9));
  let calls = 0;
  const counting: SolvePose = (w, i) => (calls++, solve(w, i));
  const f = solveTable(map, seen, counting, K);
  assert.equal(calls, 2, "the first solve and one more");
  const v1 = f.sheets.find((v) => v.k === 1)!;
  assert.ok(v1.left && v1.reprojPx! > 3, `sheet 1 left out (${v1.reprojPx} px against the pose kept)`);
  assert.ok(f.used.every((i) => sheetOf(seen[i].id) !== 1), "its markers are not in the pose");
  assert.ok(!f.sheets.find((v) => v.k === 0)!.left);
  // the same frame with sheet 1 where the map has it: one solve, nothing left out
  calls = 0;
  const g = solveTable(map, view(pose, TRUTH, rng(9)), counting, K);
  assert.equal(calls, 1);
  assert.ok(g.sheets.every((v) => !v.left));
  // only 3 markers of sheet 0 besides the moved sheet: leaving it out would leave 3, so the first pose stands
  const few = seen.filter((m) => sheetOf(m.id) === 1 || [9, 10, 11].includes(m.id));
  assert.equal(few.filter((m) => sheetOf(m.id) === 0).length, 3, "three of sheet 0 in view");
  calls = 0;
  const h = solveTable(map, few, counting, K);
  assert.equal(calls, 1);
  assert.ok(h.sheets.every((v) => !v.left));
});

test("screenDetections: a quad under the minimum side is dropped, then every copy of an id seen twice", () => {
  const sq = (x: number, y: number, s: number, skew = 0): P[] => [{ x, y }, { x: x + s, y: y + skew }, { x: x + s, y: y + s }, { x, y: y + s }];
  assert.equal(MIN_MARKER_SIDE_PX, 20);
  assert.equal(shortestSide(sq(0, 0, 50)), 50);
  assert.ok(Math.abs(shortestSide([{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 12 }, { x: 0, y: 40 }]) - 12) < 1e-9);
  const dets = [
    { id: 3, corners: sq(0, 0, 60) },
    { id: 84, corners: sq(100, 0, 12) }, // a tiny false read: dropped
    { id: 22, corners: sq(200, 0, 72) },
    { id: 22, corners: sq(300, 0, 11) }, // a tiny false copy of a real id: the real one stays
    { id: 5, corners: sq(400, 0, 55) },
    { id: 5, corners: sq(500, 0, 58) }, // two real-sized copies: neither can be trusted
    { id: 7, corners: sq(600, 0, 20) }, // exactly the minimum: kept
  ];
  const r = screenDetections(dets);
  assert.deepEqual(r.kept.map((m) => m.id), [3, 22, 7]);
  assert.equal(r.kept[1], dets[2], "the detections themselves, in order");
  assert.equal(r.small, 2);
  assert.equal(r.dup, 2);
  assert.deepEqual(screenDetections(dets, 5).kept.map((m) => m.id), [3, 84, 7], "a smaller minimum lets the tiny ones through, and then 22 is a duplicate too");
  assert.deepEqual(screenDetections([]).kept, []);
});

test("reprojOutliers: far above the median and above the floor", () => {
  assert.deepEqual(reprojOutliers([0.3, 0.4, 0.35, 5, 0.3]), [false, false, false, true, false]);
  // 4× the median but under 3 px: kept (a sharp frame where every error is tiny)
  assert.deepEqual(reprojOutliers([0.2, 0.2, 0.2, 2.5]), [false, false, false, false]);
  // above 3 px but not 4× the median (a blurry frame): kept
  assert.deepEqual(reprojOutliers([3, 3.5, 4, 10]), [false, false, false, false]);
  assert.deepEqual(reprojOutliers([0.3, 0.3, Infinity]), [false, false, true]);
  assert.deepEqual(reprojOutliers([]), []);
});

test("solveTable: a false read with a valid id is left out by its own error, in the one extra solve", () => {
  const map: TableMap = { v: 1, sheets: TRUTH.map((s) => s.pl), at: AT };
  const pose = camPose([0.1, 0.02, 0.32], 8, 40);
  const r = rng(11);
  const seen = view(pose, TRUTH, r);
  // a sheet-3 id read where a real sheet-0 marker is (an all-black interior is read as id 97): wrong world corners
  const fake = seen.find((m) => sheetOf(m.id) === 0)!;
  const bad = [...seen.filter((m) => m !== fake), { id: 97, img: fake.img.map((p) => ({ ...p })) }];
  let calls = 0;
  const counting: SolvePose = (w, i) => (calls++, solve(w, i));
  const f = solveTable(map, bad, counting, K);
  const unmappedInView = new Set(bad.map((m) => sheetOf(m.id)).filter((k) => !map.sheets[k!] && k !== 0)).size;
  assert.equal(calls, 2 + unmappedInView, "the first solve and one more");
  assert.ok(f.pose, "a pose");
  const iFake = bad.length - 1;
  assert.ok(!f.used.includes(iFake), "the false marker is not in the pose");
  const truth = fromPose(pose), got = fromPose(f.pose!);
  const dmm = Math.hypot(...([0, 1, 2] as const).map((i) => inverse(got).p[i] - inverse(truth).p[i])) * 1000;
  assert.ok(dmm < 1, `camera within ${dmm.toFixed(2)} mm`);
  assert.ok(f.sheets.every((v) => !v.left), "no sheet left out for one marker");
  // the clean frame: one solve, nothing left out
  calls = 0;
  solveTable(map, seen, counting, K);
  assert.equal(calls, 1);
});

test("MarkerTracker: tiny quads and duplicated ids never reach the pose", () => {
  const pose = camPose([0.0, 0.0, 0.4], 0, 0);
  const seen = view(pose, [TRUTH[0]], rng(3));
  const tiny = (id: number): { id: number; img: P[] } => ({ id, img: [{ x: 5, y: 5 }, { x: 16, y: 5 }, { x: 16, y: 16 }, { x: 5, y: 16 }] });
  const dup = seen[2];
  const dets = [...seen, tiny(9), tiny(seen[0].id), { id: dup.id, img: dup.img.map((p) => ({ x: p.x + 80, y: p.y + 40 })) }];
  const tr = new MarkerTracker(passCore, fixed(dets), pinhole(K.f, K.cx, K.cy), true);
  const f = tr.frame(blank, 0);
  assert.equal(f.markers, seen.length - 1, "every real marker but the duplicated id");
  assert.equal(f.quads.length, seen.length - 1);
  assert.ok(f.rmsPx < 1, `rms ${f.rmsPx}`);
});

// ---------------- learning the map ----------------

test("synthetic mapping: four sheets recovered within 0.3 mm and 0.05° (0.3 px noise)", () => {
  const mapper = new SheetMapper(null, () => AT);
  const mappedAt: number[] = [];
  let frame = 0;
  run(mapper, TRUTH, 300, 0, 11, () => {
    frame++;
    for (let k = 1; k < 4; k++) if (mappedAt[k] == null && mapper.state(k).state === "mapped") mappedAt[k] = frame;
  });
  const map = mapper.map();
  const lines: string[] = [];
  for (let k = 1; k < 4; k++) {
    assert.ok(map.sheets[k], `sheet ${k} mapped (${mapper.state(k).state}, ${mapper.state(k).progress})`);
    const e = errOf(map.sheets[k]!, TRUTH[k].pl);
    lines.push(`sheet ${k}: ${e.mm.toFixed(3)} mm, ${e.deg.toFixed(4)}°, frame ${mappedAt[k]}`);
    assert.ok(e.mm < 0.3 && e.deg < 0.05, lines[lines.length - 1]);
  }
  console.log(`  # synthetic mapping: ${lines.join(" | ")}`);
  assert.deepEqual(mapper.states().map((s) => s.state), ["mapped", "mapped", "mapped", "mapped"]);
});

test("synthetic mapping: a sheet lifted 3 mm is refused as not flat", () => {
  const truth: Truth = TRUTH.map((s, k) => (k === 2 ? { ...s, zM: 0.003 } : s));
  const mapper = new SheetMapper(null, () => AT);
  run(mapper, truth, 300, 0, 23);
  const map = mapper.map();
  assert.equal(map.sheets[2], null);
  assert.equal(mapper.state(2).state, "not-flat");
  assert.ok(map.sheets[1], "the flat ones are mapped");
});

test("synthetic mapping: a sheet shifted 5 mm after mapping is left out of the pose at once (camera within 1 mm every frame), marked moved within about a second, then mapped again", () => {
  const mapper = new SheetMapper(null, () => AT);
  let t = run(mapper, TRUTH, 300, 0, 31);
  assert.ok(mapper.map().sheets[1], "sheet 1 mapped first");
  const shifted: Truth = TRUTH.map((s, k) => (k === 1 ? { ...s, pl: { ...s.pl, x: s.pl.x + 0.005 } } : s));
  // keep sheet 1 in view (with sheet 0): the camera over the seam between them, 32 cm up (at 50 cm the noise alone
  // moves the camera of a pose from sheet 0 by up to 1.8 mm in this test, moved sheet or not)
  const r = rng(7);
  let movedAt = NaN;
  const t0 = t;
  let worstPoseMm = 0;
  let leftOut = 0;
  let dropped = false;
  for (let i = 0; i < 45; i++, t += 1 / 15) {
    const pose = camPose([0.1 + 0.02 * Math.sin(i), 0.02 + 0.02 * Math.cos(i * 0.7), 0.32], 8, i * 20);
    const m = mapper.map();
    const f = solveTable(m, view(pose, shifted, r), solve, K);
    mapper.feed(t, f.sheets);
    // the camera's position in the world (-Rᵀ t), solved against the truth: the guard leaves sheet 1 out at once
    assert.ok(f.pose, `a pose in frame ${i}`);
    const centre = (q: Pose) => [0, 1, 2].map((j) => -(q.R[j] * q.t[0] + q.R[3 + j] * q.t[1] + q.R[6 + j] * q.t[2]));
    const a = centre(f.pose!), b = centre(pose);
    const errMm = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 1000;
    worstPoseMm = Math.max(worstPoseMm, errMm);
    assert.ok(errMm < 1, `frame ${i} after the shift: camera position off by ${errMm.toFixed(2)} mm`);
    const v1 = f.sheets.find((v) => v.k === 1);
    // while the map still has sheet 1 where it was (it may be mapped again where it is now within these frames)
    const stale = !!m.sheets[1] && Math.abs(m.sheets[1].x - TRUTH[1].pl.x) < 0.0025;
    if (stale && v1 && v1.markers >= MOVED_MIN_MARKERS) {
      assert.ok(v1.left, `frame ${i}: sheet 1 left out of the pose (reprojection ${v1.reprojPx?.toFixed(1)} px)`);
      leftOut++;
    }
    if (Number.isNaN(movedAt) && mapper.state(1).state === "moved") {
      movedAt = t;
      dropped = mapper.map().sheets[1] === null;
    }
  }
  assert.ok(!Number.isNaN(movedAt), `sheet 1 marked moved (state ${mapper.state(1).state})`);
  assert.ok(movedAt - t0 <= MOVED_S + 0.3, `after ${(movedAt - t0).toFixed(2)} s`);
  assert.ok(dropped, "dropped from the world corners");
  assert.ok(leftOut > 0, "the guard acted before the mapper dropped the sheet");
  console.log(`  # moved: marked ${(movedAt - t0).toFixed(2)} s after the shift; sheet 1 left out of the pose in ${leftOut} frames before that; worst camera position ${worstPoseMm.toFixed(2)} mm`);
  // looking at the table again maps it where it is now (the frames above may have done it already)
  run(mapper, shifted, 300, t, 41);
  const e = errOf(mapper.map().sheets[1]!, shifted[1].pl);
  assert.ok(e.mm < 0.3 && e.deg < 0.05, `mapped again within ${e.mm.toFixed(3)} mm, ${e.deg.toFixed(4)}°`);
});

test("SheetMapper: a stored map is used at once; clear; states over time", () => {
  const stored: TableMap = { v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, TRUTH[1].pl, null, null], at: AT };
  const m = new SheetMapper(stored, () => "2026-11-25T00:00:00.000Z");
  assert.deepEqual(m.map(), stored);
  assert.deepEqual(m.states().map((s) => s.state), ["mapped", "mapped", "missing", "missing"]);
  // a sheet in view with too few observations is "seen", with its progress; out of view for over a second, "missing"
  const obs: SheetObs = { x: 0, y: 0.3, yaw: 0, zMm: 0, tiltDeg: 0, markers: 10, rmsPx: 0.3 };
  for (let i = 0; i < 5; i++) m.feed(i / 15, [{ k: 2, markers: 10, obs }]);
  assert.equal(m.state(2).state, "seen");
  assert.equal(m.state(2).progress, 5 / MAP_MIN_OBS);
  m.feed(3, []);
  assert.equal(m.state(2).state, "missing");
  // bad observations are not counted: a planar pose flip, a bad world pose, a lone marker
  m.feed(3.1, [{ k: 2, markers: 10, obs: { ...obs, tiltDeg: 40 } }, { k: 3, markers: 1 }]);
  m.feed(3.2, [{ k: 2, markers: 10, obs: { ...obs, rmsPx: 3 } }]);
  m.feed(3.3, [{ k: 2, markers: 10, obs: { ...obs, markers: 1 } }]);
  assert.equal(m.state(2).progress, 5 / MAP_MIN_OBS);
  assert.equal(m.state(3).state, "missing", "one marker is not in view enough to map");
  // 20 that agree map it at once; the change is reported
  let changed = false;
  for (let i = 0; i < MAP_MIN_OBS; i++) changed = m.feed(4 + i / 15, [{ k: 2, markers: 10, obs: { ...obs, x: obs.x + 1e-5 * Math.sin(i) } }]) || changed;
  assert.ok(changed);
  assert.equal(m.state(2).state, "mapped");
  assert.equal(m.map().at, "2026-11-25T00:00:00.000Z");
  m.clear();
  assert.deepEqual(m.states(), SHEET0_ONLY);
  assert.deepEqual(mappedSheets(m.map()), [0]);
});

test("SheetMapper: spread too large keeps collecting; the moved check needs a full second of high error", () => {
  const m = new SheetMapper(null, () => AT);
  const r = rng(3);
  // 2 mm of scatter: never mapped
  for (let i = 0; i < 60; i++) m.feed(i / 15, [{ k: 1, markers: 8, obs: { x: 0.2 + 0.002 * r.g(), y: 0, yaw: 0, zMm: 0, tiltDeg: 0, markers: 8, rmsPx: 0.4 } }]);
  assert.equal(m.state(1).state, "seen");
  const s = summarize(Array.from({ length: 30 }, (_, i) => ({ x: 0.2 + (i === 3 ? 0.01 : 0), y: 0, yaw: 0, zMm: 0.1, tiltDeg: 0.2, markers: 8, rmsPx: 0.4 })))!;
  assert.equal(s.inliers, 29, "an outlier dropped");
  assert.ok(Math.abs(s.placement.x - 0.2) < 1e-12 && s.spreadMm < 1e-9);
  // moved: high error for half a second, then fine: not moved; then a full second: moved
  const mapped = new SheetMapper({ v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, { x: 0.2, y: 0, yaw: 0 }, null, null], at: AT });
  const v = (px: number): SheetView[] => [{ k: 1, markers: 6, reprojPx: px }];
  for (let i = 0; i <= 7; i++) mapped.feed(i / 15, v(8));
  for (let i = 8; i <= 30; i++) mapped.feed(i / 15, v(0.5));
  assert.equal(mapped.state(1).state, "mapped");
  let changed = false;
  for (let i = 31; i <= 50; i++) changed = mapped.feed(i / 15, v(8)) || changed;
  assert.ok(changed);
  assert.equal(mapped.state(1).state, "moved");
  // sheet 0 is never marked moved
  for (let i = 51; i <= 80; i++) mapped.feed(i / 15, [{ k: 0, markers: 6, reprojPx: 50 }]);
  assert.equal(mapped.state(0).state, "mapped");
});

// ---------------- the tracker's wiring ----------------

/** A core that keeps the corners as detected (no image to refine on) and solves with the real engine. */
const passCore = {
  refineMany: (_img: unknown, qs: P[][]) => qs.map((q) => q.map((p) => ({ ...p }))),
  undistortPoints: (_c: unknown, pts: P[]) => pts.map((p) => ({ ...p })),
  solvePoseRobust: (w: P[], i: P[], k: Intrinsics) => core.solvePoseRobust(w, i, k),
} as unknown as NavCore;
const fixed = (dets: { id: number; img: P[] }[]): Detector => ({ detect: () => dets.map((d) => ({ id: d.id, corners: d.img })) });
const blank = { width: W, height: H, data: new Uint8ClampedArray(4) };

test("MarkerTracker: the table map, sheets per frame, markers on parts win, lens captures keep sheet 0", () => {
  const r = rng(9);
  const pose = camPose([0.108, 0.0, 0.5], 0, 0);
  const seen = view(pose, TRUTH, r);
  const n0 = seen.filter((m) => sheetOf(m.id) === 0).length, n1 = seen.filter((m) => sheetOf(m.id) === 1).length;
  const tr = new MarkerTracker(passCore, fixed(seen), pinhole(K.f, K.cx, K.cy), true);
  let f = tr.frame(blank, 0);
  assert.equal(f.markers, n0, "the gate counts the markers in the pose: sheet 0 only without a map");
  assert.ok(f.sheets.find((v) => v.k === 1)?.obs, "sheet 1 observed");
  tr.setTableMap({ v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, TRUTH[1].pl, null, null], at: AT });
  f = tr.frame(blank, 0.1);
  assert.equal(f.markers, n0 + n1, "sheet 1 joins the pose once mapped");
  assert.ok(f.sheets.find((v) => v.k === 1)!.reprojPx! < 1);
  // a lens capture keeps sheet 0's markers only (a learned map must not feed the lens model)
  tr.beginCapture("camera");
  tr.frame(blank, 0.2);
  const views = (tr as unknown as { cap: { views: { world: P[] }[] } }).cap.views;
  assert.equal(views.length, 1);
  assert.equal(views[0].world.length, 4 * n0);
  tr.cancelCapture();
  // markers on parts win: sheet 1's ids as a body's are not the table's
  tr.setBodies([{ name: "part", stickers: [{ name: "s", pose: xf(), size: 0.024, half: [0.1, 0.15], markers: sheetMarkerIds(1).map((id) => ({ id, x: 0, y: 0 })) }] }]);
  f = tr.frame(blank, 0.3);
  assert.equal(f.markers, n0);
  assert.equal(f.sheets.find((v) => v.k === 1), undefined);
});
