// The pilot job against a live navigation session (lib/pilot.ts is the pure model). Fed after each engine
// tick, it checks the sheet, captures the block's corners from the tool's 3D tip, fits the block, and gives
// the screen its state and the points to draw over the video. The same code runs in the browser (lib/tracker.ts)
// and headless in Node (scripts/pilot-sim.mts): no DOM, no storage here.

import type { EngineSnapshot, NavCore } from "./engine.ts";
import type { NavSession } from "./session.ts";
import { filteredPose } from "./bench.ts";
import { sheetOutline } from "./board.ts";
import { SHEET0_ONLY, emptyMap, placePoint, type SheetState, type SheetStateKind, type TableMap } from "./tablemap.ts";
import { applyPoint, inverse, toPose } from "./xform.ts";
import { apply, type Pose, type V3 } from "./pose.ts";
import type { Plan } from "./plan.ts";
import { ALARMS } from "./engine.ts";
import {
  CornerCapture,
  PHASES,
  SHEET_MIN_MARKERS,
  canEnter,
  fitPart,
  pilotPlan,
  sheetCheck,
  type CaptureResult,
  type PartFit,
  type Phase,
  type PilotState,
  type Register,
  type V3mm,
} from "./pilot.ts";

type P = { x: number; y: number };

/** The tip is near the active screw (pilotState's nearScrew): this far from its axis and above its surface (mm). */
export const NEAR_OFFSET_MM = 20;
export const NEAR_GAP_MM = 40;
/** a capture's progress older than this (s) is no longer shown (the tip left, or tracking stopped) */
const CAPTURE_STALE_S = 0.5;
/** The overlay's polygons are clipped in camera space before they are projected (clipToView): the near plane (m in
 * front of the lens), and a guard cone wider than any phone's view (|x| and |y| at most GUARD_TAN × depth), so the
 * lens model is never asked about a point far outside the image, where its polynomial means nothing. */
export const NEAR_M = 0.01;
export const GUARD_TAN = 1.2;

/** What is kept per device (st-pilot): the phase, the corners, the fit, and when the fit was made. */
export interface PilotSaved {
  kind: "smarttools-pilot";
  v: 1;
  phase: Phase;
  corners: V3mm[];
  fit: PartFit | null;
  /** ISO time of the last change; the pilot plan's id comes from `fitAt` */
  at: string;
  fitAt: string | null;
}

/** What the screen draws for the pilot, in the same video px as Overlay.mark. A list is empty and a face null
 * when the camera is not tracking. A polygon is clipped to what lies in front of the camera (clipToView), so it can
 * have 3 or more points (a square seen with a corner behind the camera has 5); a polygon wholly behind it, or a
 * point behind it, is left out. */
export interface PilotOverlay {
  /** the outline of every sheet that is mapped (from the map), or seen, moved or not flat (from its own pose in the
   * frame), counter-clockwise from its bottom-left corner; progress: its mapping's (1 once mapped) */
  sheetsPx: { k: number; px: P[]; state: SheetStateKind; progress: number }[];
  /** the fitted top face of the block, counter-clockwise from its origin corner */
  partPx: P[] | null;
  /** the same square on the bench (z = 0) */
  bottomPx: P[] | null;
  /** the block's four vertical edges, bottom to top, each clipped like the faces (a face clipped by the view can
   * have 3 to 8 points, so its points no longer pair up with the other face's) */
  edgesPx?: [P, P][];
  /** before a fit: the corners captured so far (done); after: the fitted corners (done) */
  cornersPx: { p: P; state: "done" | "next" }[];
  /** the screws (once the fit is ok) */
  screwsPx: { p: P; label: string; state: "done" | "active" | "todo" }[];
}

/** A screw of the pilot as the overlay and the simulator need it (mm, sheet frame). */
export interface PilotScrew {
  label: string;
  x: number;
  y: number;
  z: number;
  depthMm: number;
  state: "done" | "active" | "todo";
}

const isV3 = (v: unknown): v is V3mm => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Check something read back from storage (null if it is not a pilot this version can carry on with). */
export function readPilotSaved(x: unknown): PilotSaved | null {
  const s = x as Partial<PilotSaved> | null;
  if (!s || s.kind !== "smarttools-pilot" || s.v !== 1) return null;
  if (!PHASES.includes(s.phase as Phase) || !Array.isArray(s.corners) || s.corners.length > 4 || !s.corners.every(isV3)) return null;
  if (typeof s.at !== "string" || Number.isNaN(Date.parse(s.at))) return null;
  const f = s.fit as PartFit | null | undefined;
  const fitOk = f == null || (Array.isArray(f.corners) && f.corners.length === 4 && f.corners.every(isV3) && typeof f.ok === "boolean" && typeof f.topMm === "number" && typeof f.freMm === "number");
  if (!fitOk) return null;
  // a phase the saved data cannot support falls back to the one it can
  const fit = f ?? null;
  const phase: Phase = s.phase === "work" && !fit?.ok ? "part" : (s.phase as Phase);
  return { kind: "smarttools-pilot", v: 1, phase, corners: s.corners.map((c) => [c[0], c[1], c[2]]), fit, at: s.at, fitAt: typeof s.fitAt === "string" && !Number.isNaN(Date.parse(s.fitAt)) ? s.fitAt : null };
}

