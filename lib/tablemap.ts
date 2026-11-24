// The table map: up to four marker sheets laid flat on the same bench (lib/board.ts SHEETS). Sheet 0 is the world
// frame (origin at its centre); every other sheet is placed in that plane by three numbers, { x, y, yaw }. The
// placements are learned by looking at the table (SheetMapper): in a frame where the world is seen well, a sheet
// not mapped yet is solved on its own, and its pose against the world's is one observation. After enough
// observations that agree, the sheet is mapped and its markers join the world pose. A mapped sheet whose markers no
// longer fit the whole table's pose has moved: it is dropped and must be mapped again.
//
// Pure: no DOM, no engine. The pose solver comes in as a function (NavCore.solvePoseRobust has its shape).

import { SHEETS, sheetMarkerCorners, sheetOf } from "./board.ts";
import type { Intrinsics, Pose } from "./pose.ts";

type P = { x: number; y: number };

/** Where a sheet lies in the world plane: its centre (m) and its rotation about the plane's normal (rad). */
export interface Placement {
  x: number;
  y: number;
  yaw: number;
}

/** The learned table, kept per device (st-table). Index = sheet; sheet 0 is always { 0, 0, 0 }; null = not
 * mapped. `at`: when it last changed (ISO). */
export interface TableMap {
  v: 1;
  sheets: (Placement | null)[];
  at: string;
}

const ORIGIN: Placement = { x: 0, y: 0, yaw: 0 };

// ---------------- rules ----------------

/** observations that agree before a sheet is mapped */
export const MAP_MIN_OBS = 20;
/** how far the kept observations may spread (RMS from their median): position (mm), yaw (deg) */
export const MAP_SPREAD_MM = 0.7;
export const MAP_SPREAD_DEG = 0.15;
/** a sheet whose median observation is further than this from the world plane is not flat (mm, deg) */
export const FLAT_MAX_MM = 2;
export const FLAT_MAX_DEG = 1.5;
/** whole markers of a sheet in one frame to solve it on its own */
export const MAP_MIN_MARKERS = 2;
/** an observation counts only when the world pose of its frame is good: markers in it, and its RMS (px) */
export const MAP_WORLD_MIN_MARKERS = 6;
export const MAP_MAX_RMS_PX = 1.5;
/** a mapped sheet has moved when its markers' median reprojection error stays above this (px) for MOVED_S (s) */
export const MOVED_PX = 3;
export const MOVED_S = 1;
/** markers of a mapped sheet in view to check it for a move */
export const MOVED_MIN_MARKERS = 3;
/** a pose the tracker accepts at all (px), as for the sheet alone */
export const MAX_POSE_RMS_PX = 4;
/** a detected quad whose shortest side is under this is dropped (px, in the detection image). js-aruco2 keeps quads
 * down to 10 px a side, and its false reads (block edges, tiny dark blobs, an all-black interior read as id 97) sit
 * at 10-16 px; a real 24 mm marker at the working distance measures 34-83 px in the 960 px image (headless pilot run,
 * median 60). 20 px keeps a clear margin on both sides and still passes a marker 600 mm away at 640 px detection. */
export const MIN_MARKER_SIDE_PX = 20;
/** after the first solve, a marker whose own reprojection error is above both of these (× the median of the
 * frame's markers, and px) is left out and the pose solved once more */
export const OUTLIER_RATIO = 4;
export const OUTLIER_MIN_PX = 3;
/** at most this share of a frame's markers can be left out that way (outliers are a few, not a side) */
export const OUTLIER_SHARE = 0.25;
/** observations kept per sheet while it is mapped (the latest) */
const MAP_WINDOW = 60;
/** a sheet counts as in view for this long after it was last seen with MAP_MIN_MARKERS (s) */
const SEEN_S = 1;
/** an observation this far off the plane is a bad solve (a planar pose flip), not a sheet: dropped (mm, deg) */
const OBS_MAX_MM = 20;
const OBS_MAX_DEG = 10;
/** reprojection samples in the moved window before it can decide */
const MOVED_MIN_SAMPLES = 5;

// ---------------- the map ----------------

