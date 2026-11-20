import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mts";
import { validateScene, buildEngine } from "../lib/scenedef.ts";
import { BASE_NOMINAL, BASE_ON_BENCH, BRACKET_MOUNT, CHECKPOINTS, FIDUCIALS, SCREWS, SCREW_DEPTHS, assemblyScene, probeError, registerPart, toolAt, worldPoint } from "../lib/assembly.ts";
import { DEFAULT_RIG } from "../lib/scene.ts";
import { applyDir, compose, inverse, qangle, xf } from "../lib/xform.ts";

const tool = DEFAULT_RIG.tool;

test("the assembly scene is valid: 10 screws on 3 faces, every hole a child of its part", () => {
  const def = assemblyScene({ tool });
  assert.deepEqual(validateScene(def), []);
  assert.equal(def.navigation.targets.length, 10);
  const parents = new Set(SCREWS.map((s) => def.nodes.find((n) => n.name === s.name)!.parent));
  assert.deepEqual([...parents].sort(), ["base", "bracket"]);
  const faces = new Set(SCREWS.map((s) => s.face));
  assert.equal(faces.size, 3);
  // the chamfer holes are driven 35° off vertical
  const c1 = SCREWS.find((s) => s.name === "C1")!;
  const z = applyDir(c1.frame, [0, 0, 1]);
  assert.ok(Math.abs((Math.acos(-z[2]) * 180) / Math.PI - 35) < 1e-9);
});

test("touching the four dimples registers the base, and the checkpoints verify it", () => {
  const e = core.createEngine();
  const b = buildEngine(e, assemblyScene({ tool }));
  // touches with 0.2 mm of noise at the true placement
  const touches = FIDUCIALS.map((f, i) => {
    const w = worldPoint(BASE_ON_BENCH, f.p);
    const n = 0.0002 * Math.sin(i * 2.1 + 0.3);
    return [w[0] + n, w[1] - n, w[2] + n * 0.5] as [number, number, number];
  });
  const r = registerPart(core, e, b.ids.base, xf(), FIDUCIALS.map((f) => f.p), touches)!;
  assert.ok(r.freMm < 0.3, `FRE ${r.freMm}`);
  assert.ok(qangle(r.world.q, BASE_ON_BENCH.q) < (0.2 * Math.PI) / 180, "orientation within 0.2°");
  for (const k of CHECKPOINTS) assert.ok(probeError(r.world, k.p, worldPoint(BASE_ON_BENCH, k.p)) < 0.5, `${k.name} within 0.5 mm`);
  // the engine now holds the registered pose: every hole moved with the base
  e.start(0);
  e.advance(0);
  const s1 = e.snapshot().nodes.find((n) => n.id === b.ids.S1)!.world;
  const truth = compose(BASE_ON_BENCH, SCREWS[0].frame);
  assert.ok(Math.hypot(s1.p[0] - truth.p[0], s1.p[1] - truth.p[1], s1.p[2] - truth.p[2]) < 0.0005);
  assert.equal(e.snapshot().nodes.find((n) => n.id === b.ids.base)!.status, "static", "registered = calibrated");
  e.free();
});

test("a misplaced bracket is caught by probing", () => {
  const moved = compose(BRACKET_MOUNT, xf([0.0021, 0, 0]));
  const tip = worldPoint(compose(BASE_ON_BENCH, moved), [0.03, 0.03, 0]);
  assert.ok(probeError(compose(BASE_ON_BENCH, BRACKET_MOUNT), [0.03, 0.03, 0], tip) > 2);
});

test("screw depths are per target, and toolAt puts the tip and the bit where asked", () => {
  assert.deepEqual(SCREW_DEPTHS.slice(0, 6), [14, 14, 14, 14, 10, 10]);
  const t = toolAt([0.1, 0.02, 0.03], [0, 0.5, -0.8], [-1, 0, 0]);
  const z = applyDir(t, [0, 0, 1]);
  const n = Math.hypot(0, 0.5, -0.8);
  assert.ok(Math.abs(z[1] - 0.5 / n) < 1e-12 && Math.abs(z[2] + 0.8 / n) < 1e-12);
  const camSide = applyDir(t, [0, -1, 0]);
  assert.ok(camSide[0] < -0.9, "the camera is on the requested side");
  assert.ok(BASE_NOMINAL && inverse(BASE_NOMINAL));
});
