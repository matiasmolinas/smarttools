import { test } from "node:test";
import assert from "node:assert/strict";
import { core, detector, AR } from "./helpers.mts";
import { NavSession, gateMessage } from "../lib/session.ts";
import { CALM, DEFAULT_RIG, markerCodes, navInTarget, renderTool, toolWorldFromHold } from "../lib/scene.ts";
import { compose } from "../lib/xform.ts";
import { toXf } from "../lib/scenedef.ts";
import { BOARD_TARGETS } from "../lib/board.ts";
import { hudView } from "../lib/render/hudview.ts";

const codes = markerCodes(new AR.Dictionary("ARUCO_MIP_36h12").codeList);
const rig = DEFAULT_RIG;

function sessionOnA2(tiltDeg = 0) {
  const s = new NavSession(core, detector(), { camera: rig.camera, cameraCalibrated: true, tool: rig.tool, toolCalibrated: true });
  const a2 = BOARD_TARGETS[1];
  const toolW = toolWorldFromHold(core, rig, { tipWorld: [a2.x, a2.y, 0.002], yawDeg: tiltDeg, pitchDeg: 0, twistDeg: 0 });
  const img = renderTool(core, rig, codes, [toolW], CALM, 5);
  for (let i = 0; i < 12; i++) {
    s.frame(img, i / 15);
    s.advance(i / 15);
  }
  return { s, toolW };
}

test("a rendered frame goes through tracker -> engine -> snapshot, matching the truth", () => {
  const { s, toolW } = sessionOnA2(1.0);
  const snap = s.snapshot!;
  const a2 = s.id("A2");
  assert.equal(snap.targets[snap.active].id, a2);
  const def = s.scene.def.nodes.find((n) => n.name === "A2")!;
  const truth = navInTarget(compose(toXf(), toXf(def.local)), toolW);
  const est = snap.targets[snap.active];
  assert.ok(Math.abs(est.angleErrDeg - truth.angleErrDeg) < 0.1, `angle ${est.angleErrDeg} vs ${truth.angleErrDeg}`);
  assert.ok(Math.abs(est.gapMm - truth.gapMm) < 0.3, `gap ${est.gapMm} vs ${truth.gapMm}`);
  assert.ok(s.lastFrame!.markers >= 4);
  const { aim, mark } = s.overlayPoints();
  assert.ok(aim && mark && aim.x > 0 && aim.x < rig.width && mark.y > 0, "overlay points project into the image");
  s.dispose();
});

test("setTool updates the engine node and the calibration flag", () => {
  const { s } = sessionOnA2();
  s.setTool({ tipCam: [0, 0.05, 0.16], axisCam: [0, 0, 1] }, false);
  s.advance(1);
  assert.equal(s.snapshot!.nodes.find((n) => n.id === s.id("tool"))!.status, "uncalibrated");
  assert.equal(gateMessage(s.snapshot!.gate), "Calibrate first");
  s.dispose();
});

test("the HUD adapter shows the engine's decision, not its own", () => {
  const { s } = sessionOnA2();
  const snap = s.snapshot!;
  const v = hudView({ def: s.scene.def, ids: s.scene.ids, snapshot: { ...snap, ready: true, locking: false, gate: 0 } });
  assert.equal(v.overlay.gate!.ready, true);
  assert.equal(v.state.label, "A2");
  assert.ok(Math.abs(v.state.target.y - BOARD_TARGETS[1].y) < 1e-9, "target in sheet coordinates");
  const v2 = hudView({ def: s.scene.def, ids: s.scene.ids, snapshot: { ...snap, ready: false, gate: 64 } });
  assert.equal(v2.overlay.gate!.message, "Hold steady");
  s.dispose();
});