/** A map with only sheet 0. */
export function emptyMap(at = new Date().toISOString()): TableMap {
  return { v: 1, sheets: Array.from({ length: SHEETS }, (_, k) => (k === 0 ? { ...ORIGIN } : null)), at };
}

const finite = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;

/** Check a map read back from storage: null if it is not one this version can use. Sheet 0 is forced to the
 * origin; a placement more than 2 m away is refused. */
export function readTableMap(x: unknown): TableMap | null {
  const m = x as Partial<TableMap> | null;
  if (!m || typeof m !== "object" || m.v !== 1 || !Array.isArray(m.sheets) || m.sheets.length < 1 || m.sheets.length > SHEETS) return null;
  if (typeof m.at !== "string" || Number.isNaN(Date.parse(m.at))) return null;
  const sheets: (Placement | null)[] = [];
  for (let k = 0; k < SHEETS; k++) {
    const p = m.sheets[k] as Partial<Placement> | null | undefined;
    if (k === 0) {
      sheets.push({ ...ORIGIN });
      continue;
    }
    if (p == null) {
      sheets.push(null);
      continue;
    }
    if (!finite(p.x, 2) || !finite(p.y, 2) || !finite(p.yaw, 2 * Math.PI)) return null;
    sheets.push({ x: p.x, y: p.y, yaw: p.yaw });
  }
  return { v: 1, sheets, at: m.at };
}

/** A point on a placed sheet in the world plane. */
export function placePoint(pl: Placement, p: P): P {
  const c = Math.cos(pl.yaw), s = Math.sin(pl.yaw);
  return { x: pl.x + c * p.x - s * p.y, y: pl.y + s * p.x + c * p.y };
}

/** World corners of a marker (js-aruco2 order), null when its sheet is not mapped or it is on no sheet. */
export function worldCorners(map: TableMap, id: number): P[] | null {
  const k = sheetOf(id);
  if (k == null) return null;
  const pl = k === 0 ? ORIGIN : map.sheets[k];
  if (!pl) return null;
  return sheetMarkerCorners(id)!.map((c) => placePoint(pl, c));
}

/** The sheets that are mapped (sheet 0 included). */
export const mappedSheets = (map: TableMap): number[] => map.sheets.flatMap((p, k) => (k === 0 || p ? [k] : []));

// ---------------- one observation ----------------

/** A sheet's placement measured in one frame, and how far that frame puts it off the world plane. */
export interface SheetObs {
  x: number;
  y: number;
  yaw: number;
  /** height of the sheet's centre over the world plane (mm) */
  zMm: number;
  /** angle between the sheet's normal and the world's (deg) */
  tiltDeg: number;
  /** markers the sheet's own pose kept, and its RMS (px) */
  markers: number;
  rmsPx: number;
}

/** T_world_sheet = inverse(T_cam_world) ∘ T_cam_sheet, as a placement in the world plane plus its height and tilt
 * off it. Both poses as the solver returns them (x_cam = R X + t, metres). */
export function placementFromPoses(camWorld: Pose, camSheet: Pose): { x: number; y: number; yaw: number; zMm: number; tiltDeg: number } {
  const A = camWorld.R, B = camSheet.R;
  // R_ws = A^T B, t_ws = A^T (t_cs - t_cw)
  const r = (i: number, j: number) => A[i] * B[j] + A[3 + i] * B[3 + j] + A[6 + i] * B[6 + j];
  const d = [camSheet.t[0] - camWorld.t[0], camSheet.t[1] - camWorld.t[1], camSheet.t[2] - camWorld.t[2]];
  const t = [0, 1, 2].map((i) => A[i] * d[0] + A[3 + i] * d[1] + A[6 + i] * d[2]);
  const r00 = r(0, 0), r10 = r(1, 0), r22 = r(2, 2);
  return {
    x: t[0],
    y: t[1],
    yaw: Math.atan2(r10, r00),
    zMm: t[2] * 1000,
    tiltDeg: (Math.acos(Math.max(-1, Math.min(1, r22))) * 180) / Math.PI,
  };
}

// ---------------- one frame of the table ----------------

/** The shortest side of a quad (px). */
export function shortestSide(c: readonly P[]): number {
  let m = Infinity;
  for (let i = 0; i < c.length; i++) m = Math.min(m, Math.hypot(c[i].x - c[(i + 1) % c.length].x, c[i].y - c[(i + 1) % c.length].y));
  return m;
}