export class PilotNav {
  phase: Phase = "sheet";
  corners: V3mm[] = [];
  fit: PartFit | null = null;
  /** when the fit was made (ISO): the pilot plan is built with it, so it has the same id every time */
  fitAt: string | null = null;
  private capture = new CornerCapture([]);
  private last: { t: number; r: CaptureResult } | null = null;
  private sheetSince: number | null = null;
  private sheetLive = false;
  private markers = 0;
  private fedFrame: unknown = null;
  /** the table: its map (where the mapped sheets lie) and each sheet's state; sheet 0 alone until setTable */
  table: TableMap = emptyMap(new Date(0).toISOString());
  sheets: SheetState[] = SHEET0_ONLY.map((x) => ({ ...x }));

  constructor(saved?: PilotSaved | null) {
    if (!saved) return;
    this.phase = saved.phase;
    this.corners = saved.corners.map((c) => [c[0], c[1], c[2]]);
    this.fit = saved.fit;
    this.fitAt = saved.fitAt;
    this.capture = new CornerCapture(this.corners);
  }

  /** The table as it stands (lib/tablemap.ts SheetMapper): the sheet check waits for every sheet in view to be
   * mapped, and the overlay draws each sheet's outline. */
  setTable(map: TableMap, sheets: SheetState[]) {
    this.table = map;
    this.sheets = sheets;
  }

  /** Forget what was being measured just now (a corner's window, how long the sheet has been steady), not what was
   * captured: after a pause, the capture starts afresh. */
  interrupt() {
    this.capture.reset();
    this.last = null;
    this.sheetSince = null;
    this.fedFrame = null;
  }

  saved(now = new Date().toISOString()): PilotSaved {
    return { kind: "smarttools-pilot", v: 1, phase: this.phase, corners: this.corners.map((c) => [c[0], c[1], c[2]]), fit: this.fit, at: now, fitAt: this.fitAt };
  }

  /** The pilot job for the fit (null unless the fit is ok). The same object while the fit stays. */
  plan(): Plan | null {
    const f = this.fit;
    if (!f?.ok) return null;
    if (this.planOf?.fit !== f || this.planOf.at !== this.fitAt) this.planOf = { fit: f, at: this.fitAt, plan: pilotPlan(f, this.fitAt ?? undefined) };
    return this.planOf.plan;
  }
  private planOf: { fit: PartFit; at: string | null; plan: Plan } | null = null;

  /** After each engine advance. While in "part" with fewer than 4 corners, each new tracker frame feeds the
   * corner capture with the tool's 3D tip and axis (sheet frame, mm); the 4th corner fits the block.
   * Returns the corner just captured (its count) and the fit just made, if any. */
  step(s: NavSession, toolCalibrated: boolean, register: Register, now: () => string = () => new Date().toISOString()): { corner: number | null; fit: PartFit | null } {
    const snap = s.snapshot;
    if (!snap) return { corner: null, fit: null };
    const nav = s.scene.def.navigation;
    const pose = filteredPose(snap, s.id(nav.tool), s.id(nav.tracked));
    const tracking = !!pose && snap.markers > 0;
    this.markers = snap.markers;
    if (toolCalibrated && tracking && snap.markers >= SHEET_MIN_MARKERS) this.sheetSince ??= snap.t;
    else this.sheetSince = null;
    this.sheetLive = sheetCheck({ markers: snap.markers, tracking, toolCalibrated, steadyS: this.sheetSince == null ? 0 : snap.t - this.sheetSince, sheets: this.sheets }).ok;

    if (this.phase !== "part" || this.corners.length >= 4) return { corner: null, fit: null };
    // one sample per tracker frame
    if (s.lastFrame === this.fedFrame) return { corner: null, fit: null };
    this.fedFrame = s.lastFrame;
    if (!pose || !tracking) {
      this.capture.reset();
      this.last = null;
      return { corner: null, fit: null };
    }
    const r = this.capture.feed({ t: snap.t, tip: pose.tip, axis: pose.axis });
    this.last = { t: snap.t, r };
    if (!r.captured) return { corner: null, fit: null };
    this.corners.push(r.captured);
    this.last = null;
    let fit: PartFit | null = null;
    if (this.corners.length === 4) {
      fit = fitPart(this.corners, register);
      this.fit = fit;
      this.fitAt = now();
    }
    return { corner: this.corners.length, fit };
  }

