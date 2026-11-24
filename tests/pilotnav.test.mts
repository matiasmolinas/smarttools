// The pilot job against a session (lib/pilotnav.ts) and the simulator's pilot (lib/scene.ts): what is kept per
// device, the phases, the corners fed from snapshots, the screws and the simulated person's holds.
import test from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mts";
import { GUARD_TAN, NEAR_M, PilotNav, clipToView, nextScrew, pilotScrews, readPilotSaved, type PilotSaved } from "../lib/pilotnav.ts";
import { PILOT_PART, fitSquare2D, type PilotState } from "../lib/pilot.ts";
import { validatePlan } from "../lib/plan.ts";
import type { EngineSnapshot } from "../lib/engine.ts";
import type { NavSession } from "../lib/session.ts";
import { compose, inverse, qaxis, qfromTo, qmul, toPose, xf } from "../lib/xform.ts";
import { pinhole } from "../lib/engine.ts";
import { SHEET0_ONLY, type SheetState, type TableMap } from "../lib/tablemap.ts";
import { SHEET } from "../lib/board.ts";
import { DEFAULT_RIG, PILOT_BLOCK, PILOT_PIVOT_DEG, PILOT_SCREW_TIME, PILOT_TABLE, blockBeside, blockHides, markersInView, pilotBlockCentre, pilotBlockCorners, pilotBlockSolid, pilotHold, pilotView, toolWorldFromHold, twistToward } from "../lib/scene.ts";
import { applyPoint } from "../lib/xform.ts";
import type { V3 } from "../lib/pose.ts";

// ---------------- a session as PilotNav reads it (no engine) ----------------

const IDS: Record<string, number> = { sheet: 0, camera: 1, tool: 2, S1: 3, S2: 4, S3: 5, S4: 6 };
function snap(o: { t: number; tip?: V3; axis?: V3; markers?: number; status?: "valid" | "lost"; active?: number; offsetMm?: number; gapMm?: number; phase?: EngineSnapshot["phase"]; alarms?: number; drilled?: number[] }): EngineSnapshot {
  const tip = o.tip ?? [0, 0, 0.05], axis = o.axis ?? [0, 0, -1];
  return {
    tick: 0,
    t: o.t,
    nodes: [
      { id: 0, status: "valid", age: 0, world: { p: [0, 0, 0], q: [1, 0, 0, 0], s: [1, 1, 1] } },
      { id: 1, status: o.status ?? "valid", age: 0, world: { p: [tip[0], tip[1] + 0.1, tip[2] + 0.2], q: [1, 0, 0, 0], s: [1, 1, 1] } },
      { id: 2, status: "valid", age: 0, world: { p: tip, q: qfromTo([0, 0, 1], axis), s: [1, 1, 1] } },
    ],
    targets: [3, 4, 5, 6].map((id) => ({ id, drilled: !!o.drilled?.includes(id), offsetMm: o.offsetMm ?? 100, gapMm: o.gapMm ?? 100, depthMm: 0, angleErrDeg: 5 })) as unknown as EngineSnapshot["targets"],
    active: o.active ?? -1,
    phase: o.phase ?? "approach",
    gate: 0,
    ready: false,
    locking: false,
    alarms: o.alarms ?? 0,
    jitterMm: 0,
    jitterDeg: 0,
    markers: o.markers ?? 12,
    rmsPx: 0.3,
    poseAgeS: 0,
    events: [],
    stats: { ticks: 0, overruns: 0, measurements: 0, lateMerged: 0, lateDropped: 0, latencyS: 0 },
  };
}
function fakeSession() {
  const names = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, k]));
  const s = {
    snapshot: null as EngineSnapshot | null,
    lastFrame: null as object | null,
    scene: { def: { navigation: { tool: "tool", tracked: "camera", reference: "sheet" } } },
    id: (n: string) => IDS[n],
    name: (id: number) => names[id],
  };
  return s;
}
const asSession = (s: ReturnType<typeof fakeSession>) => s as unknown as NavSession;
const register = (m: V3[], d: V3[]) => fitSquare2D(m, d);

