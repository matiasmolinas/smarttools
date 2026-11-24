// The pilot job's model (lib/pilot.ts): the sheet check, capturing the block's corners, fitting its top face,
// the job and its recipe, and what the screen lights up at each step.

import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mts";
import {
  CAPTURE_S, CornerCapture, FIT_MAX_MM, FOCUS_IDS, PILOT_PART, PILOT_RECIPE_ID, PILOT_SCREW, PILOT_STEPS, canEnter, currentStep, fitPart, fitSquare2D, focus, pilotDepthMm,
  mappedCount, pilotPlan, pilotRecipe, pilotText, pilotWords, sheetCheck, sheetWords, type FocusId, type PartFit, type PilotState, type Register, type TipSample,
} from "../lib/pilot.ts";
import { DEMO_PLAN, SHEET_PLAN, planTargets, validatePlan } from "../lib/plan.ts";
import { parseRecipe, drillOf, DEFAULT_CHECK } from "../lib/recipe.ts";
import { gateRecipe } from "../lib/gate.ts";
import { smartToolsScene } from "../lib/scenedef.ts";
import { dockRig } from "../lib/dockrig.ts";
import type { Readout } from "../lib/hudsimple.ts";
import { SHEET0_ONLY, type SheetState } from "../lib/tablemap.ts";

const AT = "2026-11-24T10:00:00.000Z";
const realRegister: Register = (m, d) => core.registerPoints(m, d);
const noRegister: Register = () => null;
const REGISTERS: [string, Register][] = [["engine", realRegister], ["fallback", noRegister]];

// ---------------- sheet check ----------------

test("sheetCheck: the setup first, then the markers, then time", () => {
  const good = { markers: 8, tracking: true, toolCalibrated: true, steadyS: 1.2 };
  assert.deepEqual(sheetCheck(good), { ok: true, need: null });
  assert.deepEqual(sheetCheck({ ...good, toolCalibrated: false }), { ok: false, need: "setup" });
  assert.deepEqual(sheetCheck({ ...good, markers: 5 }), { ok: false, need: "markers" });
  assert.deepEqual(sheetCheck({ ...good, tracking: false }), { ok: false, need: "markers" });
  assert.deepEqual(sheetCheck({ ...good, steadyS: 0.5 }), { ok: false, need: "steady" });
  assert.equal(sheetCheck({ ...good, markers: 6, steadyS: 1 }).ok, true);
});

const sheetsOf = (...st: SheetState["state"][]): SheetState[] => st.map((state, k) => ({ k, state, progress: state === "mapped" ? 1 : 0.5 }));

test("sheetCheck: a sheet in view still being mapped holds it; moved, not flat or missing sheets do not", () => {
  const good = { markers: 8, tracking: true, toolCalibrated: true, steadyS: 1.2 };
  assert.deepEqual(sheetCheck({ ...good, sheets: sheetsOf("mapped", "seen", "missing", "missing") }), { ok: false, need: "mapping" });
  assert.deepEqual(sheetCheck({ ...good, steadyS: 0, sheets: sheetsOf("mapped", "seen") }), { ok: false, need: "mapping" });
  assert.deepEqual(sheetCheck({ ...good, markers: 2, sheets: sheetsOf("mapped", "seen") }), { ok: false, need: "markers" });
  assert.equal(sheetCheck({ ...good, sheets: sheetsOf("mapped", "mapped", "moved", "not-flat") }).ok, true);
  assert.equal(sheetCheck({ ...good, sheets: sheetsOf("mapped", "missing", "missing", "missing") }).ok, true);
  assert.equal(mappedCount(sheetsOf("mapped", "mapped", "seen", "mapped")), 3);
  assert.equal(mappedCount(undefined), 1);
});

