// The pilot job, as a model (pure: no DOM, no engine). Up to four marker sheets are taped flat on the bench and
// never move (lib/tablemap.ts maps them; sheet 0 is the world frame). A square block of wood, 100 × 100 mm, is
// clamped on them and gets 4 screws, each 10 mm in from two edges. The phone guides it in three phases:
//
//   sheet   every sheet in view is mapped, and the drill sees the table well    sheetCheck
//   part    the tip rests on each top corner of the block and the drill pivots  CornerCapture, fitPart
//   work    the guide for the 4 screws                                          pilotPlan, pilotRecipe
//
// and says what to look at next by lighting controls and drawn guides, not by text (focus, pilotText).
//
// Lengths are mm in the sheet's frame unless said otherwise: x, y on the sheet's plane (origin at its centre),
// z up from it (towards the camera). The engine's registration works in metres: fitPart converts.

import type { V3 } from "./pose.ts";
import { applyDir, applyPoint, qaxis, type Xf } from "./xform.ts";
import { PLAN_KIND, PLAN_VERSION, SHEET_ID, LIMITS, type Plan, type PlanHole } from "./plan.ts";
import { DEFAULT_CHECK, recipeFromPlan, recipeOfPlan, drillText } from "./recipe.ts";
import type { Readout } from "./hudsimple.ts";
import type { Icon } from "./hudguide.ts";
import { SHEET0_ONLY, type SheetState } from "./tablemap.ts";

export const PILOT_PART = { name: "Wood block", sideMm: 100, insetMm: 10 };
export const PILOT_SCREW = { depthMm: 15, diameterMm: 4 };
export type Phase = "sheet" | "part" | "work";
export const PHASES: readonly Phase[] = ["sheet", "part", "work"];

/** A point in mm, sheet frame. */
export type V3mm = [number, number, number];

// ---------------- 1. sheet check ----------------

/** markers the camera must read for the sheet to count as seen well */
export const SHEET_MIN_MARKERS = 6;
/** how long it must hold, s */
export const SHEET_STEADY_S = 1;

/** Does the drill see the table well? need: what is missing first (the setup, the markers, a sheet in view still
 * being mapped, or time). `sheets`: the table's sheets (lib/tablemap.ts SheetMapper.states); without it, sheet 0
 * alone. */
export function sheetCheck(i: { markers: number; tracking: boolean; toolCalibrated: boolean; steadyS: number; sheets?: readonly SheetState[] }): { ok: boolean; need: "setup" | "markers" | "mapping" | "steady" | null } {
  if (!i.toolCalibrated) return { ok: false, need: "setup" };
  if (!i.tracking || i.markers < SHEET_MIN_MARKERS) return { ok: false, need: "markers" };
  if (i.sheets?.some((x) => x.state === "seen")) return { ok: false, need: "mapping" };
  if (i.steadyS < SHEET_STEADY_S) return { ok: false, need: "steady" };
  return { ok: true, need: null };
}

/** How many sheets of the table are mapped (sheet 0 always is). */
export const mappedCount = (sheets: readonly SheetState[] | undefined) => Math.max(1, (sheets ?? SHEET0_ONLY).filter((x) => x.state === "mapped").length);

// ---------------- 2. corner capture ----------------

/** how long the tip must rest on a corner, s */
export const CAPTURE_S = 1.5;
/** the tip stays within this distance of its mean while resting (mm) */
export const STEADY_MM = 1.5;
/** a corner is on the part, above the bench (mm over the sheet's plane) */
export const MIN_HEIGHT_MM = 3;
/** two corners closer than this are the same one (mm) */
export const MIN_APART_MM = 30;
/** how far the bit's axis must sweep while resting: the drill was pivoted on the corner (deg) */
export const PIVOT_DEG = 5;

/** One tracker frame: time (s), the 3D tip (mm, sheet frame) and the bit's axis (any length, sheet frame). */
export interface TipSample {
  t: number;
  tip: [number, number, number];
  axis: [number, number, number];
}

/** What is missing for a capture: the tip is on the bench, it moves, it is on a corner already taken, or the
 * drill has not been pivoted yet. */
export type CaptureWhy = "low" | "moving" | "near-taken" | "pivot" | null;

export interface CaptureResult {
  /** 0..1: how much of CAPTURE_S the tip has rested */
  progress: number;
  /** the corner just captured (the mean of the window), else null */
  captured: [number, number, number] | null;
  /** spread of the window around its mean, RMS (mm) */
  rmsMm: number;
  why: CaptureWhy;
}