/** Feed frames at 15 Hz: the tip at `at` (mm) pivoting ±8°, for `secs`. */
function pivotOn(p: PilotNav, s: ReturnType<typeof fakeSession>, at: V3, t0: number, secs: number) {
  const out: { corner: number | null }[] = [];
  for (let k = 0; k <= secs * 15; k++) {
    const t = t0 + k / 15;
    const a = (8 * Math.PI) / 180 * Math.sin(2 * Math.PI * 0.5 * t);
    s.snapshot = snap({ t, tip: [at[0] / 1000, at[1] / 1000, at[2] / 1000], axis: [Math.sin(a), 0, -Math.cos(a)] });
    s.lastFrame = {};
    out.push(p.step(asSession(s), true, register, () => "2026-11-24T10:00:00.000Z"));
  }
  return out;
}
const state = (p: PilotNav, s: ReturnType<typeof fakeSession>, done = 0) => p.state(s.snapshot, { toolCalibrated: true, done, total: 4 });

/** Straight down (as in the other overlay test), then tilted `deg` about the camera's x axis to look along +y. */
const qmulAxis = (deg: number) => qmul(qaxis([1, 0, 0], (-deg * Math.PI) / 180), qaxis([1, 0, 0], Math.PI));

// the block's corners, mm, as the simulator places them
const CORNERS = pilotBlockCorners();

test("PilotNav: the sheet check needs 6 markers for 1 s; part is refused until then", () => {
  const p = new PilotNav(), s = fakeSession();
  for (let k = 0; k <= 15; k++) {
    s.snapshot = snap({ t: k / 30, markers: 8 });
    p.step(asSession(s), true, register);
  }
  assert.equal(state(p, s).sheetOk, false);
  assert.equal(p.setPhase("part", state(p, s)), false);
  for (let k = 16; k <= 40; k++) {
    s.snapshot = snap({ t: k / 30, markers: 8 });
    p.step(asSession(s), true, register);
  }
  assert.equal(state(p, s).sheetOk, true);
  assert.equal(state(p, s).markers, 8);
  // too few markers: back to not ok
  s.snapshot = snap({ t: 2, markers: 4 });
  p.step(asSession(s), true, register);
  assert.equal(state(p, s).sheetOk, false);
  // the tool not calibrated: never ok
  const q = new PilotNav();
  for (let k = 0; k <= 60; k++) {
    s.snapshot = snap({ t: k / 30, markers: 12 });
    q.step(asSession(s), false, register);
  }
  assert.equal(q.state(s.snapshot, { toolCalibrated: false, done: 0, total: 4 }).sheetOk, false);
});

test("PilotNav: four corners from the tool's 3D tip, then the fit; one sample per tracker frame", () => {
  const p = new PilotNav(), s = fakeSession();
  const ok: PilotState = { ...state(p, s), sheetOk: true };
  assert.ok(p.setPhase("part", ok));
  let t = 0;
  const got: number[] = [];
  for (const c of CORNERS) {
    const r = pivotOn(p, s, c as V3, t, 2.2);
    got.push(...r.flatMap((x) => (x.corner ? [x.corner] : [])));
    t += 3;
  }
  assert.deepEqual(got, [1, 2, 3, 4]);
  CORNERS.forEach((c, i) => assert.ok(Math.hypot(p.corners[i][0] - c[0], p.corners[i][1] - c[1], p.corners[i][2] - c[2]) < 0.01));
  assert.ok(p.fit?.ok, `fit ${JSON.stringify(p.fit)}`);
  assert.ok(Math.abs(p.fit!.angleDeg - PILOT_BLOCK.angleDeg) < 0.01);
  assert.ok(Math.abs(p.fit!.sideMm - PILOT_PART.sideMm) < 0.01);
  assert.equal(p.fitAt, "2026-11-24T10:00:00.000Z");
  // after 4 corners nothing is being captured
  assert.equal(state(p, s).capture, null);
  assert.equal(state(p, s).corners, 4);
});

test("PilotNav: capture progress shows while resting; the tip lost resets it", () => {
  const p = new PilotNav(), s = fakeSession();
  p.setPhase("part", { ...state(p, s), sheetOk: true });
  pivotOn(p, s, CORNERS[0] as V3, 0, 0.8);
  const c = state(p, s).capture;
  assert.ok(c && c.progress > 0.4 && c.progress < 1, JSON.stringify(c));
  s.snapshot = snap({ t: 0.9, status: "lost" });
  s.lastFrame = {};
  p.step(asSession(s), true, register);
  assert.equal(state(p, s).capture, null);
  // the window starts again: a full rest is needed
  const r = pivotOn(p, s, CORNERS[0] as V3, 1, 1.4);
  assert.ok(r.every((x) => x.corner == null));
});

