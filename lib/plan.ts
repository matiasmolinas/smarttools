// The plan file (docs/ARCHITECTURE.md §3): where each hole goes on the reference sheet, how deep and how wide.
// Made on the phone with the tool as a pointer, by an expert, or (later) by AI in the cloud. Whoever made it,
// the phone validates it here before the engine sees it: the cloud never reaches the engine except through a
// plan that passed these checks.
//
// Coordinates: the sheet's frame, millimetres, origin at the sheet's centre, +x right, +y up, +z out of the
// sheet towards the camera. Holes are drilled square to the sheet (into -z) in v1.

import type { EngineSnapshot } from "./engine.ts";
import { BOARD_TARGETS, SHEET } from "./board.ts";

export const PLAN_KIND = "smarttools-plan";
export const PLAN_VERSION = 1;
export const SHEET_ID = "smarttools-a4-v2";

export interface PlanHole {
  label: string;
  /** mm, sheet frame */
  x: number;
  y: number;
  depthMm: number;
  diameterMm: number;
  /** mm above the sheet's plane where the hole starts (the top of a part on the bench); absent = on the sheet */
  z?: number;
}

export interface Plan {
  kind: typeof PLAN_KIND;
  v: typeof PLAN_VERSION;
  id: string;
  name: string;
  /** ISO times */
  created: string;
  updated: string;
  author: { kind: "pointer" | "expert" | "ai" | "manual"; name?: string };
  reference: { kind: "sheet"; id: typeof SHEET_ID };
  holes: PlanHole[];
  notes?: string;
  /** the recipe this plan came from: its id and its Markdown, so the phone can work its steps and Checks */
  recipe?: { id: string; md: string };
  /** ISO time a person reviewed it (set when an escalated recipe is approved) */
  reviewed?: string;
}

export const LIMITS = {
  holes: 64,
  /** how far from the sheet's centre a hole may be (mm): the sheet must stay in view near it */
  reachMm: 400,
  depthMm: [1, 80] as const,
  diameterMm: [1, 20] as const,
  /** two holes closer than this are a mistake (a double tap of "mark") */
  minSpacingMm: 3,
  labelChars: 12,
  /** the tip must touch the surface to mark (|z| on the sheet's plane, mm) */
  touchMm: 3,
  /** a recipe kept with its plan (characters of Markdown) */
  recipeChars: 20_000,
  /** how high above the sheet's plane a hole may start (mm) */
  zMm: [0, 200] as const,
};

export const DEFAULT_HOLE = { depthMm: 30, diameterMm: 6 };