/** A frame's raw detections cleaned before any pose: a quad smaller than `minSidePx` (shortest side) is dropped
 * first, then every detection of an id seen more than once (which one is real cannot be told, and two copies of a
 * marker tear the pose). Order kept. `small` and `dup` count what was dropped. */
export function screenDetections<T extends { id: number; corners: readonly P[] }>(all: readonly T[], minSidePx = MIN_MARKER_SIDE_PX): { kept: T[]; small: number; dup: number } {
  const big = all.filter((m) => m.corners.length === 4 && shortestSide(m.corners) >= minSidePx);
  const n = new Map<number, number>();
  for (const m of big) n.set(m.id, (n.get(m.id) ?? 0) + 1);
  const kept = big.filter((m) => n.get(m.id) === 1);
  return { kept, small: all.length - big.length, dup: big.length - kept.length };
}

/** The markers whose own error stands out: above `ratio` × the median of all of them and above `minPx`. */
export function reprojOutliers(errs: readonly number[], ratio = OUTLIER_RATIO, minPx = OUTLIER_MIN_PX): boolean[] {
  const m = median(errs.filter(Number.isFinite));
  return errs.map((e) => !(e <= ratio * m) && !(e <= minPx));
}

/** What a frame says about one sheet in view. */
export interface SheetView {
  k: number;
  /** whole markers of this sheet detected (markers on parts excluded) */
  markers: number;
  /** a sheet not mapped: its placement in this frame (only when the world pose of the frame is good) */
  obs?: SheetObs;
  /** a sheet not mapped: T_camera_sheet in this frame (for its outline on screen) */
  pose?: Pose;
  /** a mapped sheet other than 0 with MOVED_MIN_MARKERS in view: the median reprojection error of its markers
   * against the whole table's pose (px) */
  reprojPx?: number;
  /** a mapped sheet left out of this frame's pose: its markers did not fit the first solve (solveTable's guard) */
  left?: boolean;
}

/** A pose solver: world points (plane z = 0) and their image points (undistorted px). */
export type SolvePose = (world: P[], img: P[]) => { pose: Pose; kept: number; keep: boolean[] } | null;

export interface TableSolve {
  /** T_camera_world from the markers of every mapped sheet, null when not seen (or its RMS is too high) */
  pose: Pose | null;
  /** markers the pose kept */
  kept: number;
  /** indices (into `seen`) of the markers that went into the world solve, and whether the solver kept each */
  used: number[];
  keep: boolean[];
  /** the world corners of the markers in `used`, four per marker */
  world: P[];
  sheets: SheetView[];
}

/** Project a world point (plane z = 0) with a pose and pinhole intrinsics; null behind the camera. */
function project(pose: Pose, K: Intrinsics, p: P): P | null {
  const R = pose.R, t = pose.t;
  const x = R[0] * p.x + R[1] * p.y + t[0];
  const y = R[3] * p.x + R[4] * p.y + t[1];
  const z = R[6] * p.x + R[7] * p.y + t[2];
  if (z <= 1e-9) return null;
  return { x: (K.f * x) / z + K.cx, y: (K.f * y) / z + K.cy };
}