test("PilotNav: phases; part again clears the corners and the fit; work only with an ok fit; plan() keeps its id", () => {
  const p = new PilotNav(), s = fakeSession();
  p.setPhase("part", { ...state(p, s), sheetOk: true });
  assert.equal(p.setPhase("work", state(p, s)), false);
  assert.equal(p.plan(), null);
  CORNERS.forEach((c, i) => pivotOn(p, s, c as V3, i * 3, 2.2));
  const a = p.plan(), b = p.plan();
  assert.ok(a && b && a.id === b.id, "same plan id from the same fit");
  assert.ok(validatePlan(a).ok);
  assert.ok(a!.holes.every((h) => Math.abs((h.z ?? 0) - PILOT_BLOCK.heightMm) < 0.2));
  assert.ok(p.setPhase("work", state(p, s)));
  assert.equal(p.phase, "work");
  assert.ok(p.setPhase("sheet", state(p, s)));
  assert.ok(p.fit, "going back to the sheet keeps the fit");
  assert.ok(p.setPhase("part", { ...state(p, s), sheetOk: true }));
  assert.equal(p.corners.length, 0);
  assert.equal(p.fit, null);
});

test("PilotNav: a sheet in view still being mapped holds the sheet check; the state carries the sheets", () => {
  const p = new PilotNav(), s = fakeSession();
  assert.deepEqual(state(p, s).sheets, SHEET0_ONLY, "sheet 0 alone by default");
  const map: TableMap = { v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, { x: 0.216, y: 0, yaw: 0 }, null, null], at: "2026-11-24T10:00:00.000Z" };
  const seen: SheetState[] = [{ k: 0, state: "mapped", progress: 1 }, { k: 1, state: "mapped", progress: 1 }, { k: 2, state: "seen", progress: 0.5 }, { k: 3, state: "missing", progress: 0 }];
  p.setTable(map, seen);
  for (let k = 0; k <= 45; k++) {
    s.snapshot = snap({ t: k / 30, markers: 12 });
    p.step(asSession(s), true, register);
  }
  assert.equal(state(p, s).sheetOk, false, "sheet 3 is still being mapped");
  assert.deepEqual(state(p, s).sheets, seen);
  p.setTable(map, seen.map((x) => (x.k === 2 ? { ...x, state: "mapped", progress: 1 } : x)));
  s.snapshot = snap({ t: 1.6, markers: 12 });
  p.step(asSession(s), true, register);
  assert.equal(state(p, s).sheetOk, true, "steady all along: ok as soon as it is mapped");
});

test("PilotNav.interrupt: a corner's window measured before a pause does not count after it", () => {
  const p = new PilotNav(), s = fakeSession();
  p.setPhase("part", { ...state(p, s), sheetOk: true });
  pivotOn(p, s, CORNERS[0] as V3, 0, 1.0);
  assert.ok(state(p, s).capture!.progress > 0.5);
  p.interrupt();
  assert.equal(state(p, s).capture, null);
  // back 10 s later on the same corner: a full rest is needed again (without interrupt the old window would count)
  const r = pivotOn(p, s, CORNERS[0] as V3, 11, 1.2);
  assert.ok(r.every((x) => x.corner == null));
  assert.equal(p.corners.length, 0);
});

