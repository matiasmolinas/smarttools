// The Rust marker detector (engine/src/detect.rs) against js-aruco2 and against the truth, on rendered camera
// frames (lens model, noise, blur, the bit in view): same corner order, corners within a pixel of the truth,
// no false or duplicate ids, the same pose accuracy, and faster.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { core } from "./helpers.mts";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, cameraPoseForTool, markerCodes, renderTool, toolWorldFromHold } from "../lib/scene.ts";
import { markerCorners } from "../lib/board.ts";
import { MarkerTracker } from "../lib/markertracker.ts";
import { RustDetector, compareDetections } from "../lib/detectors.ts";
import { toolLocal } from "../lib/scenedef.ts";
import { compose, fromPose, inverse } from "../lib/xform.ts";

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const codes = markerCodes(new AR.Dictionary("ARUCO_MIP_36h12").codeList);
const rig = DEFAULT_RIG;

const frames = (() => {
  const out: { toolW: ReturnType<typeof toolWorldFromHold>; img: ReturnType<typeof renderTool> }[] = [];
  let i = 0;
  for (const [x, y] of [[0, 0.06], [0, -0.02], [0.04, 0.02], [-0.05, -0.06]])
    for (const [z, yaw, pitch] of [[0.003, 0, 0], [0.03, 8, -5], [0.08, -12, 10]]) {
      const toolW = toolWorldFromHold(core, rig, { tipWorld: [x, y, z], yawDeg: yaw, pitchDeg: pitch, twistDeg: yaw * 2 });
      out.push({ toolW, img: renderTool(core, rig, codes, [toolW], DEFAULT_DISTURBANCE, 31 + i++) });
    }
  return out;
})();

test("rust detector: only the sheet's ids, once each, corners within a pixel of the truth (same order as js-aruco2)", () => {
  let found = 0;
  let worst = 0;
  for (const f of frames) {
    const R = core.detectMarkers(f.img, codes);
    const ids = R.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, "no duplicate ids");
    assert.ok(ids.every((id) => id < 28), `only sheet ids: ${ids.filter((id) => id >= 28)}`);
    found += R.length;
    const pose = cameraPoseForTool(rig, f.toolW);
    for (const m of R) {
      const truth = core.projectPoints(rig.camera, pose, markerCorners(m.id)!.map((c) => [c.x, c.y, 0] as [number, number, number]));
      for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.hypot(m.corners[k].x - truth[k]!.x, m.corners[k].y - truth[k]!.y));
    }
    // same ids and corner order as js-aruco2 where both see a marker
    const J = new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" }).detect(f.img).filter((m: { id: number }) => m.id < 28);
    const c = compareDetections(J, R);
    assert.ok(c.shared >= Math.min(J.length, R.length) - 3, `shared ${c.shared} of ${J.length} / ${R.length}`);
    // js-aruco2's raw corners can sit a few px off the edge; a wrong corner order would be a marker's size away
    assert.ok(c.maxCornerPx < 10, `corner order: max ${c.maxCornerPx.toFixed(2)} px`);
  }
  assert.ok(found / frames.length >= 10, `${(found / frames.length).toFixed(1)} markers per frame`);
  assert.ok(worst < 1.2, `worst corner ${worst.toFixed(2)} px from the truth`);
});

test("rust detector: the same pose accuracy as js-aruco2 through the whole tracker, and faster", () => {
  const run = (det: ConstructorParameters<typeof MarkerTracker>[1]) => {
    const tr = new MarkerTracker(core, det, rig.camera, true);
    const err: number[] = [];
    let ms = 0;
    frames.forEach((f, i) => {
      const t0 = performance.now();
      const r = tr.frame(f.img, i / 30);
      ms += performance.now() - t0;
      assert.ok(r.pose, "a pose on every frame");
      const est = compose(inverse(fromPose(r.pose!)), toolLocal(rig.tool));
      err.push(Math.hypot(est.p[0] - f.toolW.p[0], est.p[1] - f.toolW.p[1], est.p[2] - f.toolW.p[2]) * 1000);
    });
    err.sort((a, b) => a - b);
    return { p95: err[Math.floor(err.length * 0.95)], ms: ms / frames.length };
  };
  const js = run(new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" }));
  const rust = run(new RustDetector(core, codes));
  assert.ok(rust.p95 < Math.max(0.2, js.p95 * 1.5), `tip error p95: rust ${rust.p95.toFixed(3)} vs js ${js.p95.toFixed(3)} mm`);
  assert.ok(rust.ms < js.ms, `frame time: rust ${rust.ms.toFixed(1)} vs js ${js.ms.toFixed(1)} ms`);
});
