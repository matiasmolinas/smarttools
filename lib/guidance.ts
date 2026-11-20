// Guidance drawn on the part itself (renderer-agnostic, from an engine snapshot):
//  - the next hole glows; screws already in are green, the rest numbered in the job's order; going out
//    of order is flagged;
//  - an approach tunnel along the active hole's axis, coloured by the error (like an approach to a runway);
//  - "x-ray": the screw's path inside the part, how far it has gone, and how much material is left
//    beyond its tip (a warning when it would break through the far side).
// Renderers: lib/render/guidance3d.ts (three.js: the 3D view and the phone's view), the phone HUD.

import type { EngineSnapshot, SolidSpec } from "./engine.ts";
import type { SceneDef } from "./scenedef.ts";
import type { V3 } from "./pose.ts";
import { applyDir, applyPoint, inverse, qrot, qconj, type Xf } from "./xform.ts";

export type HoleState = "active" | "next" | "done" | "pending";
export interface HoleMark {
  name: string;
  world: Xf;
  state: HoleState;
  /** 1-based position in the job's order */
  order: number;
  depthMm: number;
  /** finished holes: how well (heat map) */
  quality?: "good" | "fair" | "redo";
}
export interface Tunnel {
  world: Xf;
  /** how far out of the hole it reaches, m */
  length: number;
  /** "ok" inside the requirement, "warn" close, "bad" off */
  state: "ok" | "warn" | "bad";
  offsetMm: number;
  angleDeg: number;
  /** the tip's gap to the surface (mm): close = focus on this hole only */
  gapMm: number;
}
export interface XRay {
  world: Xf;
  plannedMm: number;
  drivenMm: number;
  /** material along the axis from the surface (mm); Infinity if the axis never leaves the part */
  materialMm: number;
  /** material left beyond the screw's planned tip (mm), negative = it breaks through */
  leftMm: number;
  breakthrough: boolean;
}
export interface Guidance {
  holes: HoleMark[];
  active: string | null;
  /** the first hole not done, in the job's order */
  next: string | null;
  /** the user is on a hole before its turn */
  outOfOrder: { active: string; expected: string } | null;
  tunnel: Tunnel | null;
  xray: XRay | null;
}

export interface GuidanceInput {
  snap: EngineSnapshot;
  /** target names in the job's order (the scene's navigation order) */
  order: string[];
  ids: Record<string, number>;
  /** depth per target (mm), in `order` */
  depths: number[];
  /** the parts as convex solids where the engine has them (for x-ray) */
  solids?: SolidSpec[];
  requirement?: { offsetMm: number; angleDeg: number };
  /** whether a hole's part is located (holes on parts not located yet are not drawn: their place is a guess) */
  located?: (name: string) => boolean;
  /** holes the user chose to do later (a twist of the drill) */
  skipped?: string[];
  /** grade of finished holes (heat map) */
  quality?: (name: string) => "good" | "fair" | "redo" | undefined;
}

/** Where a ray (from `p` along unit `d`, world) runs inside the solids: the first contiguous stretch from
 * the start (m), as [enter, exit]; null if it does not hit them. */