const EPS_S = 1e-6;
const sub = (a: V3mm, b: V3mm): V3mm => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const mean = (ps: readonly V3mm[]): V3mm => {
  const m: V3mm = [0, 0, 0];
  for (const p of ps) for (let k = 0; k < 3; k++) m[k] += p[k] / ps.length;
  return m;
};
const angleDeg = (a: readonly number[], b: readonly number[]) => {
  const la = len(a), lb = len(b);
  if (la < 1e-12 || lb < 1e-12) return 0;
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
};

/** Captures the part's corners, one sample per tracker frame. A corner is captured when, over the last
 * CAPTURE_S, the tip stayed within STEADY_MM of its mean, at least MIN_HEIGHT_MM above the sheet, at least
 * MIN_APART_MM from every corner taken, and the bit's axis swept at least PIVOT_DEG. The point is the mean (a
 * pivot averages out the tip calibration's error). After a capture the window starts again. */
export class CornerCapture {
  private readonly taken: V3mm[];
  private win: TipSample[] = [];

  /** taken: the corners already captured (mm) */
  constructor(taken: [number, number, number][]) {
    this.taken = taken.map((p) => [p[0], p[1], p[2]]);
  }

  /** the corners captured so far, the given ones first */
  get corners(): V3mm[] {
    return this.taken.map((p) => [p[0], p[1], p[2]]);
  }

  /** forget the current window (not the corners) */
  reset() {
    this.win = [];
  }

  feed(s: TipSample): CaptureResult {
    if (s.tip[2] < MIN_HEIGHT_MM) {
      this.win = [];
      return { progress: 0, captured: null, rmsMm: 0, why: "low" };
    }
    if (this.taken.some((c) => len(sub(c, s.tip)) < MIN_APART_MM)) {
      this.win = [];
      return { progress: 0, captured: null, rmsMm: 0, why: "near-taken" };
    }
    this.win.push({ t: s.t, tip: [s.tip[0], s.tip[1], s.tip[2]], axis: [s.axis[0], s.axis[1], s.axis[2]] });
    // only the last CAPTURE_S counts: keep the newest sample at or before its start, so a window of frames that
    // do not fall on exact times can still span CAPTURE_S
    while (this.win.length > 1 && this.win[1].t <= s.t - CAPTURE_S + EPS_S) this.win.shift();
    // a tip that moved: drop the oldest samples until the rest is steady again
    let moved = false;
    while (this.win.length > 1 && maxDist(this.win) > STEADY_MM) {
      this.win.shift();
      moved = true;
    }
    const tips = this.win.map((w) => w.tip);
    const m = mean(tips);
    const rmsMm = Math.sqrt(tips.reduce((a, p) => a + len(sub(p, m)) ** 2, 0) / tips.length);
    const span = this.win[this.win.length - 1].t - this.win[0].t;
    const progress = Math.max(0, Math.min(1, span / CAPTURE_S));
    if (moved) return { progress, captured: null, rmsMm, why: "moving" };
    const pivoted = sweepDeg(this.win) >= PIVOT_DEG;
    if (!pivoted) return { progress, captured: null, rmsMm, why: "pivot" };
    if (span < CAPTURE_S - EPS_S) return { progress, captured: null, rmsMm, why: null };
    this.taken.push(m);
    this.win = [];
    return { progress: 1, captured: [m[0], m[1], m[2]], rmsMm, why: null };
  }
}

function maxDist(win: readonly TipSample[]) {
  const m = mean(win.map((w) => w.tip));
  return Math.max(...win.map((w) => len(sub(w.tip, m))));
}

/** The widest angle between any two axes of the window (deg). */
function sweepDeg(win: readonly TipSample[]) {
  let best = 0;
  for (let i = 0; i < win.length; i++) for (let j = i + 1; j < win.length; j++) best = Math.max(best, angleDeg(win[i].axis, win[j].axis));
  return best;
}

// ---------------- 3. registration ----------------

/** every measured side within this of PILOT_PART.sideMm (mm) */
export const SIZE_TOL_MM = 4;
/** the fit's RMS residual at most this (mm) */
export const FIT_MAX_MM = 1.5;