test("sheetWords: what the sheet phase misses, sheets numbered as printed", () => {
  const base = { markers: 8, sheetOk: false };
  assert.equal(sheetWords({ ...base, sheets: sheetsOf("mapped", "moved", "mapped", "missing") }), "sheet 2 moved: look at it again until it turns green");
  assert.equal(sheetWords({ ...base, sheets: sheetsOf("mapped", "not-flat", "not-flat") }), "sheets 2 and 3 are not flat: tape them down flat");
  assert.equal(sheetWords({ ...base, sheets: sheetsOf("mapped", "seen", "mapped", "seen") }), "Keep looking at sheets 2 and 4 until they turn green");
  assert.match(sheetWords({ markers: 3, sheetOk: false, sheets: sheetsOf("mapped") }), /3 markers, 6 needed/);
  assert.equal(sheetWords({ ...base, sheets: sheetsOf("mapped") }), "Hold the drill steady");
  assert.equal(sheetWords({ ...base, sheetOk: true, sheets: sheetsOf("mapped") }), PILOT_STEPS.sheet.do);
  // pilotWords gives them for the sheet step when it has the state
  assert.equal(pilotWords("sheet", null, S({ sheets: sheetsOf("mapped", "seen"), markers: 8 })), "Keep looking at sheet 2 until it turns green");
});

// ---------------- corner capture ----------------

const HZ = 30;
/** Samples at 30 Hz for `s` seconds from t0: the tip at `at` (plus a wobble), the axis pivoting ±deg about x. */
function pivot(at: [number, number, number], s: number, deg = 8, t0 = 0, wobbleMm = 0.2): TipSample[] {
  const n = Math.round(s * HZ) + 1;
  return Array.from({ length: n }, (_, k) => {
    const t = t0 + k / HZ;
    const a = ((deg * Math.PI) / 180) * Math.sin(2 * Math.PI * 0.7 * t);
    return { t, tip: [at[0] + wobbleMm * Math.sin(5 * t), at[1] + wobbleMm * Math.cos(3 * t), at[2]], axis: [0, Math.sin(a), -Math.cos(a)] };
  });
}

test("CornerCapture: a pivot on a fixed point is captured after 1.5 s, progress grows until then", () => {
  const c = new CornerCapture([]);
  const samples = pivot([10, 20, 18], 2);
  let got: [number, number, number] | null = null, at = -1, last = -1;
  for (const s of samples) {
    const r = c.feed(s);
    if (!got) {
      assert.ok(r.progress >= last, "progress grows");
      last = r.progress;
    }
    if (r.captured && !got) {
      got = r.captured;
      at = s.t;
      assert.ok(r.rmsMm < 0.5);
      assert.equal(r.progress, 1);
    }
  }
  assert.ok(got, "captured");
  assert.ok(Math.abs(at - CAPTURE_S) < 1e-6, `captured at ${at}`);
  assert.ok(Math.hypot(got![0] - 10, got![1] - 20, got![2] - 18) < 0.3);
  assert.equal(c.corners.length, 1);
});

test("CornerCapture: frames at 15 fps that do not fall on exact times are captured too (once the window spans 1.5 s)", () => {
  const c = new CornerCapture([]);
  let at = -1;
  for (let k = 0; k < 60 && at < 0; k++) {
    const t = 0.013 + k / 15 + (k % 3) * 0.004;
    const a = ((8 * Math.PI) / 180) * Math.sin(2 * Math.PI * 0.7 * t);
    const r = c.feed({ t, tip: [10, 20, 18], axis: [0, Math.sin(a), -Math.cos(a)] });
    if (r.captured) at = t;
  }
  assert.ok(at > 0, "captured");
  assert.ok(at - 0.013 >= CAPTURE_S - 1e-9 && at - 0.013 < CAPTURE_S + 0.1, `captured ${(at - 0.013).toFixed(3)} s after the first frame`);
});