export function materialAlong(solids: SolidSpec[], p: V3, d: V3): [number, number] | null {
  const spans: [number, number][] = [];
  for (const s of solids) {
    const qi = qconj(s.pose.q);
    const o = qrot(qi, [p[0] - s.pose.p[0], p[1] - s.pose.p[1], p[2] - s.pose.p[2]]);
    const dl = qrot(qi, d);
    let k0 = -Infinity, k1 = Infinity;
    let hit = true;
    for (const [nx, ny, nz, dd] of s.planes) {
      const den = nx * dl[0] + ny * dl[1] + nz * dl[2];
      const num = dd - (nx * o[0] + ny * o[1] + nz * o[2]);
      if (Math.abs(den) < 1e-15) {
        if (num < 0) hit = false;
        continue;
      }
      const k = num / den;
      if (den < 0) k0 = Math.max(k0, k);
      else k1 = Math.min(k1, k);
    }
    if (hit && k0 < k1 && k1 > 0) spans.push([Math.max(0, k0), k1]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let [a, b] = spans[0];
  for (const [c, e] of spans.slice(1)) {
    if (c > b + 1e-4) break; // a gap of air: the stretch ends
    b = Math.max(b, e);
  }
  return [a, b];
}

export function guidance(g: GuidanceInput): Guidance {
  const { snap } = g;
  const req = g.requirement ?? { offsetMm: 0.75, angleDeg: 0.5 };
  const worldOf = (id: number) => snap.nodes.find((n) => n.id === id)?.world ?? null;
  const done = new Set(snap.targets.filter((t) => t.drilled).map((t) => t.id));
  const activeId = snap.active >= 0 ? snap.targets[snap.active].id : -1;
  const activeName = g.order.find((n) => g.ids[n] === activeId) ?? null;
  const later = new Set(g.skipped ?? []);
  const next = g.order.find((n) => !done.has(g.ids[n]) && !later.has(n)) ?? g.order.find((n) => !done.has(g.ids[n])) ?? null;
  const holes: HoleMark[] = [];
  const located = g.located ?? (() => true);
  g.order.forEach((name, i) => {
    const w = worldOf(g.ids[name]);
    if (!w || !located(name)) return;
    const id = g.ids[name];
    const state: HoleState = done.has(id) ? "done" : id === activeId ? "active" : name === next ? "next" : "pending";
    holes.push({ name, world: w, state, order: i + 1, depthMm: g.depths[i] ?? 0, quality: state === "done" ? g.quality?.(name) : undefined });
  });
  const ai = activeName ? g.order.indexOf(activeName) : -1;
  // out of order only once the user commits to a hole (on it, or driving), not while passing over others
  const an = snap.active >= 0 ? snap.targets[snap.active] : null;
  const committed = !!an && (an.depthMm > 0 || (an.gapMm < 5 && an.offsetMm < 3));
  const outOfOrder =
    committed && activeName && next && activeName !== next && !done.has(activeId) && !later.has(activeName) && ai > g.order.indexOf(next) && located(activeName) ? { active: activeName, expected: next } : null;

  let tunnel: Tunnel | null = null;
  let xray: XRay | null = null;
  if (snap.active >= 0 && activeName && located(activeName)) {
    const nav = snap.targets[snap.active];
    const w = worldOf(activeId)!;
    const state = nav.offsetMm < req.offsetMm && nav.angleErrDeg < req.angleDeg ? "ok" : nav.offsetMm < 3 * req.offsetMm && nav.angleErrDeg < 3 * req.angleDeg ? "warn" : "bad";
    tunnel = { world: w, length: 0.06, state, offsetMm: nav.offsetMm, angleDeg: nav.angleErrDeg, gapMm: nav.depthMm > 0 ? 0 : nav.gapMm };
    const planned = g.depths[ai] ?? 0;
    // material along the hole's axis (+Z goes into the part); start just outside the surface
    const into = applyDir(w, [0, 0, 1]);
    const start = applyPoint(w, [0, 0, -0.0005]);
    const span = g.solids?.length ? materialAlong(g.solids, start, into) : null;
    const materialMm = span ? (span[1] - Math.max(span[0], 0.0005)) * 1000 : Infinity;
    const leftMm = materialMm - planned;
    xray = { world: w, plannedMm: planned, drivenMm: Math.max(0, Math.min(planned, nav.depthMm)), materialMm, leftMm, breakthrough: leftMm < 1 };
  }
  return { holes, active: activeName, next, outOfOrder, tunnel, xray };
}

/** "Is this hole's part located": every calibrated node above it is calibrated in the snapshot. */
export function locatedFrom(def: SceneDef, snap: EngineSnapshot, ids: Record<string, number>) {
  return (name: string) => {
    let n = def.nodes.find((x) => x.name === name);
    while (n?.parent) {
      const p = def.nodes.find((x) => x.name === n!.parent);
      if (p?.kind === "calibrated" && snap.nodes.find((x) => x.id === ids[p.name])?.status === "uncalibrated") return false;
      n = p;
    }
    return true;
  };
}

/** The tool tip in a hole's frame, from world positions (for renderers that place the tip in the tunnel). */
export const inHole = (hole: Xf, pWorld: V3): V3 => applyPoint(inverse(hole), pWorld);