export interface PartFit {
  /** the fitted (not the touched) top corners, mm, counter-clockwise from the part's origin */
  corners: [number, number, number][];
  /** the part's origin corner on the sheet's plane (mm) */
  origin: [number, number];
  /** the part's X axis against the sheet's +X, deg, counter-clockwise (-45..45) */
  angleDeg: number;
  /** height of the top face over the sheet's plane: the mean of the touched corners (mm) */
  topMm: number;
  /** the mean of the four measured sides (mm) */
  sideMm: number;
  /** the registration's RMS residual (mm) */
  freMm: number;
  ok: boolean;
  why: "size" | "fit" | null;
}

/** A paired-point registration: the transform that maps `model` points onto `measured` ones, both in METRES,
 * with its RMS residual in mm. NavCore.registerPoints has this shape: pass `(m, d) => core.registerPoints(m, d)`. */
export type Register = (model: V3[], measured: V3[]) => { transform: Xf; freMm: number } | null;

/** The pure fallback for Register: a rigid fit in the plane (a rotation about z and a shift; least squares), the
 * heights shifted by the mean. Same units as NavCore.registerPoints (metres in, mm out). Null for fewer than
 * 3 pairs or lists of different lengths. */
export function fitSquare2D(model: V3[], measured: V3[]): { transform: Xf; freMm: number; maxMm: number } | null {
  const n = model.length;
  if (n < 3 || measured.length !== n) return null;
  const cm = mean(model as V3mm[]), cd = mean(measured as V3mm[]);
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const a = sub(model[i] as V3mm, cm), b = sub(measured[i] as V3mm, cd);
    sx += a[0] * b[0] + a[1] * b[1];
    sy += a[0] * b[1] - a[1] * b[0];
  }
  const q = qaxis([0, 0, 1], Math.atan2(sy, sx));
  const r = applyDir({ p: [0, 0, 0], q, s: [1, 1, 1] }, cm);
  const transform: Xf = { p: [cd[0] - r[0], cd[1] - r[1], cd[2] - r[2]], q, s: [1, 1, 1] };
  const res = model.map((m, i) => len(sub(applyPoint(transform, m) as V3mm, measured[i] as V3mm)));
  return { transform, freMm: Math.sqrt(res.reduce((a, d) => a + d * d, 0) / n) * 1000, maxMm: Math.max(...res) * 1000 };
}

/** Fit the block's top face to the four touched corners (mm, any order). The corners are sorted around their
 * centroid and paired with the model square (0,0), (side,0), (side,side), (0,side) at the mean height; of the
 * four rotations of that pairing, the one whose part X axis is closest to the sheet's +X is kept.
 * `register` maps model → measured (the sheet's frame), in metres; when it returns null the pure fitSquare2D
 * is used. Null when not given exactly four points. */
export function fitPart(touched: [number, number, number][], register: Register): PartFit | null {
  if (touched.length !== 4) return null;
  const side = PILOT_PART.sideMm;
  const c = mean(touched);
  const sorted = [...touched].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
  const topMm = c[2];
  const sides = sorted.map((p, i) => Math.hypot(sorted[(i + 1) % 4][0] - p[0], sorted[(i + 1) % 4][1] - p[1], sorted[(i + 1) % 4][2] - p[2]));
  const sideMm = sides.reduce((a, v) => a + v, 0) / 4;
  const model: V3[] = [[0, 0], [side, 0], [side, side], [0, side]].map(([x, y]) => [x / 1000, y / 1000, topMm / 1000]);
  let best: { transform: Xf; freMm: number; score: number } | null = null;
  for (let k = 0; k < 4; k++) {
    const measured: V3[] = model.map((_, i) => sorted[(i + k) % 4].map((v) => v / 1000) as V3);
    const r = register(model, measured) ?? fitSquare2D(model, measured);
    if (!r) continue;
    const x = applyDir(r.transform, [1, 0, 0]);
    const score = x[0] / (Math.hypot(x[0], x[1]) || 1);
    if (!best || score > best.score) best = { transform: r.transform, freMm: r.freMm, score };
  }
  if (!best) return null;
  const corners = model.map((m) => applyPoint(best.transform, m).map((v) => v * 1000) as V3mm);
  const x = applyDir(best.transform, [1, 0, 0]);
  const sizeOk = sides.every((s) => Math.abs(s - side) <= SIZE_TOL_MM);
  const fitOk = best.freMm <= FIT_MAX_MM;
  return {
    corners,
    origin: [corners[0][0], corners[0][1]],
    angleDeg: (Math.atan2(x[1], x[0]) * 180) / Math.PI,
    topMm,
    sideMm,
    freMm: best.freMm,
    ok: sizeOk && fitOk,
    why: !sizeOk ? "size" : !fitOk ? "fit" : null,
  };
}

