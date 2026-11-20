import { test } from "node:test";
import assert from "node:assert/strict";
import { core, near } from "./helpers.mts";
import { inverse, xf, type Xf } from "../lib/xform.ts";
import { INTO_SHEET } from "../lib/scenedef.ts";

function rig() {
  const e = core.createEngine();
  const sheet = e.addNode("sheet", 0, "reference", xf());
  const a = e.addNode("A", sheet, "planned", xf([0.02, 0, 0], INTO_SHEET));
  const cam = e.addNode("camera", 0, "tracked", xf());
  const tool = e.addNode("tool", cam, "calibrated", xf([0, 0, 0.17]));
  e.setNavigation(tool, [a]);
  e.setCalibrated(tool, true);
  e.start(0);
  return { e, sheet, a, cam, tool };
}
// camera 0.17 m in front of A looking into the sheet: tool tip on A, square
const camOnA: Xf = xf([0.02, 0, 0.17], [0, 1, 0, 0]);

test("node errors are reported by name", () => {
  const { e } = rig();
  assert.throws(() => e.addNode("A", 0, "planned", xf()), /name taken/);
  assert.throws(() => e.addNode("x", 99, "planned", xf()), /unknown node/);
  assert.throws(() => e.addNode("y", 0, "tracked", xf([0, 0, 0], [1, 0, 0, 0], [2, 1, 1])), /scale on a rigid node/);
  e.free();
});

test("a measurement becomes a snapshot with navigation against the target", () => {
  const { e, sheet, a, cam } = rig();
  e.push(cam, sheet, inverse(camOnA), 0, 9, 0.3);
  assert.equal(e.advance(0), 1);
  const s = e.snapshot();
  assert.equal(s.nodes.length, 5);
  assert.equal(s.targets[0].id, a);
  assert.equal(s.active, 0);
  assert.ok(near(s.targets[0].angleErrDeg, 0, 1e-6) && near(s.targets[0].offsetMm, 0, 1e-6) && near(s.targets[0].gapMm, 0, 1e-6));
  assert.equal(s.nodes.find((n) => n.id === cam)?.status, "valid");
  assert.ok(s.events.some((ev) => ev.kind === "found"));
  assert.equal(e.snapshot().events.length, 0, "events are handed over once");
  e.free();
});

test("configure changes the tick rate; the clock is logical", () => {
  const { e } = rig();
  e.configure({ tickHz: 60, maxCatchup: 1000 });
  e.start(0);
  assert.equal(e.advance(1), 61);
  assert.ok(near(e.now(), 61 / 60, 1e-12));
  e.free();
});

test("same inputs, same snapshots", () => {
  const run = () => {
    const { e, sheet, cam } = rig();
    const out: number[] = [];
    for (let i = 0; i < 120; i++) {
      if (i % 4 === 0) e.push(cam, sheet, inverse(xf([0.02 + 0.001 * Math.sin(i), 0, 0.17], [0, 1, 0, 0])), i / 120 - 0.03, 8, 0.4);
      e.advance(i / 120);
      const s = e.snapshot();
      out.push(s.targets[0]?.offsetMm ?? -1, s.gate, s.ready ? 1 : 0);
    }
    e.free();
    return out;
  };
  assert.deepEqual(run(), run());
});

test("an uncalibrated tool keeps the gate closed", () => {
  const { e, sheet, cam, tool } = rig();
  e.setCalibrated(tool, false);
  for (let i = 0; i < 120; i++) {
    e.push(cam, sheet, inverse(camOnA), i / 60, 9, 0.2);
    e.advance(i / 60);
  }
  const s = e.snapshot();
  assert.equal(s.ready, false);
  assert.equal(s.gate & 1, 1);
  assert.equal(s.nodes.find((n) => n.id === tool)?.status, "uncalibrated");
  e.free();
});