test("PilotNav.overlay: every mapped sheet from the map, a seen one from its own pose in the frame", () => {
  const p = new PilotNav(), s = fakeSession() as ReturnType<typeof fakeSession> & Record<string, unknown>;
  const down = qaxis([1, 0, 0], Math.PI);
  const camW = xf([0.108, 0.15, 0.7], down);
  const camera = pinhole(800, 480, 360);
  const sn = snap({ t: 1, markers: 20 });
  sn.nodes[1] = { ...sn.nodes[1], world: camW };
  s.snapshot = sn;
  s.world = () => xf();
  // sheet 2's own pose in the frame: T_cam_sheet = T_cam_world · T_world_sheet
  const sheet2W = xf([0, 0.303, 0], qaxis([0, 0, 1], -0.03));
  s.lastFrame = { camera, sheets: [{ k: 2, markers: 9, pose: toPose(compose(inverse(camW), sheet2W)) }] };
  const map: TableMap = { v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, { x: 0.216, y: 0, yaw: 0.02 }, null, null], at: "2026-11-24T10:00:00.000Z" };
  p.setTable(map, [{ k: 0, state: "mapped", progress: 1 }, { k: 1, state: "mapped", progress: 1 }, { k: 2, state: "seen", progress: 0.4 }, { k: 3, state: "missing", progress: 0 }]);
  const ov = p.overlay(core, asSession(s), [], 2);
  assert.deepEqual(ov.sheetsPx.map((x) => [x.k, x.state, x.progress]), [[0, "mapped", 1], [1, "mapped", 1], [2, "seen", 0.4]]);
  assert.ok(ov.sheetsPx.every((x) => x.px.length === 4));
  // sheet 0's bottom-left corner where the camera puts it (scale 2: video px)
  const pose = toPose(inverse(camW));
  const want = core.projectPoints(camera, pose, [[-SHEET.w / 2, -SHEET.h / 2, 0]])[0]!;
  assert.ok(Math.abs(ov.sheetsPx[0].px[0].x - want.x * 2) < 1e-6 && Math.abs(ov.sheetsPx[0].px[0].y - want.y * 2) < 1e-6);
  // sheet 2 from its own pose: the same pixels as placing it in the world
  const w2 = core.projectPoints(camera, pose, [applyPoint(sheet2W, [-SHEET.w / 2, -SHEET.h / 2, 0])])[0]!;
  assert.ok(Math.abs(ov.sheetsPx[2].px[0].x - w2.x * 2) < 1e-6 && Math.abs(ov.sheetsPx[2].px[0].y - w2.y * 2) < 1e-6);
});

test("clipToView: in front unchanged; a corner behind clipped to a pentagon; wholly behind gives nothing", () => {
  const sq = (z: (x: number, y: number) => number): V3[] => [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]].map(([x, y]) => [x, y, z(x, y)] as V3);
  const front = sq(() => 0.3);
  assert.deepEqual(clipToView(front), front, "fully in front: the same points, in order");
  // one corner (0.1, 0.1) behind the camera: the plane z = 0.2 - 1.5 (x + y) tilts it back
  const tilted = sq((x, y) => 0.2 - 1.5 * (x + y) * (x > 0 && y > 0 ? 1 : 0.2));
  assert.ok(tilted[2][2] < 0 && tilted.filter((p) => p[2] > NEAR_M).length === 3);
  const c = clipToView(tilted, true, NEAR_M, 100);
  assert.equal(c.length, 5, "the corner behind is replaced by two points on the near plane");
  assert.deepEqual(c.slice(0, 2), tilted.slice(0, 2));
  assert.deepEqual(c[4], tilted[3]);
  for (const p of [c[2], c[3]]) assert.ok(Math.abs(p[2] - NEAR_M) < 1e-12, `on the near plane: ${p[2]}`);
  // the cut points lie on the two edges that cross it: (0.1, -0.1) → (0.1, 0.1) and (0.1, 0.1) → (-0.1, 0.1)
  assert.ok(Math.abs(c[2][0] - 0.1) < 1e-12 && c[2][1] > -0.1 && c[2][1] < 0.1);
  assert.ok(Math.abs(c[3][1] - 0.1) < 1e-12 && c[3][0] > -0.1 && c[3][0] < 0.1);
  // two corners behind: a quadrilateral again, its far side on the near plane
  const two = sq((x) => (x > 0 ? -0.05 : 0.3));
  const c2 = clipToView(two, true, NEAR_M, 100);
  assert.equal(c2.length, 4);
  assert.equal(c2.filter((p) => Math.abs(p[2] - NEAR_M) < 1e-12).length, 2);
  assert.deepEqual(clipToView(sq(() => -0.2)), [], "wholly behind: nothing");
  assert.deepEqual(clipToView(sq(() => NEAR_M / 2)), [], "in front of the lens but closer than the near plane: nothing");
  // the guard cone: a square far off to the side is cut at |x| = GUARD_TAN z
  const side: V3[] = [[0, 0, 0.2], [1, 0, 0.2], [1, 0.05, 0.2], [0, 0.05, 0.2]];
  const cs = clipToView(side);
  assert.equal(cs.length, 4);
  assert.ok(Math.max(...cs.map((p) => p[0])) <= GUARD_TAN * 0.2 + 1e-12);
  // a segment: its visible piece, or nothing
  const seg = clipToView([[0, 0, -0.1], [0, 0, 0.3]], false);
  assert.equal(seg.length, 2);
  assert.ok(Math.abs(seg[0][2] - NEAR_M) < 1e-12 && seg[1][2] === 0.3);
  assert.deepEqual(clipToView([[0, 0, -0.1], [0, 0.1, -0.3]], false), []);
  assert.deepEqual(clipToView([[0, 0, 0.1], [0, 0.1, 0.3]], false), [[0, 0, 0.1], [0, 0.1, 0.3]]);
});