// ---------------- 4. the job ----------------

const round1 = (v: number) => Math.round(v * 10) / 10;

/** The screw holes' depth on a block whose top face is topMm over the bench: the screw's depth, never closer
 * than 2 mm to the bottom face, never under 3 mm. */
export const pilotDepthMm = (topMm: number) => Math.min(PILOT_SCREW.depthMm, Math.max(3, topMm - 2));

/** The pilot job for a fitted block: holes S1..S4, PILOT_PART.insetMm in from each corner (counter-clockwise
 * from the part's origin), on the top face (z). Coordinates are rounded to 0.1 mm so they read the same in the
 * recipe. Carries the pilot recipe. Build it only from a fit that is ok. */
export function pilotPlan(fit: PartFit, now = new Date().toISOString()): Plan {
  const side = PILOT_PART.sideMm, i = PILOT_PART.insetMm;
  const [c0, c1, , c3] = fit.corners as V3mm[];
  const ex = sub(c1, c0), ey = sub(c3, c0);
  const at = (u: number, v: number): V3mm => [0, 1, 2].map((k) => c0[k] + (u / side) * ex[k] + (v / side) * ey[k]) as V3mm;
  const depthMm = round1(pilotDepthMm(fit.topMm));
  const holes: PlanHole[] = [
    [i, i],
    [side - i, i],
    [side - i, side - i],
    [i, side - i],
  ].map(([u, v], k) => {
    const p = at(u, v);
    const z = Math.max(LIMITS.zMm[0], Math.min(LIMITS.zMm[1], round1(p[2])));
    return { label: `S${k + 1}`, x: round1(p[0]), y: round1(p[1]), z, depthMm, diameterMm: PILOT_SCREW.diameterMm };
  });
  const plan: Plan = {
    kind: PLAN_KIND,
    v: PLAN_VERSION,
    id: `pilot-${Date.parse(now).toString(36)}`,
    name: `Pilot: ${PILOT_PART.name.toLowerCase()}, 4 screws`,
    created: now,
    updated: now,
    author: { kind: "manual", name: "pilot" },
    reference: { kind: "sheet", id: SHEET_ID },
    holes,
  };
  return { ...plan, recipe: { id: PILOT_RECIPE_ID, md: pilotRecipe(plan) } };
}

// ---------------- 5. the recipe ----------------

export const PILOT_RECIPE_ID = "pilot-wood-block";

/** The steps before the screws, in order (the recipe's first three statements). */
export const PILOT_STEPS = {
  sheet: {
    when: "Before the block is placed",
    do: "Lay the sheets on the bench, flat, and look at each until it turns green",
    check: `every sheet in view mapped, at least ${SHEET_MIN_MARKERS} markers, steady`,
    because: "the sheets are how the phone measures everything",
  },
  place: {
    when: "The sheets are mapped",
    do: "Put the block on the sheets and clamp it",
    check: "it does not move when pushed",
    because: "a block that moves spoils the registration and every hole",
  },
  register: {
    when: "The block is clamped",
    do: "Rest the tip on each top corner and pivot the drill",
    check: `the four corners make a ${PILOT_PART.sideMm} mm square within ${FIT_MAX_MM} mm`,
    because: "the corners place the block's top face on the table",
  },
} as const;

/** The pilot recipe (an athos piece, lib/recipe.ts): #sheet, #place, #register, then one Drill statement per
 * screw (#s1..#s4) with the default Check. */
export function pilotRecipe(plan: Plan): string {
  const md = recipeFromPlan(plan, {
    id: PILOT_RECIPE_ID,
    check: DEFAULT_CHECK,
    when: `the pilot job: a ${PILOT_PART.sideMm} × ${PILOT_PART.sideMm} mm block of wood clamped on the SmartTools sheets, ${plan.holes.length} screws`,
    because: () => `a Ø${PILOT_SCREW.diameterMm} mm pilot hole, ${PILOT_PART.insetMm} mm in from two edges`,
  });
  const first = plan.holes[0] ? `#${plan.holes[0].label.toLowerCase().replace(/[^a-z0-9-]/g, "") || "hole"}` : "";
  const ids = ["sheet", "place", "register"] as const;
  const pre = ids
    .map((id, k) => {
      const s = PILOT_STEPS[id];
      const next = k + 1 < ids.length ? `#${ids[k + 1]}` : first;
      return [`## #${id}`, `**When:** ${s.when}`, `**Do:** ${s.do}`, `**Check:** ${s.check}`, `**Because:** ${s.because}`, `**Links:** ${next ? `[[${next}]]` : ""}`.trimEnd()].join("\n");
    })
    .join("\n\n");
  const at = md.indexOf("\n## #");
  return at < 0 ? `${md.trimEnd()}\n\n${pre}\n` : `${md.slice(0, at + 1)}${pre}\n\n${md.slice(at + 1)}`;
}