test("CornerCapture: not when low, moving, near a corner taken, or not pivoted", () => {
  const none = (c: CornerCapture, ss: TipSample[]) => ss.map((s) => c.feed(s)).filter((r) => r.captured).length;
  // low: on the bench
  const low = new CornerCapture([]);
  assert.equal(none(low, pivot([10, 20, 2], 3)), 0);
  assert.equal(low.feed(pivot([10, 20, 2], 0)[0]).why, "low");
  // moving: the tip slides 5 mm/s
  const mov = new CornerCapture([]);
  const slide = pivot([10, 20, 18], 3).map((s) => ({ ...s, tip: [s.tip[0] + 5 * s.t, s.tip[1], s.tip[2]] as [number, number, number] }));
  const rs = slide.map((s) => mov.feed(s));
  assert.equal(rs.filter((r) => r.captured).length, 0);
  assert.ok(rs.some((r) => r.why === "moving"));
  assert.ok(Math.max(...rs.map((r) => r.progress)) < 1);
  // near a corner already taken
  const near = new CornerCapture([[15, 20, 18]]);
  assert.equal(none(near, pivot([10, 20, 18], 3)), 0);
  assert.equal(near.feed(pivot([10, 20, 18], 0)[0]).why, "near-taken");
  // held still, no pivot
  const still = new CornerCapture([]);
  const rs2 = pivot([10, 20, 18], 3, 0).map((s) => still.feed(s));
  assert.equal(rs2.filter((r) => r.captured).length, 0);
  assert.equal(rs2.at(-1)!.why, "pivot");
  // a pivot of only 2°
  assert.equal(none(new CornerCapture([]), pivot([10, 20, 18], 3, 1)), 0);
});

test("CornerCapture: after a capture the window starts again; the next corner far away is captured too", () => {
  const c = new CornerCapture([]);
  const caps = [...pivot([0, 0, 18], 1.6), ...pivot([100, 0, 18], 1.6, 8, 2)].map((s) => c.feed(s)).filter((r) => r.captured);
  assert.equal(caps.length, 2);
  // staying on the first corner after its capture: near-taken, not a second capture
  const c2 = new CornerCapture([]);
  assert.equal(pivot([0, 0, 18], 4).map((s) => c2.feed(s)).filter((r) => r.captured).length, 1);
});

// ---------------- registration ----------------

/** The corners of a block: side, rotated `deg` about its origin corner, shifted, at height top, with noise. */
function block(o: { side?: number; sideY?: number; deg?: number; at?: [number, number]; top?: number; noise?: number; skewDeg?: number } = {}) {
  const sx = o.side ?? 100, sy = o.sideY ?? sx, a = ((o.deg ?? 0) * Math.PI) / 180, k = ((o.skewDeg ?? 0) * Math.PI) / 180;
  const [ox, oy] = o.at ?? [0, 0];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * (o.noise ?? 0);
  const local = [[0, 0], [sx, 0], [sx + sy * Math.sin(k), sy * Math.cos(k)], [sy * Math.sin(k), sy * Math.cos(k)]];
  return local.map(([x, y]) => [ox + x * Math.cos(a) - y * Math.sin(a) + rnd(), oy + x * Math.sin(a) + y * Math.cos(a) + rnd(), (o.top ?? 18) + rnd()] as [number, number, number]);
}
const scramble = <T,>(a: T[]) => [a[2], a[0], a[3], a[1]];

for (const [name, reg] of REGISTERS) {
  test(`fitPart (${name}): a block rotated 20° and shifted, scrambled, 0.3 mm of noise`, () => {
    const truth = block({ deg: 20, at: [130, -40] });
    const f = fitPart(scramble(block({ deg: 20, at: [130, -40], noise: 0.3 })), reg)!;
    assert.ok(f);
    assert.ok(Math.abs(f.angleDeg - 20) < 0.5, `angle ${f.angleDeg}`);
    assert.ok(Math.hypot(f.origin[0] - 130, f.origin[1] + 40) < 0.6, `origin ${f.origin}`);
    assert.ok(Math.abs(f.sideMm - 100) < 0.5, `side ${f.sideMm}`);
    assert.ok(Math.abs(f.topMm - 18) < 0.3);
    assert.ok(f.freMm < 0.6 && f.freMm <= FIT_MAX_MM, `fre ${f.freMm}`);
    assert.equal(f.ok, true);
    assert.equal(f.why, null);
    // fitted corners: counter-clockwise from the origin, close to the truth, and an exact 100 mm square
    f.corners.forEach((c, i) => assert.ok(Math.hypot(c[0] - truth[i][0], c[1] - truth[i][1]) < 0.6, `corner ${i}`));
    for (let i = 0; i < 4; i++) {
      const a = f.corners[i], b = f.corners[(i + 1) % 4];
      assert.ok(Math.abs(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) - 100) < 1e-6);
    }
  });

  test(`fitPart (${name}): the part's X axis is the one closest to the sheet's +X`, () => {
    for (const deg of [-40, -5, 30, 60, 100, 170, 230]) {
      const f = fitPart(block({ deg, at: [50, 50] }), reg)!;
      const want = ((((deg + 45) % 90) + 90) % 90) - 45;
      assert.ok(Math.abs(f.angleDeg - want) < 1e-3, `${deg}° → ${f.angleDeg}`);
    }
  });

  test(`fitPart (${name}): a 104.5 mm block is not ok (size); a non-square is not ok (fit)`, () => {
    const big = fitPart(block({ side: 104.5, deg: 10, at: [120, 0] }), reg)!;
    assert.equal(big.ok, false);
    assert.equal(big.why, "size");
    assert.ok(Math.abs(big.sideMm - 104.5) < 1e-6);
    const skew = fitPart(block({ skewDeg: 10, deg: 5, at: [120, 0] }), reg)!;
    assert.equal(skew.ok, false);
    assert.equal(skew.why, "fit");
    assert.ok(skew.freMm > FIT_MAX_MM);
  });
}

