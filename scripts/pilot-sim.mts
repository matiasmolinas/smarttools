// The pilot job, headless: the simulated camera (Rust renderer, with the table of sheets and the wood block in the
// scene) -> the marker tracker -> the table map -> the engine -> lib/pilotnav.ts, as /hud?sim=1&pilot=1 runs it in
// the browser (the same PilotNav, SheetMapper and pilotHold; the browser only adds the worker and the screen).
// Three phases in sequence:
//   sheet   every sheet on the bench is mapped (the person looks at each seam) and the sheet check becomes ok
//   part    the four top corners of the block are captured (the drill pivoted on each, square) and fitPart is ok
//   work    the four screws are driven on the block's top face and recorded as holes
// Every number is compared with the simulation's truth. PASS needs every corner and every screw to keep at least
// SHEET_MIN_MARKERS markers in view, and every hole to pass the default Check (depth within 0.5 mm, angle under 1°).
//
// Run: node --no-warnings scripts/pilot-sim.mts [--layout table|single] [--block-x 108 --block-y 151.5] [--angle 4]
//                                              [--lean 0] [--tilt 15] [--fps 15]
//   --layout   table: the four sheets of lib/scene.ts PILOT_TABLE, the block on them (default); single: sheet 0
//              alone, the block beside it (--gap mm from the sheet's right edge, default 15)
//   --block-x/--block-y  the block's centre (mm, sheet 0's frame; default where the four sheets meet)
//   --angle    the block's rotation (deg, default 4)
//   --lean     how far the simulated person may lean the drill on a corner to keep markers in view (deg; 0 = square)
//   --tilt     the dock's hinge tilt (deg; default: the dock's default)
//   PILOT_DEBUG=1 prints the corner capture twice a second
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { NavCore, type EngineSnapshot } from "../lib/engine.ts";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, PILOT_BLOCK, PILOT_SCREW_TIME, PILOT_TABLE, SHEET_ONLY, blockBeside, disturb, dockRigAt, markerCodes, pilotBlockCorners, pilotBlockSolid, pilotHold, pilotView, renderTool, toolWorldFromHold, type PilotBlock } from "../lib/scene.ts";
import { NavSession } from "../lib/session.ts";
import { smartToolsScene } from "../lib/scenedef.ts";
import { planDepths, planTargets, validatePlan, type Plan } from "../lib/plan.ts";
import { JobRecorder, defaultContext } from "../lib/jobrecord.ts";
import { checkHole, recipeOfPlan } from "../lib/recipe.ts";
import { PILOT_PART, SHEET_MIN_MARKERS, type Phase } from "../lib/pilot.ts";
import { PilotNav, nextScrew, pilotScrews } from "../lib/pilotnav.ts";
import { SheetMapper } from "../lib/tablemap.ts";

const args = process.argv.slice(2);
const arg = (k: string) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : undefined);
const LAYOUT = args.includes("--layout") ? args[args.indexOf("--layout") + 1] : "table";
const TILT = arg("--tilt");
const LEAN = arg("--lean") ?? 0;
const FPS = arg("--fps") ?? 15;
const TICK = 1 / 120;
const LATENCY = 0.03;

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const core = await NavCore.load(readFileSync(new URL("../public/engine/nav_core.wasm", import.meta.url)));
const codes = markerCodes(new AR.Dictionary("ARUCO_MIP_36h12").codeList);
const detector = () => new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" });
const rig = TILT != null ? dockRigAt(TILT) : DEFAULT_RIG;
const table = LAYOUT === "single" ? SHEET_ONLY : PILOT_TABLE;
const base: PilotBlock = LAYOUT === "single" ? blockBeside(arg("--gap") ?? 15) : PILOT_BLOCK;
const block: PilotBlock = { ...base, angleDeg: arg("--angle") ?? base.angleDeg, centreMm: [arg("--block-x") ?? base.centreMm[0], arg("--block-y") ?? base.centreMm[1]] };
const solids = [pilotBlockSolid(block)];
const truthCorners = pilotBlockCorners(block);
const scene = { table, block };