// ---------------- 6. where we are, and what to light up ----------------

export interface PilotState {
  phase: Phase;
  sheetOk: boolean;
  /** the table's sheets (lib/tablemap.ts): mapped, seen and being mapped, moved, not flat, missing */
  sheets: SheetState[];
  /** markers the camera reads now (the sheet phase's number) */
  markers: number;
  /** corners captured so far (0..4) */
  corners: number;
  /** the corner being captured now, or null */
  capture: { progress: number; why: CaptureWhy } | null;
  fit: PartFit | null;
  /** screws done, of total */
  done: number;
  total: number;
  /** the tip is near the active screw */
  nearScrew: boolean;
  drilling: boolean;
  ready: boolean;
  /** the stop alarm */
  stop: boolean;
  toolCalibrated: boolean;
}

export type PilotStep = "sheet" | "place" | "register" | `s${number}` | "done";

/** The recipe statement to do next. sheet: "sheet" until the sheet is seen well, then "place"; part: "place"
 * until the first corner starts, "register" until the fit is ok, then the first screw; work: the next screw
 * (s1..), "done" when all are done. */
export function currentStep(s: PilotState): PilotStep {
  if (s.phase === "sheet") return s.sheetOk ? "place" : "sheet";
  if (s.phase === "part") {
    if (s.fit?.ok) return `s${s.done + 1}`;
    if (s.corners === 0 && !s.fit && !(s.capture && s.capture.progress > 0)) return "place";
    return "register";
  }
  if (s.total > 0 && s.done >= s.total) return "done";
  return `s${s.done + 1}`;
}

export type FocusId = "phase-sheet" | "phase-part" | "phase-work" | "pause" | "stop" | "video" | "sound" | "more" | "text" | "depth" | "sheet-outline" | "part" | "corners" | "screws" | "tip" | "level";
export const FOCUS_IDS: readonly FocusId[] = ["phase-sheet", "phase-part", "phase-work", "pause", "stop", "video", "sound", "more", "text", "depth", "sheet-outline", "part", "corners", "screws", "tip", "level"];

const others = (keep: readonly FocusId[]) => FOCUS_IDS.filter((id) => !keep.includes(id));

/** What to light up now: glow = what to look at or press next, dim = not relevant now; everything not listed is
 * drawn as usual. In the sheet phase, until the table is seen well (every sheet in view mapped, enough markers,
 * steady), the sheets' outlines glow; then the part phase's button. In order of precedence: the stop alarm, an uncalibrated tool, all screws done, then the
 * phase's own rules. */
export function focus(s: PilotState): { glow: FocusId[]; dim: FocusId[] } {
  if (s.stop) return { glow: ["stop", "text"], dim: others(["stop", "text"]) };
  if (!s.toolCalibrated) return { glow: ["more"], dim: others(["more", "text"]) };
  if (s.phase === "work" && s.total > 0 && s.done >= s.total) return { glow: ["more", "pause"], dim: [] };
  if (s.phase === "sheet") {
    if (!s.sheetOk) return { glow: ["sheet-outline", "text"], dim: ["part", "corners", "screws", "depth", "level", "phase-part", "phase-work", "sound", "video"] };
    return { glow: ["phase-part"], dim: [] };
  }
  if (s.phase === "part") {
    if (s.corners < 4) return { glow: ["corners", "tip", "text"], dim: ["screws", "depth", "level", "phase-work", "sound", "video", "more"] };
    if (s.fit?.ok) return { glow: ["phase-work", "part"], dim: [] };
    return { glow: ["phase-part", "text"], dim: [] };
  }
  const dim: FocusId[] = ["corners", "depth", "level", "phase-sheet", "phase-part", "sound", "video", "more"];
  if (s.nearScrew || s.drilling) return { glow: ["level", "depth", "text"], dim: [...dim.filter((d) => d !== "depth" && d !== "level"), "sheet-outline"] };
  return { glow: ["screws", "text"], dim };
}