test("fitPart: the engine and the fallback agree; fewer than four points is null", () => {
  const pts = block({ deg: 12, at: [140, 30], noise: 0.3 });
  const a = fitPart(pts, realRegister)!, b = fitPart(pts, noRegister)!;
  assert.ok(Math.abs(a.angleDeg - b.angleDeg) < 0.05);
  // the engine fits in 3D (it may tilt the face with the heights' noise), the fallback only in the plane
  a.corners.forEach((c, i) => {
    assert.ok(Math.hypot(c[0] - b.corners[i][0], c[1] - b.corners[i][1]) < 0.1, `corner ${i} in the plane`);
    assert.ok(Math.abs(c[2] - b.corners[i][2]) < 0.6, `corner ${i} height`);
  });
  assert.equal(fitPart(pts.slice(0, 3), realRegister), null);
  assert.equal(fitSquare2D([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0]]), null);
});

test("fitSquare2D: the transform maps model → measured, in metres, fre in mm", () => {
  const model: [number, number, number][] = [[0, 0, 0.018], [0.1, 0, 0.018], [0.1, 0.1, 0.018], [0, 0.1, 0.018]];
  const measured = block({ deg: 30, at: [100, 20] }).map((p) => p.map((v) => v / 1000) as [number, number, number]);
  const r = fitSquare2D(model, measured)!;
  assert.ok(r.freMm < 1e-6);
  const e = core.registerPoints(model, measured)!;
  assert.ok(Math.hypot(r.transform.p[0] - e.transform.p[0], r.transform.p[1] - e.transform.p[1], r.transform.p[2] - e.transform.p[2]) < 1e-9);
});

// ---------------- the job ----------------

const fitOf = (o: Parameters<typeof block>[0] = { deg: 20, at: [130, -40] }) => fitPart(block(o), realRegister)!;

test("pilotPlan: valid, holes 10 mm in from the fitted corners, on the top face", () => {
  const f = fitOf();
  const p = pilotPlan(f, AT);
  const v = validatePlan(p);
  assert.ok(v.ok, v.ok ? "" : v.errors.join("; "));
  assert.deepEqual(p.holes.map((h) => h.label), ["S1", "S2", "S3", "S4"]);
  assert.deepEqual(p.author, { kind: "manual", name: "pilot" });
  assert.equal(p.recipe?.id, PILOT_RECIPE_ID);
  const a = (20 * Math.PI) / 180;
  const ux = [Math.cos(a), Math.sin(a)], uy = [-Math.sin(a), Math.cos(a)];
  p.holes.forEach((h, i) => {
    const c = f.corners[i];
    // in from both edges that meet at corner i: 10 mm along each of the part's axes
    const d = [h.x - c[0], h.y - c[1]];
    const along = Math.abs(d[0] * ux[0] + d[1] * ux[1]), across = Math.abs(d[0] * uy[0] + d[1] * uy[1]);
    assert.ok(Math.abs(along - PILOT_PART.insetMm) < 0.1 && Math.abs(across - PILOT_PART.insetMm) < 0.1, `${h.label}: ${along}, ${across}`);
    assert.ok(Math.abs(h.z! - 18) < 0.1);
    assert.equal(h.depthMm, PILOT_SCREW.depthMm);
    assert.equal(h.diameterMm, PILOT_SCREW.diameterMm);
  });
});