const median = (v: number[]) => {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The table in one frame. `seen`: the sheet markers detected (markers on parts already removed) with their
 * undistorted corners. The world pose is solved from every marker of every mapped sheet; each sheet not mapped with
 * MAP_MIN_MARKERS in view is solved once on its own corners (an observation when the world pose is good); each
 * mapped sheet but 0 with MOVED_MIN_MARKERS in view gets its reprojection error against the world pose (no solve).
 * A marker of a sheet not mapped never enters the world pose.
 *
 * The guard against a sheet that moved: when, after the first solve, a mapped sheet but 0 with at least
 * MOVED_MIN_MARKERS in view has a median reprojection error above MOVED_PX, or the pose is torn between it and
 * sheet 0 (their two medians add up to more than MOVED_PX and the sheet's is the larger), every such sheet is left
 * out and the pose is solved once more without them, in the same frame (its view says `left`). Sheet 0 is never left out; if
 * fewer than 4 markers would remain, or the second solve fails, the first pose stands (the gate decides). The
 * reprojection errors reported are against the pose kept, so the mapper still sees the moved sheet.
 *
 * The same extra solve also leaves out any single marker whose own error against the first pose is far above the
 * others' (reprojOutliers: over OUTLIER_RATIO × the median and over OUTLIER_MIN_PX): a false detection that carries a
 * valid id. Only when they are at most OUTLIER_SHARE of the markers and not every marker of sheet 0 in view. So there is
 * still at most one extra solve per frame. */
export function solveTable(map: TableMap, seen: readonly { id: number; img: P[] }[], solve: SolvePose, K: Intrinsics): TableSolve {
  const inMap: number[] = [];
  const bySheet = new Map<number, number[]>();
  seen.forEach((m, i) => {
    const k = sheetOf(m.id);
    if (k == null) return;
    const l = bySheet.get(k) ?? [];
    l.push(i);
    bySheet.set(k, l);
    if (worldCorners(map, m.id)) inMap.push(i);
  });
  const solveWorld = (idx: number[]) => {
    const world = idx.flatMap((i) => worldCorners(map, seen[i].id)!);
    if (world.length < 4) return null;
    const sol = solve(world, idx.flatMap((i) => seen[i].img));
    return sol ? { pose: sol.pose, kept: sol.kept, keep: sol.keep, used: idx, world } : null;
  };
  // the median reprojection error of every mapped sheet but 0 with MOVED_MIN_MARKERS in view, against a pose
  // one marker's mean corner error against a pose (px)
  const markerErr = (pose: Pose, i: number) => {
    const wc = worldCorners(map, seen[i].id)!;
    let e = 0;
    for (let c = 0; c < 4; c++) {
      const q = project(pose, K, wc[c]);
      e += q ? Math.hypot(q.x - seen[i].img[c].x, q.y - seen[i].img[c].y) : 1e3;
    }
    return e / 4;
  };
  const reproj = (pose: Pose) => {
    const out = new Map<number, number>();
    for (const [k, idx] of bySheet) {
      if ((k !== 0 && !map.sheets[k]) || idx.length < MOVED_MIN_MARKERS) continue;
      out.set(k, median(idx.map((i) => markerErr(pose, i))));
    }
    return out;
  };
  // the first solve is checked even when its RMS is too high to use: a moved sheet is a cause of that too
  let sol = solveWorld(inMap);
  let errs = sol ? reproj(sol.pose) : new Map<number, number>();
  const left = new Set<number>();
  if (sol) {
    // a sheet that moved pulls the pose toward it, so its own error can stay under MOVED_PX while sheet 0's rises:
    // the pose is then torn between them (their errors together above MOVED_PX, the sheet the worse of the two)
    const e0 = errs.get(0) ?? 0;
    const bad = [...errs].filter(([k, e]) => k > 0 && (e > MOVED_PX || (e + e0 > MOVED_PX && e > e0))).map(([k]) => k);
    // a single marker that does not fit (a false read with a valid id) is left out in the same extra solve
    // (only a few of them, and never every marker of sheet 0 in view: that is the moved-sheet case the other way round)
    let out = reprojOutliers(inMap.map((i) => markerErr(sol!.pose, i)));
    const n0 = inMap.filter((i) => sheetOf(seen[i].id) === 0).length;
    const out0 = inMap.filter((i, j) => out[j] && sheetOf(seen[i].id) === 0).length;
    if (out.filter(Boolean).length > inMap.length * OUTLIER_SHARE || (n0 > 0 && out0 === n0)) out = out.map(() => false);
    const rest = inMap.filter((i, j) => !out[j] && !bad.includes(sheetOf(seen[i].id)!));
    if ((bad.length || out.some(Boolean)) && rest.length >= 4) {
      const again = solveWorld(rest);
      if (again && again.pose.rms < MAX_POSE_RMS_PX) {
        sol = again;
        errs = reproj(again.pose);
        for (const k of bad) left.add(k);
      }
    }
  }
  if (sol && !(sol.pose.rms < MAX_POSE_RMS_PX)) {
    sol = null;
    errs = new Map();
    left.clear();
  }
  const pose = sol?.pose ?? null;
  const kept = sol?.kept ?? 0;
  const worldGood = !!pose && kept >= MAP_WORLD_MIN_MARKERS && pose.rms < MAP_MAX_RMS_PX;
  const sheets: SheetView[] = [];
  for (const k of [...bySheet.keys()].sort((a, b) => a - b)) {
    const idx = bySheet.get(k)!;
    const v: SheetView = { k, markers: idx.length };
    const mapped = k === 0 || !!map.sheets[k];
    if (mapped) {
      if (k > 0 && errs.has(k)) v.reprojPx = errs.get(k);
      if (left.has(k)) v.left = true;
    } else if (idx.length >= MAP_MIN_MARKERS) {
      const own = solve(
        idx.flatMap((i) => sheetMarkerCorners(seen[i].id)!),
        idx.flatMap((i) => seen[i].img),
      );
      if (own && own.pose.rms < MAX_POSE_RMS_PX) {
        v.pose = own.pose;
        if (worldGood) v.obs = { ...placementFromPoses(pose!, own.pose), markers: own.kept, rmsPx: own.pose.rms };
      }
    }
    sheets.push(v);
  }
  return { pose, kept, used: sol?.used ?? [], keep: sol?.keep ?? [], world: sol?.world ?? [], sheets };
}

// ---------------- learning the map ----------------

export type SheetStateKind = "missing" | "seen" | "mapped" | "not-flat" | "moved";
/** A sheet's state for the screen and the sheet check: progress 0..1 of its observations (1 once mapped). */
export interface SheetState {
  k: number;
  state: SheetStateKind;
  progress: number;
}

interface Track {
  obs: SheetObs[];
  lastSeen: number;
  moved: boolean;
  notFlat: boolean;
  reproj: { t: number; px: number }[];
}
const newTrack = (): Track => ({ obs: [], lastSeen: -Infinity, moved: false, notFlat: false, reproj: [] });

/** Robust summary of observations: the medians, the inliers around them, their RMS spread and the flatness. */
export function summarize(obs: readonly SheetObs[]): { placement: Placement; inliers: number; spreadMm: number; spreadDeg: number; zMm: number; tiltDeg: number } | null {
  if (!obs.length) return null;
  const mx = median(obs.map((o) => o.x)), my = median(obs.map((o) => o.y)), myaw = median(obs.map((o) => o.yaw));
  const dMm = obs.map((o) => Math.hypot(o.x - mx, o.y - my) * 1000);
  const dDeg = obs.map((o) => (Math.abs(o.yaw - myaw) * 180) / Math.PI);
  // outliers: further than 3 × the typical deviation (with a floor, so near-perfect data keeps everything)
  const limMm = 3 * Math.max(median(dMm), 0.05), limDeg = 3 * Math.max(median(dDeg), 0.01);
  const ins = obs.filter((_, i) => dMm[i] <= limMm && dDeg[i] <= limDeg);
  const px = median(ins.map((o) => o.x)), py = median(ins.map((o) => o.y)), pyaw = median(ins.map((o) => o.yaw));
  const rms = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0) / Math.max(1, v.length));
  return {
    placement: { x: px, y: py, yaw: pyaw },
    inliers: ins.length,
    spreadMm: rms(ins.map((o) => Math.hypot(o.x - px, o.y - py) * 1000)),
    spreadDeg: rms(ins.map((o) => ((o.yaw - pyaw) * 180) / Math.PI)),
    zMm: median(ins.map((o) => o.zMm)),
    tiltDeg: median(ins.map((o) => o.tiltDeg)),
  };
}