/** Can the app go to this phase now? sheet: always; part: the sheet is seen well; work: the block's fit is ok. */
export function canEnter(phase: Phase, s: PilotState): boolean {
  if (phase === "sheet") return true;
  if (phase === "part") return s.sheetOk;
  return !!s.fit?.ok;
}

// ---------------- 7. the top text ----------------

export type PilotTone = "next" | "ok" | "stop" | "plain";
export interface PilotText {
  icon: Icon | "corner" | "sheet";
  value: string;
  unit: string;
  tone: PilotTone;
}

const TONE: Record<Readout["level"], PilotTone> = { guide: "next", ok: "ok", warn: "next", stop: "stop" };

/** The one text on the working screen. sheet: the number of sheets mapped; part: "2/4" while capturing, then the fit's
 * error (mm); work: the simple display's readout. The stop alarm and an uncalibrated tool come first; all
 * screws done shows "4/4". */
export function pilotText(s: PilotState, r: Readout): PilotText {
  if (s.stop) return { icon: "stop", value: "", unit: "", tone: "stop" };
  if (!s.toolCalibrated) return { icon: "setup", value: "", unit: "", tone: "next" };
  if (s.phase === "sheet") return { icon: "sheet", value: String(mappedCount(s.sheets)), unit: "", tone: s.sheetOk ? "ok" : "next" };
  if (s.phase === "part") {
    if (s.corners < 4 || !s.fit) return { icon: "corner", value: `${Math.min(4, s.corners)}/4`, unit: "", tone: "next" };
    return { icon: "corner", value: s.fit.freMm.toFixed(1), unit: "mm", tone: s.fit.ok ? "ok" : "next" };
  }
  if (s.total > 0 && s.done >= s.total) return { icon: "check", value: `${s.done}/${s.total}`, unit: "", tone: "ok" };
  return { icon: r.icon, value: r.value, unit: r.unit, tone: TONE[r.level] };
}

/** What the sheet phase misses, in words: a sheet moved or not flat, a sheet still being mapped, too few markers,
 * or holding steady; else the step's Do. Sheets are numbered as printed (1..4). */
export function sheetWords(s: Pick<PilotState, "sheets" | "markers" | "sheetOk">): string {
  const n = (st: string) => (s.sheets ?? []).filter((x) => x.state === st).map((x) => x.k + 1);
  const list = (ks: number[]) => (ks.length > 1 ? `sheets ${ks.slice(0, -1).join(", ")} and ${ks[ks.length - 1]}` : `sheet ${ks[0]}`);
  const moved = n("moved"), flat = n("not-flat"), seen = n("seen");
  const it = (ks: number[]) => (ks.length > 1 ? ["them", "they turn"] : ["it", "it turns"]);
  if (moved.length) return `${list(moved)} moved: look at ${it(moved)[0]} again until ${it(moved)[1]} green`;
  if (flat.length) return `${list(flat)} ${flat.length > 1 ? "are" : "is"} not flat: tape ${it(flat)[0]} down flat`;
  if (seen.length) return `Keep looking at ${list(seen)} until ${it(seen)[1]} green`;
  if (!s.sheetOk && s.markers < SHEET_MIN_MARKERS) return `Point the drill at the sheets: ${s.markers} markers, ${SHEET_MIN_MARKERS} needed`;
  if (!s.sheetOk) return "Hold the drill steady";
  return PILOT_STEPS.sheet.do;
}

/** The words of a step, for a tap on the text: its Do (the sheet step: what it misses, when the state is given). A
 * screw step reads from the plan's recipe when there is one (else from the plan's hole, else just its name). */
export function pilotWords(step: PilotStep, plan?: Plan | null, state?: PilotState | null): string {
  if (step === "sheet" && state) return sheetWords(state);
  if (step === "sheet" || step === "place" || step === "register") return PILOT_STEPS[step].do;
  if (step === "done") return "All screws done: save the job from the menu";
  const r = plan ? recipeOfPlan(plan) : null;
  const st = r?.statements.find((x) => x.id === step);
  if (st?.do) return st.do;
  const h = plan?.holes.find((x) => x.label.toLowerCase() === step);
  return h ? drillText(h) : `Drill screw ${step.toUpperCase()}`;
}