test("PilotNav.overlay: a sheet and the block with corners behind the camera are clipped, not dropped", () => {
  const p = new PilotNav(), s = fakeSession() as ReturnType<typeof fakeSession> & Record<string, unknown>;
  // the camera low over sheet 0's top edge, tilted 75° from straight down, looking back over the sheet: sheet 0's
  // top corners are behind it
  const camW = xf([0, 0.12, 0.08], qmulAxis(75));
  const camera = pinhole(800, 480, 360);
  const sn = snap({ t: 1, markers: 20 });
  sn.nodes[1] = { ...sn.nodes[1], world: camW };
  s.snapshot = sn;
  s.world = () => xf();
  s.lastFrame = { camera, sheets: [] };
  const pose = toPose(inverse(camW));
  const zCam = (w: V3) => pose.R[6] * w[0] + pose.R[7] * w[1] + pose.R[8] * w[2] + pose.t[2];
  const corners: V3[] = [[-SHEET.w / 2, -SHEET.h / 2, 0], [SHEET.w / 2, -SHEET.h / 2, 0], [SHEET.w / 2, SHEET.h / 2, 0], [-SHEET.w / 2, SHEET.h / 2, 0]];
  assert.ok(corners.some((c) => zCam(c) < 0) && corners.some((c) => zCam(c) > 0.05), `some corners behind: ${corners.map(zCam).map((z) => z.toFixed(3))}`);
  p.setTable({ v: 1, sheets: [{ x: 0, y: 0, yaw: 0 }, null, null, null], at: "2026-11-24T10:00:00.000Z" }, SHEET0_ONLY.map((x) => ({ ...x })));
  // a block whose near corners are behind the camera too
  p.fit = { corners: [[-60, -40, 18], [60, -40, 18], [60, 140, 18], [-60, 140, 18]], origin: [-60, -40], angleDeg: 0, topMm: 18, sideMm: 120, freMm: 0.1, ok: true, why: null };
  const ov = p.overlay(core, asSession(s), [], 1);
  const sh0 = ov.sheetsPx.find((x) => x.k === 0);
  assert.ok(sh0, "sheet 0's outline is still drawn");
  assert.ok(sh0.px.length >= 3, `${sh0.px.length} points`);
  assert.ok(sh0.px.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)));
  assert.ok(ov.partPx && ov.partPx.length >= 3, "the block's top face is drawn");
  assert.ok(ov.bottomPx && ov.bottomPx.length >= 3, "and its bottom");
  assert.ok(ov.edgesPx && ov.edgesPx.length >= 2, `vertical edges: ${ov.edgesPx?.length}`);
  const topZ = p.fit.corners.map((c) => zCam([c[0] / 1000, c[1] / 1000, c[2] / 1000]));
  assert.ok(topZ.some((z) => z < 0), `the block has a top corner behind the camera: ${topZ.map((z) => z.toFixed(3))}`);
  // the sheet's bottom corners, in front, are where a plain projection puts them
  const far = core.projectPoints(camera, pose, [corners[0], corners[1]]);
  for (const q of far) assert.ok(q && sh0.px.some((r) => Math.hypot(r.x - q.x, r.y - q.y) < 1e-6), "a visible corner keeps its pixel");
});