const rows: { name: string; pass: boolean }[] = [];
const check = (name: string, pass: boolean, detail: string) => {
  rows.push({ name, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name.padEnd(62)} ${detail}`);
};
const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const med = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const t0 = performance.now();

console.log(`[pilot] layout ${LAYOUT}: ${table.length} sheet${table.length > 1 ? "s" : ""}${table.length > 1 ? ` (${table.map((s) => `${s.k + 1} at (${f1(s.x * 1000)}, ${f1(s.y * 1000)}) mm ${f1((s.yaw * 180) / Math.PI)}°`).join(", ")})` : ""}`);
console.log(`  dock tilt ${TILT ?? "default"}°, lean on corners up to ${LEAN}°, camera ${FPS} fps, block ${block.sideMm}×${block.sideMm}×${block.heightMm} mm centred at (${f1(block.centreMm[0])}, ${f1(block.centreMm[1])}) mm, rotated ${block.angleDeg}°`);
console.log(`  block corners (truth, mm): ${truthCorners.map((c) => `(${f1(c[0])}, ${f1(c[1])})`).join(" ")}, top at ${block.heightMm} mm`);
console.log(`  how the simulated person holds the drill on each corner (lean, twist; markers in view by projection, the block hiding some, fewest over the pivot):`);
console.log(`    ${truthCorners.map((c, i) => { const v = pilotView(core, rig, [c[0] / 1000, c[1] / 1000, c[2] / 1000], { maxLeanDeg: LEAN, ...scene }); return `${i + 1}: lean ${v.leanDeg}° twist ${v.twistDeg}° -> ${v.markers}`; }).join(" | ")}`);

// the simulator's session, as BrowserNav.useCalibration builds it (a known calibration, the sheet's default scene)
const mapper = new SheetMapper(null);
const newSession = (plan: Plan | null, t: number) => {
  const s = new NavSession(core, detector(), {
    camera: rig.camera,
    cameraCalibrated: true,
    tool: rig.tool,
    toolCalibrated: true,
    ...(plan ? { scene: smartToolsScene({ tool: rig.tool, targets: planTargets(plan) }), targetDepths: planDepths(plan) } : {}),
    t0: t,
  });
  s.tracker.setTableMap(mapper.map());
  return s;
};
let session = newSession(null, 0);
let plan: Plan | null = null;
let recorder: JobRecorder | null = null;
const pilot = new PilotNav();
const register = (m: Parameters<NavCore["registerPoints"]>[0], d: Parameters<NavCore["registerPoints"]>[1]) => core.registerPoints(m, d);
const mappedAt = new Map<number, number>();

// per frame: what the camera saw, for the step it belongs to
type FrameLog = { step: string; onCorner: boolean; markers: number; pose: boolean; rms: number; sheets: number[] };
const frames: FrameLog[] = [];
let simStep: { key: string; t0: number } | null = null;
const screwList = () => (plan ? pilotScrews(plan, session.snapshot, (id) => session.name(id), recorder?.holes.map((h) => h.name) ?? []) : []);

/** Run the simulated wall clock until `until` says so or `maxS` passes; frames at FPS, delivered after LATENCY. */
let wall = 0;
let nextFrame = 0;
const pending: { at: number; tCapture: number; img: ReturnType<typeof renderTool>; step: string; onCorner: boolean }[] = [];
let k = 0;
function run(maxS: number, until: () => boolean, onTick?: (s: EngineSnapshot) => void): boolean {
  const end = wall + maxS;
  for (; wall <= end; wall += TICK) {
    while (nextFrame <= wall + 1e-9) {
      const screw = pilot.phase === "work" ? nextScrew(screwList()) : null;
      const key = `${pilot.phase}|${pilot.corners.length}|${screw?.label ?? ""}`;
      if (simStep?.key !== key) simStep = { key, t0: nextFrame };
      const local = nextFrame - simStep.t0;
      const { hold, phase } = pilotHold(core, rig, { phase: pilot.phase, corners: pilot.corners.length, screw, block, table, maxLeanDeg: LEAN }, local);
      const toolW = toolWorldFromHold(core, rig, disturb(hold, nextFrame, phase, DEFAULT_DISTURBANCE));
      const img = renderTool(core, rig, codes, [toolW], { ...DEFAULT_DISTURBANCE, blurSamples: 1 }, 17 + k++, { ss: 1, solids, sheets: table });
      const step = pilot.phase === "part" ? `corner ${pilot.corners.length + 1}` : pilot.phase === "work" ? (screw?.label ?? "-") : "sheet";
      pending.push({ at: nextFrame + LATENCY, tCapture: nextFrame, img, step, onCorner: pilot.phase === "part" && local >= 1.5 });
      nextFrame += 1 / FPS;
    }
    while (pending.length && pending[0].at <= wall + 1e-9) {
      const f = pending.shift()!;
      const tf = session.frame(f.img, f.tCapture);
      const perSheet = table.map((s) => tf.sheets.find((v) => v.k === s.k)?.markers ?? 0);
      frames.push({ step: f.step, onCorner: f.onCorner, markers: tf.markers, pose: !!tf.pose, rms: tf.rmsPx, sheets: perSheet });
      // as BrowserNav.onWorkerResult: the mapper learns from every frame, and the tracker solves with its map
      if (mapper.feed(f.tCapture, tf.sheets)) {
        session.tracker.setTableMap(mapper.map());
        for (const s of mapper.states()) if (s.state === "mapped" && !mappedAt.has(s.k)) mappedAt.set(s.k, wall);
      }
    }
    const n = session.advance(wall);
    if (n > 0 && session.snapshot) {
      if (recorder) recorder.feed(session.snapshot);
      pilot.setTable(mapper.map(), mapper.states());
      const r = pilot.step(session, true, register);
      if (r.corner != null) {
        const c = pilot.corners[r.corner - 1];
        const truth = truthCorners.reduce((a, b) => (Math.hypot(b[0] - c[0], b[1] - c[1]) < Math.hypot(a[0] - c[0], a[1] - c[1]) ? b : a));
        console.log(`        corner ${r.corner} captured at t ${f1(wall)} s: (${f1(c[0])}, ${f1(c[1])}, ${f1(c[2])}) mm, ${f2(Math.hypot(c[0] - truth[0], c[1] - truth[1], c[2] - truth[2]))} mm from the true corner`);
      }
      if (process.env.PILOT_DEBUG && pilot.phase === "part" && Math.round(wall * 120) % 60 === 0) {
        const c = state().capture;
        const nav = session.scene.def.navigation;
        const tool = session.snapshot.nodes.find((x) => x.id === session.id(nav.tool))!.world;
        console.log(`        t ${f1(wall)} capture ${c ? `${f2(c.progress)} ${c.why}` : "-"} tip (${tool.p.map((v) => f1(v * 1000)).join(", ")}) markers ${session.snapshot.markers}`);
      }
      onTick?.(session.snapshot);
    }
    if (until()) return true;
  }
  return false;
}
const state = () => {
  pilot.setTable(mapper.map(), mapper.states());
  return pilot.state(session.snapshot, { toolCalibrated: true, done: recorder?.holes.length ?? 0, total: plan?.holes.length ?? 4 });
};
const go = (p: Phase) => pilot.setPhase(p, state());
const allMapped = () => table.every((s) => mapper.state(s.k).state === "mapped");
/** markers per step: min / median, frames under the minimum or without a pose, the pose's RMS (median / max) */
const quality = (on: FrameLog[]) => {
  const m = on.map((f) => f.markers);
  const rms = on.filter((f) => f.pose).map((f) => f.rms);
  return {
    min: Math.min(...m),
    median: med(m),
    few: on.filter((f) => f.markers < SHEET_MIN_MARKERS).length,
    lost: on.filter((f) => !f.pose).length,
    rmsMed: med(rms),
    rmsMax: rms.length ? Math.max(...rms) : NaN,
    n: on.length,
    perSheet: table.map((_, i) => med(on.map((f) => f.sheets[i]))),
  };
};
const qText = (q: ReturnType<typeof quality>) => `markers min ${q.min}, median ${q.median} (per sheet ${q.perSheet.join("/")}); frames under ${SHEET_MIN_MARKERS} ${q.few}, without a pose ${q.lost}, of ${q.n}; pose rms ${f2(q.rmsMed)} / ${f2(q.rmsMax)} px`;
const table1: string[] = [];

// ---------------- 1. the sheets ----------------
console.log(`\n[sheet] the drill over the ${table.length > 1 ? "table: every sheet mapped" : "sheet"}`);
const sheetOk = run(table.length > 1 ? 60 : 6, () => allMapped() && state().sheetOk);
const sf = frames.filter((f) => f.step === "sheet");
if (table.length > 1) {
  const map = mapper.map();
  for (const s of table) {
    if (s.k === 0) continue;
    const p = map.sheets[s.k];
    const st = mapper.state(s.k);
    if (!p) {
      check(`sheet ${s.k + 1} mapped`, false, `state ${st.state}, progress ${f2(st.progress)}`);
      continue;
    }
    const dx = (p.x - s.x) * 1000, dy = (p.y - s.y) * 1000, dyaw = ((p.yaw - s.yaw) * 180) / Math.PI;
    check(`sheet ${s.k + 1} mapped within 1 mm and 0.2° of the truth`, Math.hypot(dx, dy) < 1 && Math.abs(dyaw) < 0.2, `at t ${f1(mappedAt.get(s.k) ?? NaN)} s: (${f2(p.x * 1000)}, ${f2(p.y * 1000)}) mm ${f2((p.yaw * 180) / Math.PI)}° vs (${f1(s.x * 1000)}, ${f1(s.y * 1000)}) mm ${f2((s.yaw * 180) / Math.PI)}°: off by ${f2(Math.hypot(dx, dy))} mm, ${dyaw.toFixed(3)}°`);
  }
}
check("the sheet check becomes ok", sheetOk, `at t ${f1(wall)} s, ${state().markers} markers (frames: min ${Math.min(...sf.map((f) => f.markers))}, median ${med(sf.map((f) => f.markers))})`);
check("the part phase can be entered", go("part"), `phase ${pilot.phase}`);

// ---------------- 2. the part ----------------
console.log(`\n[part] the tip on each top corner, pivoting${LEAN ? ` (lean up to ${LEAN}°)` : ", the drill square"}`);
const captured = run(4 * 14, () => pilot.corners.length >= 4);
check("four corners captured", captured, `${pilot.corners.length} of 4 by t ${f1(wall)} s`);
for (let c = 1; c <= 4; c++) {
  const on = frames.filter((f) => f.step === `corner ${c}` && f.onCorner);
  if (!on.length) {
    check(`corner ${c}: ${SHEET_MIN_MARKERS}+ markers while the tip is on it`, false, "never reached");
    table1.push(`  corner ${c}  never reached`);
    continue;
  }
  const q = quality(on);
  table1.push(`  corner ${c}  ${String(q.min).padStart(3)} / ${String(q.median).padStart(3)}   ${f2(q.rmsMed)} / ${f2(q.rmsMax)}   ${q.perSheet.join("/")}`);
  check(`corner ${c}: ${SHEET_MIN_MARKERS}+ markers while the tip is on it`, q.lost === 0 && q.few === 0, qText(q));
}
const fit = pilot.fit;
if (fit) {
  const o = truthCorners[0];
  check("fitPart ok", fit.ok, `fre ${f2(fit.freMm)} mm, side ${f2(fit.sideMm)} mm (truth ${PILOT_PART.sideMm}), why ${fit.why ?? "-"}`);
  check("angle within 0.5° of the truth", Math.abs(fit.angleDeg - block.angleDeg) < 0.5, `${f2(fit.angleDeg)}° (truth ${block.angleDeg}°)`);
  check("origin within 1.5 mm of the truth", Math.hypot(fit.origin[0] - o[0], fit.origin[1] - o[1]) < 1.5, `(${f1(fit.origin[0])}, ${f1(fit.origin[1])}) vs (${f1(o[0])}, ${f1(o[1])}) mm`);
  check("top face within 1.5 mm of the truth", Math.abs(fit.topMm - block.heightMm) < 1.5, `${f2(fit.topMm)} mm (truth ${block.heightMm})`);
} else check("fitPart ok", false, "no fit");

// ---------------- 3. the work ----------------
console.log("\n[work] the four screws on the block's top face, the drill square");
const entered = go("work");
check("the work phase can be entered (the fit is ok)", entered, `phase ${pilot.phase}`);
if (entered) {
  plan = pilot.plan()!;
  const v = validatePlan(plan);
  check("the pilot plan validates", v.ok, v.ok ? plan.holes.map((h) => `${h.label} (${f1(h.x)}, ${f1(h.y)}, z ${f1(h.z ?? 0)}) ${h.depthMm} mm`).join(", ") : v.errors.join("; "));
  console.log(`    markers in view by projection on each screw (square, best twist, block hiding some): ${plan.holes.map((h) => `${h.label} ${pilotView(core, rig, [h.x / 1000, h.y / 1000, (h.z ?? 0) / 1000], { pivotDeg: 2, want: 99, maxLeanDeg: 0, ...scene }).markers}`).join(", ")}`);
  // as BrowserNav.applyPilotPlan in the simulator: the session is rebuilt with the plan's scene, and its job recorded
  session.dispose();
  session = newSession(plan, wall);
  const p = plan;
  const s0 = session;
  const recipe = recipeOfPlan(p);
  recorder = new JobRecorder(p, defaultContext({ source: "simulation" }), (id) => (p.holes.some((h) => h.label === s0.name(id)) ? s0.name(id) : undefined), { t0: wall });
  // per screw, what the engine measured while the tip was on its axis (the gap, the depth, the alarms)
  const seen = new Map<string, { maxDepth: number; minGap: number; ready: number; alarms: number; phases: Set<string> }>();
  run(4 * PILOT_SCREW_TIME * 1.6, () => (recorder?.holes.length ?? 0) >= 4, (snap) => {
    if (snap.active < 0) return;
    const t = snap.targets[snap.active];
    const n = session.name(t.id);
    const e = seen.get(n) ?? { maxDepth: 0, minGap: Infinity, ready: 0, alarms: 0, phases: new Set<string>() };
    e.maxDepth = Math.max(e.maxDepth, t.depthMm);
    e.minGap = Math.min(e.minGap, t.gapMm);
    e.ready += snap.ready ? 1 : 0;
    e.alarms |= snap.alarms;
    e.phases.add(snap.phase);
    seen.set(n, e);
  });
  const holes = recorder.holes;
  check("four holes recorded", holes.length === 4, `${holes.length} of 4 by t ${f1(wall)} s`);
  for (const h of p.holes) {
    const r = holes.find((x) => x.name === h.label);
    const on = frames.filter((f) => f.step === h.label);
    const e = seen.get(h.label);
    const engine = e ? `engine: max depth ${f1(e.maxDepth)} mm, min gap ${f1(e.minGap)} mm, ready ${e.ready} ticks, phases ${[...e.phases].join("/")}${e.alarms ? `, alarms ${e.alarms}` : ""}` : "never active";
    const q = on.length ? quality(on) : null;
    table1.push(q ? `  ${h.label.padEnd(8)}  ${String(q.min).padStart(3)} / ${String(q.median).padStart(3)}   ${f2(q.rmsMed)} / ${f2(q.rmsMax)}   ${q.perSheet.join("/")}${r ? `   depth ${f2(r.seatedMm)} of ${f1(r.plannedMm)} mm, angle ${f2(r.maxAngleDeg)}°` : "   not recorded"}` : `  ${h.label}  no frames`);
    check(`${h.label}: ${SHEET_MIN_MARKERS}+ markers on the way and while driving`, !!q && q.few === 0 && q.lost === 0, q ? qText(q) : "no frames");
    const c = r && recipe ? checkHole(recipe, r) : null;
    check(`${h.label}: recorded, passes its Check (depth within 0.5 mm, angle under 1°)`, !!r && c?.outcome.status === "pass" && !r.flagged, r ? `seated ${f2(r.seatedMm)} mm (planned ${f1(r.plannedMm)}), max angle ${f2(r.maxAngleDeg)}°${r.flagged ? `, flagged: ${r.flagged}` : ""}; Check ${c?.outcome.status ?? "-"}: ${c?.outcome.detail ?? ""}; ${engine}` : engine);
  }
}

// the overlay the screen draws: every piece projects while tracking
const ov = pilot.overlay(core, session, screwList(), 1);
const sheet0 = ov.sheetsPx.find((x) => x.k === 0)?.px.length ?? 0;
check("overlay: sheet, block (top and bottom), corners and screws project", sheet0 === 4 && !!ov.partPx && !!ov.bottomPx && ov.cornersPx.length === 4 && ov.screwsPx.length === 4, `sheet ${sheet0}, part ${ov.partPx ? 4 : 0}, bottom ${ov.bottomPx ? 4 : 0}, corners ${ov.cornersPx.length}, screws ${ov.screwsPx.length}, sheets drawn ${ov.sheetsPx.map((x) => `${x.k + 1}:${x.state}`).join(" ")}`);

console.log(`\n[table] markers in view (min / median), pose rms (median / max, px), median markers per sheet ${table.map((s) => s.k + 1).join("/")}`);
console.log(table1.join("\n"));
const failed = rows.filter((r) => !r.pass);
console.log(`\n${rows.length - failed.length}/${rows.length} passed in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
console.log(failed.length ? "PILOT FAIL" : "PILOT PASS");
process.exit(failed.length ? 1 : 0);
