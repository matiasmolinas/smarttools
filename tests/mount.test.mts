// The mount: how precise the pose is against the dock's tilt (lib/scene.ts dockRigAt). A seeded Monte Carlo on the
// real solver, no rendering: the drill square on sheet 0's centre with the tip on the sheet, twelve twists; the
// markers wholly in view projected with the rig's camera (no lens distortion), 0.3 px of corner noise, solvePose,
// then the bit's axis and tip in the sheet's frame against the truth. RMS per frame, unfiltered, one sheet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mts";
import { dockRigAt } from "../lib/scene.ts";
import { tipInView } from "../lib/dockrig.ts";
import { sheetMarkerCorners, sheetMarkerIds } from "../lib/board.ts";
import type { Pose, V3 } from "../lib/pose.ts";

const NOISE_PX = 0.3, TRIALS = 100, MARGIN_PX = 6, MIN_SIDE_PX = 14;
const D = Math.PI / 180;

/** camera frame -> sheet frame: a direction, or a point */
const toSheet = (p: Pose, v: V3, dir: boolean): V3 => {
  const u = dir ? v : [v[0] - p.t[0], v[1] - p.t[1], v[2] - p.t[2]];
  return [0, 1, 2].map((j) => p.R[j] * u[0] + p.R[3 + j] * u[1] + p.R[6 + j] * u[2]) as V3;
};

function tiltRun(tiltDeg: number) {
  const rig = dockRigAt(tiltDeg);
  const cam = { ...rig.camera, k1: 0, k2: 0, p1: 0, p2: 0 };
  const K = { f: cam.f, cx: cam.cx, cy: cam.cy };
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const tool = rig.tool;
  let n = 0, a2 = 0, z2 = 0, minMarkers = Infinity, maxMarkers = 0, lost = 0;
  for (let tw = 0; tw < 360; tw += 30) {
    const pose = core.rigPose(0, 0, tw, [0, 0, 0], tool);
    const world: { x: number; y: number }[] = [], img: { x: number; y: number }[] = [];
    let markers = 0;
    for (const id of sheetMarkerIds(0)) {
      const cs = sheetMarkerCorners(id)!;
      const px = core.projectPoints(cam, pose, cs.map((p) => [p.x, p.y, 0] as V3));
      if (px.some((p) => !p || p.x < MARGIN_PX || p.y < MARGIN_PX || p.x > rig.width - MARGIN_PX || p.y > rig.height - MARGIN_PX)) continue;
      const side = Math.min(...px.map((p, k) => Math.hypot(p!.x - px[(k + 1) % 4]!.x, p!.y - px[(k + 1) % 4]!.y)));
      if (side < MIN_SIDE_PX) continue;
      markers++;
      cs.forEach((p, k) => (world.push(p), img.push(px[k]!)));
    }
    minMarkers = Math.min(minMarkers, markers);
    maxMarkers = Math.max(maxMarkers, markers);
    if (markers < 4) {
      lost++;
      continue;
    }
    const axis = toSheet(pose, tool.axisCam, true), tip = toSheet(pose, tool.tipCam, false);
    for (let i = 0; i < TRIALS; i++) {
      const p = core.solvePose(world, img.map((q) => ({ x: q.x + NOISE_PX * gauss(), y: q.y + NOISE_PX * gauss() })), K);
      if (!p) continue;
      const ax = toSheet(p, tool.axisCam, true), t = toSheet(p, tool.tipCam, false);
      const cos = (ax[0] * axis[0] + ax[1] * axis[1] + ax[2] * axis[2]) / Math.hypot(...ax) / Math.hypot(...axis);
      a2 += (Math.acos(Math.min(1, cos)) / D) ** 2;
      z2 += ((t[2] - tip[2]) * 1000) ** 2;
      n++;
    }
  }
  return { tiltDeg, rig, n, minMarkers, maxMarkers, lost, angleDeg: Math.sqrt(a2 / n), depthMm: Math.sqrt(z2 / n) };
}

const runs = [0, 15, 25].map(tiltRun);
const [t0, t15, t25] = runs;
const line = (r: (typeof runs)[number]) => `${r.tiltDeg}°: ${r.minMarkers}-${r.maxMarkers} markers, angle ${r.angleDeg.toFixed(3)}°, depth ${r.depthMm.toFixed(3)} mm`;

test("the mount at 15° and 25°: at least 10 markers at every twist, angle RMS under 0.1°, depth RMS under 0.1 mm", () => {
  for (const r of [t15, t25]) {
    assert.equal(r.lost, 0, line(r));
    assert.ok(r.minMarkers >= 10, line(r));
    assert.ok(r.angleDeg < 0.1, line(r));
    assert.ok(r.depthMm < 0.1, line(r));
  }
});

test("the mount at 0°: the tip is out of the image and the angle is at least twice as noisy as at 15°", () => {
  const halfV = Math.atan2(t0.rig.height / 2, t0.rig.camera.f) / D;
  const v = tipInView(t0.rig.tool);
  assert.ok(Math.abs(v.downDeg) > halfV, `tip ${v.downDeg.toFixed(1)}° below the optical axis, half field ${halfV.toFixed(1)}°`);
  assert.ok(t0.n > 0, line(t0));
  assert.ok(t0.angleDeg >= 2 * t15.angleDeg, `${line(t0)} | ${line(t15)}`);
});

test("the precision does not get worse from 15° to 25°", () => {
  assert.ok(t25.angleDeg <= t15.angleDeg, `${line(t15)} | ${line(t25)}`);
  assert.ok(t25.depthMm <= t15.depthMm, `${line(t15)} | ${line(t25)}`);
  assert.ok(t25.minMarkers >= t15.minMarkers - 1, `${line(t15)} | ${line(t25)}`);
});