/** Learns where the sheets lie, from the table's frames (solveTable's `sheets`), and watches mapped sheets for a
 * move. A map given at the start is used at once (the moved check guards against a stale one). */
export class SheetMapper {
  private placements: (Placement | null)[];
  private tracks: Track[] = Array.from({ length: SHEETS }, newTrack);
  private at: string;
  private t = -Infinity;
  private readonly now: () => string;

  constructor(map?: TableMap | null, now: () => string = () => new Date().toISOString()) {
    this.now = now;
    const m = map ?? emptyMap(now());
    this.placements = Array.from({ length: SHEETS }, (_, k) => (k === 0 ? { ...ORIGIN } : m.sheets[k] ? { ...m.sheets[k]! } : null));
    this.at = m.at;
  }

  /** Forget every sheet but 0. */
  clear() {
    this.placements = Array.from({ length: SHEETS }, (_, k) => (k === 0 ? { ...ORIGIN } : null));
    this.tracks = Array.from({ length: SHEETS }, newTrack);
    this.at = this.now();
  }

  /** One tracker frame at time t (s). True when the map changed (a sheet was mapped, or dropped as moved). */
  feed(t: number, sheets: readonly SheetView[]): boolean {
    this.t = t;
    let changed = false;
    for (const v of sheets) {
      if (v.k <= 0 || v.k >= SHEETS) continue;
      const tr = this.tracks[v.k];
      if (v.markers >= MAP_MIN_MARKERS) tr.lastSeen = t;
      if (this.placements[v.k]) {
        if (v.reprojPx == null || !Number.isFinite(v.reprojPx)) continue;
        tr.reproj.push({ t, px: v.reprojPx });
        // the last MOVED_S, plus the newest sample at or before its start (so the window can span all of it)
        while (tr.reproj.length > 1 && tr.reproj[1].t <= t - MOVED_S) tr.reproj.shift();
        const inWin = tr.reproj.filter((r) => r.t > t - MOVED_S);
        const span = t - tr.reproj[0].t;
        if (span >= MOVED_S && inWin.length >= MOVED_MIN_SAMPLES && median(inWin.map((r) => r.px)) > MOVED_PX) {
          this.placements[v.k] = null;
          this.tracks[v.k] = { ...newTrack(), lastSeen: tr.lastSeen, moved: true };
          this.at = this.now();
          changed = true;
        }
        continue;
      }
      const o = v.obs;
      if (!o || o.markers < MAP_MIN_MARKERS || !(o.rmsPx < MAP_MAX_RMS_PX) || Math.abs(o.zMm) > OBS_MAX_MM || o.tiltDeg > OBS_MAX_DEG) continue;
      tr.obs.push(o);
      if (tr.obs.length > MAP_WINDOW) tr.obs.shift();
      if (tr.obs.length < MAP_MIN_OBS) continue;
      const s = summarize(tr.obs)!;
      if (s.inliers < MAP_MIN_OBS) continue;
      tr.notFlat = Math.abs(s.zMm) > FLAT_MAX_MM || s.tiltDeg > FLAT_MAX_DEG;
      if (tr.notFlat || s.spreadMm > MAP_SPREAD_MM || s.spreadDeg > MAP_SPREAD_DEG) continue;
      this.placements[v.k] = s.placement;
      this.tracks[v.k] = { ...newTrack(), lastSeen: tr.lastSeen };
      this.at = this.now();
      changed = true;
    }
    return changed;
  }

