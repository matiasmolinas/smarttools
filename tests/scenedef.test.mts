import { test } from "node:test";
import assert from "node:assert/strict";
import { core } from "./helpers.mts";
import { buildEngine, smartToolsScene, toolLocal, validateScene, type SceneDef } from "../lib/scenedef.ts";
import { qrot } from "../lib/xform.ts";
import { BOARD_TARGETS } from "../lib/board.ts";

const tool = { tipCam: [0.003, 0.058, 0.172] as [number, number, number], axisCam: [0.0179, -0.0159, 0.9997] as [number, number, number] };

test("the SmartTools scene is valid and has 3D and 2D representations", () => {
  const def = smartToolsScene({ tool });
  assert.deepEqual(validateScene(def), []);
  const drill = def.nodes.find((n) => n.name === "tool")!;
  assert.ok(drill.visual3d!.length >= 3, "drill has a 3D model");
  assert.equal(drill.visual2d![0].kind, "rings", "and a simplified 2D symbol");
  assert.ok(def.nodes.find((n) => n.name === "dock")!.visual3d!.some((v) => v.kind === "mesh"), "the dock is an STL mesh");
  assert.deepEqual(def.navigation.targets, BOARD_TARGETS.map((t) => t.label));
  assert.equal(validateScene(smartToolsScene({ tool, angledTargetDeg: 15 })).length, 0);
});

test("validation catches structural mistakes", () => {
  const base = smartToolsScene({ tool });
  const bad = (f: (d: SceneDef) => void) => {
    const d: SceneDef = structuredClone(base);
    f(d);
    return validateScene(d).join(" | ");
  };
  assert.match(bad((d) => d.nodes.push({ ...d.nodes[0] })), /duplicate node "sheet"/);
  assert.match(bad((d) => (d.nodes.find((n) => n.name === "A1")!.parent = "nowhere")), /parent "nowhere"/);
  assert.match(bad((d) => (d.nodes.find((n) => n.name === "tool")!.local!.s = [2, 2, 2])), /scale is only allowed on display/);
  assert.match(bad((d) => (d.navigation.tool = "sheet")), /must be below the tracked node/);
  assert.match(bad((d) => (d.navigation.targets = ["camera"])), /must be a planned node/);
  assert.match(bad((d) => d.nodes.find((n) => n.name === "dock")!.visual3d!.push({ kind: "mesh", url: "/x.obj", format: "stl", material: { color: "#fff" } })), /only STL/);
});

test("buildEngine creates the structure only, and maps names to ids", () => {
  const e = core.createEngine();
  const b = buildEngine(e, smartToolsScene({ tool }));
  assert.equal(b.ids.world, 0);
  assert.equal(b.names[b.ids.tool], "tool");
  e.start(0);
  e.advance(0);
  const s = e.snapshot();
  assert.equal(s.nodes.length, Object.keys(b.ids).length);
  assert.equal(s.targets.length, 0, "no navigation until the camera is measured");
  e.free();
});

test("the tool's local transform puts +Z on the calibrated bit axis", () => {
  const l = toolLocal(tool);
  const z = qrot(l.q, [0, 0, 1]);
  const n = Math.hypot(...tool.axisCam);
  assert.ok(z.every((v, i) => Math.abs(v - tool.axisCam[i] / n) < 1e-12));
  assert.deepEqual(l.p, tool.tipCam);
});

test("the dock and the drill are placed from one geometry (hardware/dock/dock.py)", async () => {
  const { dockRig, DOCK } = await import("../lib/dockrig.ts");
  const { compose, applyPoint } = await import("../lib/xform.ts");
  for (const tiltDeg of [0, 10, 20]) {
    const rig = dockRig({ tiltDeg });
    const def = smartToolsScene({ tool: rig.tool, dockTiltDeg: tiltDeg });
    const local = (n: string) => def.nodes.find((x) => x.name === n)!.local!;
    // the bit tip through the tool node vs through the dock's saddle frame
    const viaTool = local("tool").p!;
    const d = local("dock");
    const saddleToCam = { p: d.p!, q: d.q!, s: d.s! };
    const viaDock = applyPoint(compose(saddleToCam, { p: [0, 0, 0], q: [1, 0, 0, 0], s: [1, 1, 1] }), [...DOCK.drill.tipX ? [DOCK.drill.tipX, 0, DOCK.drill.axisZ] : [0, 0, 0]] as [number, number, number]);
    assert.ok(viaTool.every((v, i) => Math.abs(v - viaDock[i]) < 1e-9), `tilt ${tiltDeg}: ${viaTool} vs ${viaDock}`);
  }
});