test("pilotPlan: the depth clamps on a thin block", () => {
  assert.equal(pilotDepthMm(30), 15);
  assert.equal(pilotDepthMm(12), 10);
  assert.equal(pilotDepthMm(4), 3);
  const thin = pilotPlan(fitOf({ deg: 0, at: [120, 0], top: 9 }), AT);
  assert.ok(thin.holes.every((h) => h.depthMm === 7 && h.z === 9));
  assert.equal(validatePlan(thin).ok, true);
});

test("pilotRecipe: parses, its steps are in order, and the gate does not reject it", () => {
  const p = pilotPlan(fitOf(), AT);
  const r = parseRecipe(p.recipe!.md);
  assert.equal(r.id, PILOT_RECIPE_ID);
  assert.deepEqual(r.statements.map((s) => s.id), ["sheet", "place", "register", "s1", "s2", "s3", "s4"]);
  assert.equal(r.statements[0].do, PILOT_STEPS.sheet.do);
  assert.deepEqual(r.statements[2].links, ["#s1"]);
  for (const s of r.statements.slice(3)) {
    assert.equal(s.check, DEFAULT_CHECK);
    const h = drillOf(s.do)!;
    const ph = p.holes.find((x) => x.label === h.label)!;
    assert.deepEqual([h.x, h.y, h.depthMm, h.diameterMm], [ph.x, ph.y, ph.depthMm, ph.diameterMm]);
  }
  assert.equal(pilotRecipe(p), p.recipe!.md.replace(/\n$/, "") + "\n");
  const g = gateRecipe(p.recipe!.md, undefined, AT);
  assert.notEqual(g.verdict, "REJECTED", g.reasons.join("; "));
  assert.equal(g.verdict, "FAST_TRACK", g.reasons.join("; "));
  assert.equal(g.manual.length, 3);
  assert.equal(g.plan!.holes.length, 4);
});

// ---------------- the plan file: z ----------------

test("planTargets passes z on (metres), and smartToolsScene places the target there", () => {
  const p = pilotPlan(fitOf(), AT);
  const t = planTargets(p);
  assert.ok(Math.abs(t[0].z! - 0.018) < 1e-9);
  const def = smartToolsScene({ tool: dockRig({}).tool, targets: t });
  const n = def.nodes.find((x) => x.name === "S1")!;
  assert.ok(Math.abs(n.local!.p![2] - 0.018) < 1e-9);
  assert.ok(Math.abs(n.local!.p![0] - p.holes[0].x / 1000) < 1e-12);
});

test("old plans: no z, they validate, their targets and scene are as before", () => {
  for (const p of [SHEET_PLAN, DEMO_PLAN]) {
    assert.equal(validatePlan(p).ok, true);
    for (const t of planTargets(p)) assert.equal("z" in t, false);
  }
  const tool = dockRig({}).tool;
  assert.deepEqual(JSON.stringify(smartToolsScene({ tool, targets: planTargets(SHEET_PLAN) })), JSON.stringify(smartToolsScene({ tool, targets: planTargets(SHEET_PLAN).map(({ label, x, y, depthMm, diameterMm }) => ({ label, x, y, depthMm, diameterMm })) })));
  for (const n of smartToolsScene({ tool, targets: planTargets(DEMO_PLAN) }).nodes.filter((x) => x.kind === "planned")) assert.equal(n.local!.p![2], 0);
});

test("validatePlan: z must be a number 0-200 mm", () => {
  const withZ = (z: unknown) => ({ ...DEMO_PLAN, holes: DEMO_PLAN.holes.map((h, i) => (i ? h : { ...h, z })) });
  assert.equal(validatePlan(withZ(0)).ok, true);
  assert.equal(validatePlan(withZ(200)).ok, true);
  for (const bad of [-1, 201, "18", NaN]) {
    const v = validatePlan(withZ(bad));
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errors.join(), /z must be 0-200 mm/);
  }
});

