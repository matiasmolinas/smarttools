import { test } from "node:test";
import assert from "node:assert/strict";
import { core, detector, AR } from "./helpers.mts";
import { buildEngine } from "../lib/scenedef.ts";
import { BASE_BODY, BASE_ON_BENCH, BASE_STICKERS, SCREWS, assemblyScene, baseSolids, toolAt } from "../lib/assembly.ts";
import { StickerLearner, averageXf, bodyIds, codeOf, solveBodies, stickerSpecs } from "../lib/anchors.ts";
import { CALM, DEFAULT_RIG, cameraPoseForTool, markerCodes, renderTool } from "../lib/scene.ts";
import { MarkerTracker } from "../lib/markertracker.ts";
import { BOARD_MARKERS } from "../lib/board.ts";
import { applyDir, compose, fromPose, inverse, qangle, qaxis, xf } from "../lib/xform.ts";
import type { V3 } from "../lib/pose.ts";

const rig = DEFAULT_RIG;
const codeList: string[] = new AR.Dictionary("ARUCO_MIP_36h12").codeList;
const codes = markerCodes(codeList);
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("the part's markers are not the sheet's, and each code matches the renderer's table", () => {
  const ids = bodyIds([BASE_BODY]);
  assert.equal(ids.size, BASE_STICKERS.reduce((a, s) => a + s.markers.length, 0), "no id used twice");
  for (const m of BOARD_MARKERS) assert.ok(!ids.has(m.id));
  // the same bits as markerCodes (first cell = most significant bit)
  const c = codeOf(codeList, 5);
  for (let b = 0; b < 36; b++) assert.equal((c / 2 ** (35 - b)) & 1, codes[5 * 36 + b]);
});

/** A frame of the base on the bench with its stickers, seen from behind the bit over screw S2. */
function viewOf(part = BASE_ON_BENCH, sheetCodes = codes) {
  const tw = compose(part, SCREWS[1].frame);
  const toolW = toolAt(applyDir(tw, [0, 0, -0.04]).map((v, k) => v + tw.p[k]) as V3, applyDir(tw, [0, 0, 1]), [-tw.p[0], -tw.p[1], 0]);
  const img = renderTool(core, rig, sheetCodes, [toolW], CALM, 3, { solids: baseSolids(part), stickers: stickerSpecs(BASE_BODY, part, codeList), codes: sheetCodes });
  return { img, cam: cameraPoseForTool(rig, toolW) };
}

test("the tracker finds the part from its markers on several faces (T_camera_part within 0.3 mm)", () => {
  const { img, cam } = viewOf();
  const tr = new MarkerTracker(core, detector(), rig.camera, true);
  tr.setBodies([BASE_BODY]);
  const f = tr.frame(img, 0);
  assert.ok(f.pose, "the sheet is seen too");
  const b = f.bodies.find((x) => x.name === BASE_BODY.name);
  assert.ok(b && b.stickers >= 2 && b.markers >= 6, `body seen: ${JSON.stringify(b && { m: b.markers, s: b.stickers })}`);
  // truth: T_camera_part = T_camera_world · T_world_part
  const truth = compose(fromPose(cam), BASE_ON_BENCH);
  const est = fromPose(b!.pose);
  assert.ok(dist(est.p, truth.p) * 1000 < 0.3, `position ${(dist(est.p, truth.p) * 1000).toFixed(3)} mm`);
  assert.ok((qangle(est.q, truth.q) * 180) / Math.PI < 0.15, "rotation");
});

test("a part solid hides the sheet behind it, and a covered sheet gives no pose", () => {
  const { img } = viewOf(BASE_ON_BENCH, new Uint8Array(codes.length));
  const tr = new MarkerTracker(core, detector(), rig.camera, true);
  tr.setBodies([BASE_BODY]);
  const f = tr.frame(img, 0);
  assert.equal(f.pose, null);
  assert.ok(f.bodies.length === 1, "the part alone is still seen");
});

test("stickers stuck anywhere are learned from views of the located part", () => {
  const stuck = BASE_STICKERS.map((s, i) => ({ ...s, pose: compose(s.pose, xf([0.002 * i - 0.004, 0.001, 0], qaxis([0, 0, 1], 0.05 * i))) }));
  const single = stuck.map((st) => ({ name: st.name, stickers: [{ ...st, pose: xf() }] }));
  const learner = new StickerLearner(BASE_STICKERS);
  for (const k of [0, 1, 2, 3, 4]) {
    const tw = compose(BASE_ON_BENCH, SCREWS[k].frame);
    const toolW = toolAt(applyDir(tw, [0.005 * k, 0, -0.04]).map((v, j) => v + tw.p[j]) as V3, applyDir(tw, [0, 0, 1]), [-tw.p[0], -tw.p[1], 0]);
    const img = renderTool(core, rig, codes, [toolW], CALM, 3 + k, { solids: baseSolids(BASE_ON_BENCH), stickers: stickerSpecs({ name: "x", stickers: stuck }, BASE_ON_BENCH, codeList) });
    const tr = new MarkerTracker(core, detector(), rig.camera, true);
    tr.setBodies(single);
    const f = tr.frame(img, 0);
    learner.add(inverse(fromPose(f.pose!)), BASE_ON_BENCH, new Map(f.bodies.filter((b) => b.markers >= 2).map((b) => [b.name, b.pose])));
  }
  const { body } = learner.body(BASE_BODY.name, 2);
  assert.ok(body.stickers.length >= 4, `${body.stickers.length} stickers learned`);
  for (const st of body.stickers) {
    const t = stuck.find((x) => x.name === st.name)!;
    // five single frames, no tremor averaging: within 1 mm (the E2E learns over many frames: < 0.6 mm)
    assert.ok(dist(st.pose.p, t.pose.p) * 1000 < 1, `${st.name}: ${(dist(st.pose.p, t.pose.p) * 1000).toFixed(2)} mm`);
  }
});

test("averageXf: mean of nearby poses, quaternion signs handled", () => {
  const a = xf([0, 0, 0], qaxis([0, 0, 1], 0.1));
  const b = xf([0.002, 0, 0], qaxis([0, 0, 1], 0.2));
  const bNeg = { ...b, q: b.q.map((v) => -v) as typeof b.q };
  const m = averageXf([a, bNeg]);
  assert.ok(Math.abs(m.p[0] - 0.001) < 1e-12);
  assert.ok(Math.abs(qangle(m.q, qaxis([0, 0, 1], 0.15))) < 1e-6);
});

test("the engine scene with factory markers: the base is movable and its markers known", () => {
  const e = core.createEngine();
  const b = buildEngine(e, assemblyScene({ tool: rig.tool, anchors: "factory" }));
  assert.ok(b.ids[BASE_BODY.name] != null);
  e.free();
});