test("PilotNav state: near the screw, drilling, the stop alarm (no-go or moved only)", () => {
  const p = new PilotNav(), s = fakeSession();
  p.setPhase("part", { ...state(p, s), sheetOk: true });
  CORNERS.forEach((c, i) => pivotOn(p, s, c as V3, i * 3, 2.2));
  p.setPhase("work", state(p, s));
  s.snapshot = snap({ t: 20, active: 0, offsetMm: 5, gapMm: 10 });
  assert.equal(state(p, s).nearScrew, true);
  s.snapshot = snap({ t: 20, active: 0, offsetMm: 50, gapMm: 10 });
  assert.equal(state(p, s).nearScrew, false);
  s.snapshot = snap({ t: 20, active: 0, phase: "drill" });
  assert.equal(state(p, s).drilling, true);
  s.snapshot = snap({ t: 20, alarms: 1 });
  assert.equal(state(p, s).stop, false);
  s.snapshot = snap({ t: 20, alarms: 8 });
  assert.equal(state(p, s).stop, true);
  assert.equal(state(p, s, 2).done, 2);
});

test("readPilotSaved: a round trip; bad data refused; work without an ok fit falls back to part", () => {
  const p = new PilotNav(), s = fakeSession();
  p.setPhase("part", { ...state(p, s), sheetOk: true });
  CORNERS.forEach((c, i) => pivotOn(p, s, c as V3, i * 3, 2.2));
  p.setPhase("work", state(p, s));
  const saved = JSON.parse(JSON.stringify(p.saved("2026-11-24T11:00:00.000Z"))) as PilotSaved;
  const back = readPilotSaved(saved);
  assert.ok(back);
  const q = new PilotNav(back);
  assert.equal(q.phase, "work");
  assert.equal(q.corners.length, 4);
  assert.equal(q.plan()!.id, p.plan()!.id, "the restored pilot gives the same plan");
  assert.equal(readPilotSaved(null), null);
  assert.equal(readPilotSaved({ ...saved, kind: "x" }), null);
  assert.equal(readPilotSaved({ ...saved, phase: "drill" }), null);
  assert.equal(readPilotSaved({ ...saved, corners: [[1, 2]] }), null);
  assert.equal(readPilotSaved({ ...saved, at: "never" }), null);
  assert.equal(readPilotSaved({ ...saved, fit: { ...saved.fit!, ok: false } })!.phase, "part");
  assert.equal(readPilotSaved({ ...saved, fit: null })!.phase, "part");
  // a restored capture does not take a corner already taken again
  const r = new PilotNav({ ...saved, phase: "part", corners: saved.corners.slice(0, 2), fit: null });
  assert.ok(pivotOn(r, s, saved.corners[0] as V3, 50, 2.2).every((x) => x.corner == null));
});

test("pilotScrews / nextScrew: done when recorded or drilled, active when guided to", () => {
  const p = new PilotNav(), s = fakeSession();
  p.setPhase("part", { ...state(p, s), sheetOk: true });
  CORNERS.forEach((c, i) => pivotOn(p, s, c as V3, i * 3, 2.2));
  const plan = p.plan()!;
  const name = (id: number) => fakeSession().name(id);
  let sc = pilotScrews(plan, snap({ t: 0, active: 1, drilled: [3] }), name, []);
  assert.deepEqual(sc.map((x) => x.state), ["done", "active", "todo", "todo"]);
  assert.equal(nextScrew(sc)!.label, "S2");
  sc = pilotScrews(plan, snap({ t: 0, active: 1 }), name, ["S1", "S2"]);
  assert.deepEqual(sc.map((x) => x.state), ["done", "done", "todo", "todo"]);
  assert.equal(nextScrew(sc)!.label, "S3");
  assert.equal(nextScrew(pilotScrews(plan, null, name, ["S1", "S2", "S3", "S4"])), null);
  assert.ok(sc.every((x) => x.z > 17 && x.depthMm > 0));
});

// ---------------- the simulator's block and person (lib/scene.ts) ----------------