  /** Where sheet k stands. */
  state(k: number): SheetState {
    if (k === 0) return { k, state: "mapped", progress: 1 };
    if (k < 0 || k >= SHEETS) return { k, state: "missing", progress: 0 };
    if (this.placements[k]) return { k, state: "mapped", progress: 1 };
    const tr = this.tracks[k];
    const progress = Math.min(0.99, tr.obs.length / MAP_MIN_OBS);
    if (tr.moved) return { k, state: "moved", progress };
    if (tr.notFlat) return { k, state: "not-flat", progress };
    if (this.t - tr.lastSeen <= SEEN_S) return { k, state: "seen", progress };
    return { k, state: "missing", progress };
  }

  /** Every sheet's state, 0..SHEETS-1. */
  states(): SheetState[] {
    return Array.from({ length: SHEETS }, (_, k) => this.state(k));
  }

  /** The map as it stands (sheets not mapped, or moved, are null). */
  map(): TableMap {
    return { v: 1, sheets: this.placements.map((p) => (p ? { ...p } : null)), at: this.at };
  }
}

/** The state of a table with only sheet 0 (no mapper): sheet 0 mapped, the others missing. */
export const SHEET0_ONLY: readonly SheetState[] = Array.from({ length: SHEETS }, (_, k) => ({ k, state: k === 0 ? "mapped" : "missing", progress: k === 0 ? 1 : 0 }) as SheetState);