  /** Go to a phase; refused (false) when canEnter says no. Entering "part" (again) clears the corners and the fit. */
  setPhase(p: Phase, state: PilotState): boolean {
    if (!canEnter(p, state)) return false;
    if (p === "part") {
      this.corners = [];
      this.fit = null;
      this.fitAt = null;
      this.capture = new CornerCapture([]);
      this.last = null;
    }
    this.phase = p;
    return true;
  }

  /** The pilot's state for the model's focus and text. done / total: the screws recorded, of the plan's. */
  state(snap: EngineSnapshot | null, o: { toolCalibrated: boolean; done: number; total: number }): PilotState {
    const t = snap?.t ?? 0;
    const cap = this.phase === "part" && this.corners.length < 4 && this.last && t - this.last.t <= CAPTURE_STALE_S ? { progress: this.last.r.progress, why: this.last.r.why } : null;
    const act = snap && snap.active >= 0 ? snap.targets[snap.active] : null;
    const work = this.phase === "work";
    return {
      phase: this.phase,
      // the sheet is checked live in its own phase; the later phases were entered with it seen well
      sheetOk: this.phase === "sheet" ? this.sheetLive : true,
      sheets: this.sheets.map((x) => ({ ...x })),
      markers: this.markers,
      corners: this.corners.length,
      capture: cap,
      fit: this.fit,
      done: o.done,
      total: o.total,
      nearScrew: work && !!act && act.offsetMm < NEAR_OFFSET_MM && act.gapMm < NEAR_GAP_MM,
      drilling: work && !!snap && (snap.phase === "drill" || snap.phase === "hold"),
      ready: work && !!snap?.ready,
      stop: !!snap && (snap.alarms & (ALARMS.KEEP_OUT | ALARMS.PART_MOVED)) !== 0,
      toolCalibrated: o.toolCalibrated,
    };
  }

  /** Where the sheets, the block, its corners and the screws fall in the video, with the camera and pose of the
   * snapshot being drawn (as NavSession.overlayPoints). scale: tracker frame px -> video px. */
  overlay(core: NavCore, s: NavSession, screws: PilotScrew[], scale = 1): PilotOverlay {
    const empty: PilotOverlay = { sheetsPx: [], partPx: null, bottomPx: null, cornersPx: [], screwsPx: [] };
    const snap = s.snapshot;
    if (!snap) return empty;
    const nav = s.scene.def.navigation;
    const camN = snap.nodes.find((n) => n.id === s.id(nav.tracked));
    const sheetW = s.world(nav.reference, snap);
    if (!camN || !sheetW || camN.status === "lost" || camN.status === "stale") return empty;
    const pose = toPose(inverse(camN.world));
    const cam = s.lastFrame?.camera ?? s.tracker.effectiveCamera;
    const scaled = (q: P | null) => (q ? { x: q.x * scale, y: q.y * scale } : null);
    // camera-space points of sheet-frame points (mm)
    const inCam = (mm: V3mm[]): V3[] => mm.map((p) => apply(pose, applyPoint(sheetW, [p[0] / 1000, p[1] / 1000, p[2] / 1000] as V3)));
    const project = (mm: V3mm[]): (P | null)[] => (mm.length ? core.projectPoints(cam, pose, mm.map((p) => applyPoint(sheetW, [p[0] / 1000, p[1] / 1000, p[2] / 1000] as V3))).map(scaled) : []);
    // a polygon given in camera space: its visible part, projected (null when nothing of it is in front)
    const face = (c: V3[]): P[] | null => {
      const v = clipToView(c);
      if (v.length < 3) return null;
      const q = core.projectPoints(cam, CAMERA_POSE, v).map(scaled);
      return q.every((p) => p) ? (q as P[]) : null;
    };
    const outline = sheetOutline();
    const sheetsPx: PilotOverlay["sheetsPx"] = [];
    for (const st of this.sheets) {
      const pl = st.k === 0 ? { x: 0, y: 0, yaw: 0 } : this.table.sheets[st.k];
      if (st.state === "mapped" && pl) {
        const px = face(inCam(outline.map((c) => placePoint(pl, c)).map((c) => [c.x * 1000, c.y * 1000, 0] as V3mm)));
        if (px) sheetsPx.push({ k: st.k, px, state: st.state, progress: 1 });
        continue;
      }
      // a sheet not mapped: from its own pose in the last frame
      const own = st.state === "seen" || st.state === "moved" || st.state === "not-flat" ? s.lastFrame?.sheets?.find((v) => v.k === st.k)?.pose : undefined;
      if (!own) continue;
      const px = face(outline.map((c) => apply(own, [c.x, c.y, 0])));
      if (px) sheetsPx.push({ k: st.k, px, state: st.state, progress: st.progress });
    }
    const top = this.fit ? this.fit.corners.map((c) => [c[0], c[1], c[2]] as V3mm) : null;
    const topCam = top ? inCam(top) : null;
    const botCam = top ? inCam(top.map((c) => [c[0], c[1], 0] as V3mm)) : null;
    const partPx = topCam ? face(topCam) : null;
    const bottomPx = botCam ? face(botCam) : null;
    const edgesPx: [P, P][] = [];
    if (topCam && botCam) {
      for (let i = 0; i < topCam.length; i++) {
        const seg = clipToView([botCam[i], topCam[i]], false);
        if (seg.length < 2) continue;
        const q = core.projectPoints(cam, CAMERA_POSE, seg).map(scaled);
        if (q[0] && q[1]) edgesPx.push([q[0], q[1]]);
      }
    }
    const cornerSrc = top ?? this.corners;
    const cornersPx = project(cornerSrc).flatMap((p) => (p ? [{ p, state: "done" as const }] : []));
    const screwsPx = project(screws.map((x) => [x.x, x.y, x.z] as V3mm)).flatMap((p, i) => (p ? [{ p, label: screws[i].label, state: screws[i].state }] : []));
    return { sheetsPx, partPx, bottomPx, edgesPx, cornersPx, screwsPx };
  }
}