test("the simulator's table and block: four sheets 2 × 2 with 6 mm gaps; a 100 mm block, 4°, centred where they meet", () => {
  assert.deepEqual(PILOT_TABLE.map((s) => s.k), [0, 1, 2, 3]);
  assert.deepEqual(PILOT_TABLE[0], { k: 0, x: 0, y: 0, yaw: 0 });
  assert.ok(Math.abs(PILOT_TABLE[1].x - (SHEET.w + 0.006)) < 1e-12 && Math.abs(PILOT_TABLE[2].y - (SHEET.h + 0.006)) < 1e-12);
  assert.deepEqual(PILOT_TABLE.map((s) => Math.round((s.yaw * 1800) / Math.PI) / 10), [0, 1.5, -2, 0.8]);
  const c = CORNERS;
  for (let i = 0; i < 4; i++) assert.ok(Math.abs(Math.hypot(c[(i + 1) % 4][0] - c[i][0], c[(i + 1) % 4][1] - c[i][1]) - 100) < 1e-9);
  assert.ok(Math.abs((Math.atan2(c[1][1] - c[0][1], c[1][0] - c[0][0]) * 180) / Math.PI - 4) < 1e-9);
  const mid = [c.reduce((a, p) => a + p[0], 0) / 4, c.reduce((a, p) => a + p[1], 0) / 4];
  assert.ok(Math.abs(mid[0] - (SHEET.w + 0.006) * 500) < 1e-9 && Math.abs(mid[1] - (SHEET.h + 0.006) * 500) < 1e-9);
  assert.ok(c.every((p) => p[2] === 18));
  // the layout before the table: beside sheet 0, its near edge 15 mm from the sheet's right edge
  const beside = pilotBlockCorners(blockBeside(15));
  assert.ok(Math.abs(Math.min(...beside.map((p) => p[0])) - ((SHEET.w * 1000) / 2 + 15)) < 1e-9);
  // the solid: the corners are on its boundary, its centre inside
  const solid = pilotBlockSolid();
  const [cx, cy] = pilotBlockCentre();
  assert.ok(Math.abs(solid.pose.p[0] * 1000 - cx) < 1e-9 && Math.abs(solid.pose.p[1] * 1000 - cy) < 1e-9);
  assert.equal(solid.planes.length, 6);
});

test("blockHides: a segment through the block, over it, beside it, and ending under it", () => {
  const [cx, cy] = pilotBlockCentre().map((v) => v / 1000);
  const top = PILOT_BLOCK.heightMm / 1000;
  assert.ok(blockHides(PILOT_BLOCK, [cx - 0.2, cy, top / 2], [cx + 0.2, cy, top / 2]), "straight through");
  assert.ok(!blockHides(PILOT_BLOCK, [cx - 0.2, cy, top + 0.01], [cx + 0.2, cy, top + 0.01]), "over it");
  assert.ok(!blockHides(PILOT_BLOCK, [cx - 0.2, cy + 0.08, 0.001], [cx + 0.2, cy + 0.08, 0.001]), "beside it");
  assert.ok(blockHides(PILOT_BLOCK, [cx, cy, 0.3], [cx + 0.01, cy, 0]), "a marker under the block");
  assert.ok(!blockHides(PILOT_BLOCK, [cx + 0.2, cy, 0.3], [cx + 0.12, cy, 0]), "a marker beyond it, seen from its side");
});

test("markersInView: every sheet of the table counts; the block hides the markers under and behind it", () => {
  const rig = DEFAULT_RIG;
  // the tip over the seam of sheets 1 and 2 (indices 0 and 1), the camera turned toward sheet 2
  const tip: V3 = [0.06, -0.06, 0.06];
  const pose = core.rigPose(0, 0, twistToward(core, rig, tip, [0.25, -0.06]), tip, rig.tool);
  const alone = markersInView(core, rig, pose);
  const table = markersInView(core, rig, pose, 6, 14, { table: PILOT_TABLE });
  assert.ok(table > alone && alone > 0, `sheet 0 alone ${alone}, the table ${table}`);
  // looking across the block from beside it: fewer markers with the block in the scene
  const c = pilotBlockCentre().map((v) => v / 1000);
  const t2: V3 = [c[0] - 0.09, c[1], 0.03];
  const p2 = core.rigPose(0, 0, twistToward(core, rig, t2, [c[0] + 0.1, c[1]]), t2, rig.tool);
  const open = markersInView(core, rig, p2, 6, 14, { table: PILOT_TABLE }), hidden = markersInView(core, rig, p2, 6, 14, { table: PILOT_TABLE, block: PILOT_BLOCK });
  assert.ok(hidden < open, `without the block ${open}, with it ${hidden}`);
});