// ---------------- where we are, and what to light up ----------------

const OKFIT: PartFit = fitOf();
const BADFIT: PartFit = fitOf({ side: 104.5, deg: 0, at: [120, 0] });
const S = (o: Partial<PilotState> = {}): PilotState => ({
  phase: "sheet", sheetOk: false, sheets: SHEET0_ONLY.map((x) => ({ ...x })), markers: 3, corners: 0, capture: null, fit: null, done: 0, total: 0, nearScrew: false, drilling: false, ready: false, stop: false, toolCalibrated: true, ...o,
});
const set = (a: FocusId[]) => [...a].sort();

test("currentStep: each phase", () => {
  assert.equal(currentStep(S()), "sheet");
  assert.equal(currentStep(S({ sheetOk: true })), "place");
  assert.equal(currentStep(S({ phase: "part", sheetOk: true })), "place");
  assert.equal(currentStep(S({ phase: "part", sheetOk: true, capture: { progress: 0.3, why: "pivot" } })), "register");
  assert.equal(currentStep(S({ phase: "part", sheetOk: true, corners: 2 })), "register");
  assert.equal(currentStep(S({ phase: "part", sheetOk: true, corners: 4, fit: BADFIT })), "register");
  assert.equal(currentStep(S({ phase: "part", sheetOk: true, corners: 4, fit: OKFIT })), "s1");
  assert.equal(currentStep(S({ phase: "work", fit: OKFIT, total: 4, done: 0 })), "s1");
  assert.equal(currentStep(S({ phase: "work", fit: OKFIT, total: 4, done: 2 })), "s3");
  assert.equal(currentStep(S({ phase: "work", fit: OKFIT, total: 4, done: 4 })), "done");
});

test("canEnter: part needs the sheet seen well, work needs an ok fit", () => {
  assert.equal(canEnter("sheet", S()), true);
  assert.equal(canEnter("part", S()), false);
  assert.equal(canEnter("part", S({ sheetOk: true })), true);
  assert.equal(canEnter("work", S({ sheetOk: true })), false);
  assert.equal(canEnter("work", S({ sheetOk: true, fit: BADFIT })), false);
  assert.equal(canEnter("work", S({ sheetOk: true, fit: OKFIT })), true);
});

test("focus: every rule", () => {
  const all = [...FOCUS_IDS];
  const but = (...keep: FocusId[]) => set(all.filter((x) => !keep.includes(x)));
  // tool not calibrated
  let f = focus(S({ toolCalibrated: false }));
  assert.deepEqual(f.glow, ["more"]);
  assert.deepEqual(set(f.dim), but("more", "text"));
  // sheet, not ok
  f = focus(S());
  assert.deepEqual(set(f.glow), set(["sheet-outline", "text"]));
  assert.deepEqual(set(f.dim), set(["part", "corners", "screws", "depth", "level", "phase-part", "phase-work", "sound", "video"]));
  // sheet, ok
  assert.deepEqual(focus(S({ sheetOk: true })), { glow: ["phase-part"], dim: [] });
  // part, fewer than 4 corners
  f = focus(S({ phase: "part", sheetOk: true, corners: 1 }));
  assert.deepEqual(set(f.glow), set(["corners", "tip", "text"]));
  assert.deepEqual(set(f.dim), set(["screws", "depth", "level", "phase-work", "sound", "video", "more"]));
  // part, fit ok / not ok
  assert.deepEqual(set(focus(S({ phase: "part", sheetOk: true, corners: 4, fit: OKFIT })).glow), set(["phase-work", "part"]));
  assert.deepEqual(set(focus(S({ phase: "part", sheetOk: true, corners: 4, fit: BADFIT })).glow), set(["phase-part", "text"]));
  // work, away from the active screw
  const workDim: FocusId[] = ["corners", "depth", "level", "phase-sheet", "phase-part", "sound", "video", "more"];
  f = focus(S({ phase: "work", sheetOk: true, fit: OKFIT, total: 4, done: 1 }));
  assert.deepEqual(set(f.glow), set(["screws", "text"]));
  assert.deepEqual(set(f.dim), set(workDim));
  // work, near it or drilling
  for (const o of [{ nearScrew: true }, { drilling: true }]) {
    f = focus(S({ phase: "work", sheetOk: true, fit: OKFIT, total: 4, done: 1, ...o }));
    assert.deepEqual(set(f.glow), set(["level", "depth", "text"]));
    assert.deepEqual(set(f.dim), set([...workDim.filter((x) => x !== "depth" && x !== "level"), "sheet-outline"]));
    assert.ok(!f.glow.some((g) => f.dim.includes(g)));
  }
  // stop alarm: wins over everything
  f = focus(S({ phase: "work", fit: OKFIT, total: 4, done: 1, stop: true, toolCalibrated: false }));
  assert.deepEqual(set(f.glow), set(["stop", "text"]));
  assert.deepEqual(set(f.dim), but("stop", "text"));
  // all screws done
  assert.deepEqual(set(focus(S({ phase: "work", fit: OKFIT, total: 4, done: 4 })).glow), set(["more", "pause"]));
});