/** The camera's own frame as a pose (points already in camera space). */
const CAMERA_POSE: Pose = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], rms: 0 };

/** Clip a polygon given in camera space (m, z forward) to what the overlay can draw: Sutherland-Hodgman against the
 * near plane z = near, then the four sides of the guard cone (|x|, |y| <= guardTan × z). The part in front comes
 * back in order (a square with one corner behind the camera gives a pentagon); nothing when it is wholly behind.
 * closed = false clips a segment (two points): its visible piece, or nothing. */
export function clipToView(poly: readonly V3[], closed = true, near = NEAR_M, guardTan = GUARD_TAN): V3[] {
  // inside when d(p) >= 0
  const planes: ((p: V3) => number)[] = [
    (p) => p[2] - near,
    (p) => guardTan * p[2] - p[0],
    (p) => guardTan * p[2] + p[0],
    (p) => guardTan * p[2] - p[1],
    (p) => guardTan * p[2] + p[1],
  ];
  const cut = (a: V3, b: V3, da: number, db: number): V3 => {
    const t = da / (da - db);
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
  };
  let out: V3[] = poly.map((p) => [p[0], p[1], p[2]]);
  for (const d of planes) {
    if (!out.length) break;
    const inp = out;
    out = [];
    if (!closed) {
      // a segment: keep its inside piece
      for (let i = 0; i + 1 < inp.length; i++) {
        const a = inp[i], b = inp[i + 1], da = d(a), db = d(b);
        if (da < 0 && db < 0) continue;
        const a2 = da >= 0 ? a : cut(a, b, da, db);
        const b2 = db >= 0 ? b : cut(a, b, da, db);
        if (!out.length) out.push(a2);
        out.push(b2);
      }
      if (inp.length === 1 && d(inp[0]) >= 0) out.push(inp[0]);
      continue;
    }
    for (let i = 0; i < inp.length; i++) {
      const a = inp[(i + inp.length - 1) % inp.length], b = inp[i], da = d(a), db = d(b);
      if (db >= 0) {
        if (da < 0) out.push(cut(a, b, da, db));
        out.push(b);
      } else if (da >= 0) out.push(cut(a, b, da, db));
    }
  }
  return out;
}

/** The screws of a plan with their state: done when recorded (or drilled in the engine), active when the engine
 * guides to it. */
export function pilotScrews(plan: Plan, snap: EngineSnapshot | null, name: (id: number) => string, recorded: readonly string[]): PilotScrew[] {
  const drilled = new Set(snap ? snap.targets.filter((t) => t.drilled).map((t) => name(t.id)) : []);
  const active = snap && snap.active >= 0 ? name(snap.targets[snap.active].id) : null;
  return plan.holes.map((h) => ({
    label: h.label,
    x: h.x,
    y: h.y,
    z: h.z ?? 0,
    depthMm: h.depthMm,
    state: recorded.includes(h.label) || drilled.has(h.label) ? "done" : h.label === active ? "active" : "todo",
  }));
}

/** The screw the person works next: the active one, else the first not done (null when all are done). */
export function nextScrew(screws: PilotScrew[]): PilotScrew | null {
  return screws.find((s) => s.state === "active") ?? screws.find((s) => s.state === "todo") ?? null;
}