test("twistToward: the camera ends up on the side of the look point", () => {
  const tip: V3 = [0.2, -0.05, 0.018];
  for (const look of [[0, 0], [0.2, 0.2], [0.4, -0.05]] as [number, number][]) {
    const tw = twistToward(core, DEFAULT_RIG, tip, look);
    const pose = core.rigPose(0, 0, tw, tip, DEFAULT_RIG.tool);
    const R = pose.R, t = pose.t;
    const cam = [-(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]), -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2])];
    const a = Math.atan2(cam[1] - tip[1], cam[0] - tip[0]), b = Math.atan2(look[1] - tip[1], look[0] - tip[0]);
    assert.ok(Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-6, `look ${look}`);
  }
});

test("pilotView: a near corner needs no lean; it keeps 8 markers or more in view over the pivot", () => {
  const near = CORNERS[0].map((v) => v / 1000) as V3;
  const v = pilotView(core, DEFAULT_RIG, near);
  assert.equal(v.leanDeg, 0);
  assert.ok(v.markers >= 8, `${v.markers}`);
  // the same answer again (cached)
  assert.deepEqual(pilotView(core, DEFAULT_RIG, near), v);
});

test("pilotHold: sheet hovers over the sheet; part travels then pivots on the corner; work drives to the depth", () => {
  const rig = DEFAULT_RIG;
  const tipOf = (h: ReturnType<typeof pilotHold>) => applyPoint(toolWorldFromHold(core, rig, h.hold), [0, 0, 0]);
  const sh = pilotHold(core, rig, { phase: "sheet", corners: 0, screw: null }, 2);
  assert.ok(Math.abs(sh.hold.tipWorld[0]) < 0.1 && sh.hold.tipWorld[2] > 0.03);
  // on the table the person visits the seams in turn, well above the block; one sheet alone: the old hover
  const seams = [2, 5.5, 9, 12.5].map((t) => pilotHold(core, rig, { phase: "sheet", corners: 0, screw: null }, t).hold.tipWorld);
  assert.ok(new Set(seams.map((p) => `${Math.round(p[0] * 20)},${Math.round(p[1] * 20)}`)).size === 4, "four stations");
  assert.ok(seams.every((p) => p[2] > PILOT_BLOCK.heightMm / 1000 + 0.04));
  const one = pilotHold(core, rig, { phase: "sheet", corners: 0, screw: null, table: [PILOT_TABLE[0]] }, 2).hold;
  assert.equal(one.twistDeg, 0);
  for (let k = 0; k < 4; k++) {
    const c = CORNERS[k].map((v) => v / 1000);
    const during = pilotHold(core, rig, { phase: "part", corners: k, screw: null }, 0.75);
    assert.equal(during.phase, "approach");
    const piv = [2, 2.75, 3.5].map((t) => pilotHold(core, rig, { phase: "part", corners: k, screw: null }, t));
    for (const h of piv) {
      assert.equal(h.phase, "align");
      const tip = tipOf(h);
      assert.ok(Math.hypot(tip[0] - c[0], tip[1] - c[1], tip[2] - c[2]) < 1e-9, "the tip stays on the corner");
    }
    // the bit sweeps the pivot
    const dy = Math.max(...piv.map((h) => h.hold.yawDeg)) - Math.min(...piv.map((h) => h.hold.yawDeg));
    const dp = Math.max(...piv.map((h) => h.hold.pitchDeg)) - Math.min(...piv.map((h) => h.hold.pitchDeg));
    assert.ok(Math.hypot(dy, dp) >= PILOT_PIVOT_DEG, `sweep ${dy} ${dp}`);
  }
  const screw = { x: 140, y: -40, z: 18, depthMm: 15 };
  const phases = new Set<string>();
  let deepest = 0;
  for (let t = 0; t < PILOT_SCREW_TIME; t += 0.05) {
    const h = pilotHold(core, rig, { phase: "work", corners: 4, screw }, t);
    phases.add(h.phase);
    deepest = Math.max(deepest, screw.z - tipOf(h)[2] * 1000);
  }
  assert.deepEqual([...phases], ["approach", "align", "drill", "hold", "retract"]);
  assert.ok(Math.abs(deepest - screw.depthMm) < 0.05, `deepest ${deepest}`);
  // no screw: hovering over the block
  assert.ok(pilotHold(core, rig, { phase: "work", corners: 4, screw: null }, 1).hold.tipWorld[2] > 0.05);
});