// ---------------- the top text ----------------

const R: Readout = { icon: "arrow", value: "12.4", unit: "mm", angle: 0.3, level: "guide" };

test("pilotText: the sheets mapped, the corners then the fit, the readout", () => {
  assert.deepEqual(pilotText(S({ markers: 4 }), R), { icon: "sheet", value: "1", unit: "", tone: "next" });
  const three: SheetState[] = [{ k: 0, state: "mapped", progress: 1 }, { k: 1, state: "mapped", progress: 1 }, { k: 2, state: "seen", progress: 0.4 }, { k: 3, state: "mapped", progress: 1 }];
  assert.deepEqual(pilotText(S({ markers: 9, sheets: three }), R), { icon: "sheet", value: "3", unit: "", tone: "next" });
  assert.equal(pilotText(S({ markers: 9, sheetOk: true }), R).tone, "ok");
  assert.deepEqual(pilotText(S({ phase: "part", sheetOk: true, corners: 2 }), R), { icon: "corner", value: "2/4", unit: "", tone: "next" });
  const ok = pilotText(S({ phase: "part", sheetOk: true, corners: 4, fit: OKFIT }), R);
  assert.deepEqual(ok, { icon: "corner", value: OKFIT.freMm.toFixed(1), unit: "mm", tone: "ok" });
  assert.equal(pilotText(S({ phase: "part", corners: 4, fit: BADFIT }), R).tone, "next");
  assert.deepEqual(pilotText(S({ phase: "work", fit: OKFIT, total: 4, done: 1 }), R), { icon: "arrow", value: "12.4", unit: "mm", tone: "next" });
  assert.equal(pilotText(S({ phase: "work", fit: OKFIT, total: 4, done: 1 }), { ...R, level: "ok" }).tone, "ok");
  assert.equal(pilotText(S({ phase: "work", fit: OKFIT, total: 4, done: 1 }), { ...R, level: "stop" }).tone, "stop");
  assert.deepEqual(pilotText(S({ phase: "work", fit: OKFIT, total: 4, done: 4 }), R), { icon: "check", value: "4/4", unit: "", tone: "ok" });
  assert.equal(pilotText(S({ stop: true }), R).tone, "stop");
  assert.equal(pilotText(S({ toolCalibrated: false }), R).icon, "setup");
});

test("pilotWords: the Do of the current step", () => {
  const p = pilotPlan(OKFIT, AT);
  assert.equal(pilotWords("sheet"), "Lay the sheets on the bench, flat, and look at each until it turns green");
  assert.equal(pilotWords("place"), "Put the block on the sheets and clamp it");
  assert.equal(pilotWords("register"), "Rest the tip on each top corner and pivot the drill");
  assert.match(pilotWords("s2", p), /^Drill S2: Ø4 mm at \(/);
  assert.equal(pilotWords("s1"), "Drill screw S1");
  assert.match(pilotWords("done"), /save/);
  assert.equal(pilotWords(currentStep(S({ phase: "work", fit: OKFIT, total: 4, done: 3 })), p), parseRecipe(p.recipe!.md).statements[6].do);
});