const uid = () => (globalThis.crypto?.randomUUID?.() ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

export function newPlan(name: string, author: Plan["author"] = { kind: "pointer" }, now = new Date().toISOString()): Plan {
  return { kind: PLAN_KIND, v: PLAN_VERSION, id: uid(), name, created: now, updated: now, author, reference: { kind: "sheet", id: SHEET_ID }, holes: [] };
}

/** The sheet's own three targets as a plan: what the app does when no plan is chosen. */
export const SHEET_PLAN: Plan = {
  ...newPlan("Sheet targets A1-A3", { kind: "manual", name: "SmartTools" }, "2026-11-20T00:00:00.000Z"),
  id: "sheet-targets",
  holes: BOARD_TARGETS.map((t) => ({ label: t.label, x: t.x * 1000, y: t.y * 1000, depthMm: 35, diameterMm: 6 })),
};

/** A demo job: four holes on a 40 × 40 mm square (a bracket pattern), 20 mm deep, in the sheet's gaps between
 * markers, clear of A2 (the calibration and check target) and with 8 or more markers in view at every hole.
 * Tape the sheet on a board at least 30 mm thick. */
export const DEMO_PLAN: Plan = {
  ...newPlan("Demo: 4 holes, 40 mm square, 20 mm deep", { kind: "manual", name: "SmartTools" }, "2026-11-21T00:00:00.000Z"),
  id: "demo-4-holes",
  holes: [
    [0, 60],
    [40, 60],
    [40, 20],
    [0, 20],
  ].map(([x, y], i) => ({ label: `D${i + 1}`, x, y, depthMm: 20, diameterMm: 6 })),
};

/** The plans the app always has, before any of the person's own. */
export const BUILT_IN_PLANS: Plan[] = [SHEET_PLAN, DEMO_PLAN];

export type Checked = { ok: true; plan: Plan } | { ok: false; errors: string[] };

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string";

/** Validate anything (a file, a sync, an AI's output) as a plan. Deterministic; every problem is listed. */
export function validatePlan(x: unknown): Checked {
  const e: string[] = [];
  const p = x as Partial<Plan> | null;
  if (!p || typeof p !== "object") return { ok: false, errors: ["not an object"] };
  if (p.kind !== PLAN_KIND) e.push(`kind must be "${PLAN_KIND}"`);
  if (p.v !== PLAN_VERSION) e.push(`version ${String(p.v)} is not supported (expected ${PLAN_VERSION})`);
  if (!str(p.id) || !p.id) e.push("id is missing");
  if (!str(p.name) || !p.name.trim()) e.push("name is missing");
  for (const k of ["created", "updated"] as const) if (!str(p[k]) || Number.isNaN(Date.parse(p[k]!))) e.push(`${k} is not a date`);
  if (!p.author || !["pointer", "expert", "ai", "manual"].includes(p.author.kind)) e.push("author.kind must be pointer, expert, ai or manual");
  if (p.reference?.kind !== "sheet" || p.reference.id !== SHEET_ID) e.push(`reference must be the sheet "${SHEET_ID}"`);
  if (!Array.isArray(p.holes)) e.push("holes must be a list");
  else {
    if (p.holes.length === 0) e.push("a plan needs at least one hole");
    if (p.holes.length > LIMITS.holes) e.push(`at most ${LIMITS.holes} holes`);
    const seen = new Set<string>();
    p.holes.forEach((h, i) => {
      const at = `hole ${i + 1}`;
      if (!str(h?.label) || !h.label.trim() || h.label.length > LIMITS.labelChars) e.push(`${at}: label must be 1-${LIMITS.labelChars} characters`);
      else if (seen.has(h.label)) e.push(`${at}: label "${h.label}" is repeated`);
      else seen.add(h.label);
      if (!num(h?.x) || !num(h?.y)) e.push(`${at}: x and y must be numbers (mm)`);
      else if (Math.hypot(h.x, h.y) > LIMITS.reachMm) e.push(`${at}: more than ${LIMITS.reachMm} mm from the sheet`);
      if (!num(h?.depthMm) || h.depthMm < LIMITS.depthMm[0] || h.depthMm > LIMITS.depthMm[1]) e.push(`${at}: depth must be ${LIMITS.depthMm[0]}-${LIMITS.depthMm[1]} mm`);
      if (!num(h?.diameterMm) || h.diameterMm < LIMITS.diameterMm[0] || h.diameterMm > LIMITS.diameterMm[1]) e.push(`${at}: diameter must be ${LIMITS.diameterMm[0]}-${LIMITS.diameterMm[1]} mm`);
      if (h?.z !== undefined && (!num(h.z) || h.z < LIMITS.zMm[0] || h.z > LIMITS.zMm[1])) e.push(`${at}: z must be ${LIMITS.zMm[0]}-${LIMITS.zMm[1]} mm above the sheet`);
    });
    for (let i = 0; i < p.holes.length; i++)
      for (let j = i + 1; j < p.holes.length; j++) {
        const a = p.holes[i], b = p.holes[j];
        if (num(a?.x) && num(a?.y) && num(b?.x) && num(b?.y) && Math.hypot(a.x - b.x, a.y - b.y) < LIMITS.minSpacingMm)
          e.push(`holes ${i + 1} and ${j + 1} are closer than ${LIMITS.minSpacingMm} mm`);
      }
  }
  // only the shape here: lib/recipe.ts imports this file, so lib/gate.ts is where a recipe is parsed
  if (p.recipe !== undefined) {
    const r = p.recipe as Partial<NonNullable<Plan["recipe"]>> | null;
    if (!r || typeof r !== "object") e.push("recipe must be an object with an id and its Markdown");
    else {
      if (!str(r.id) || !r.id.trim()) e.push("recipe.id is missing");
      if (!str(r.md)) e.push("recipe.md must be text");
      else if (r.md.length > LIMITS.recipeChars) e.push(`recipe.md is longer than ${LIMITS.recipeChars} characters`);
      else if (!/^##\s+#[\w.-]+\s*$/m.test(r.md)) e.push("recipe.md is not a recipe: no statements (## #id)");
    }
  }
  if (p.reviewed !== undefined && (!str(p.reviewed) || Number.isNaN(Date.parse(p.reviewed)))) e.push("reviewed is not a date");
  return e.length ? { ok: false, errors: e } : { ok: true, plan: p as Plan };
}

/** The scene's targets for a plan (metres), for smartToolsScene({ targets }). z only when the hole has one, so
 * an old plan's targets are exactly as before. */
export function planTargets(plan: Plan): { label: string; x: number; y: number; z?: number; depthMm: number; diameterMm: number }[] {
  return plan.holes.map((h) => ({ label: h.label, x: h.x / 1000, y: h.y / 1000, ...(h.z !== undefined ? { z: h.z / 1000 } : {}), depthMm: h.depthMm, diameterMm: h.diameterMm }));
}
/** Depth per target, in the plan's order (engine.setTargetDepths). */
export const planDepths = (plan: Plan) => plan.holes.map((h) => h.depthMm);

export type Mark = { ok: true; x: number; y: number } | { ok: false; reason: string };

/** Where the tool's tip touches the sheet's plane, from an engine snapshot (sheet = world). Refuses when the
 * tool is not calibrated, the camera (the tracked node the tool hangs from) is not measured now, or the tip is
 * not touching the surface. */
export function tipOnSheet(s: EngineSnapshot | null, toolId: number, trackedId?: number): Mark {
  const n = s?.nodes.find((x) => x.id === toolId);
  if (!s || !n) return { ok: false, reason: "No tool yet" };
  if (n.status === "uncalibrated") return { ok: false, reason: "Calibrate first" };
  const measured = trackedId == null ? n : s.nodes.find((x) => x.id === trackedId);
  if (!measured || (measured.status !== "valid" && measured.status !== "predicted")) return { ok: false, reason: "Show the markers" };
  const [x, y, z] = n.world.p.map((v) => v * 1000);
  if (Math.abs(z) > LIMITS.touchMm) return { ok: false, reason: `Touch the surface (${Math.abs(z).toFixed(0)} mm off)` };
  return { ok: true, x: round1(x), y: round1(y) };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Add a hole where the tip is. Labels run H1, H2, ... */
export function addHole(plan: Plan, at: { x: number; y: number }, hole = DEFAULT_HOLE, now = new Date().toISOString()): { ok: true; plan: Plan } | { ok: false; reason: string } {
  if (plan.holes.length >= LIMITS.holes) return { ok: false, reason: `At most ${LIMITS.holes} holes` };
  if (Math.hypot(at.x, at.y) > LIMITS.reachMm) return { ok: false, reason: "Too far from the sheet" };
  const near = plan.holes.find((h) => Math.hypot(h.x - at.x, h.y - at.y) < LIMITS.minSpacingMm);
  if (near) return { ok: false, reason: `Already marked: ${near.label}` };
  let n = plan.holes.length + 1;
  while (plan.holes.some((h) => h.label === `H${n}`)) n++;
  return { ok: true, plan: { ...plan, updated: now, holes: [...plan.holes, { label: `H${n}`, x: at.x, y: at.y, ...hole }] } };
}

export function removeLastHole(plan: Plan, now = new Date().toISOString()): Plan {
  return { ...plan, updated: now, holes: plan.holes.slice(0, -1) };
}

/** Is a point on the printed sheet (mm)? For the HUD's hint, not a rule. */
export const onSheet = (x: number, y: number) => Math.abs(x) <= SHEET.w * 500 && Math.abs(y) <= SHEET.h * 500;
