import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { core } from "./helpers.mts";
import { buildEngine, smartToolsScene } from "../lib/scenedef.ts";
import { drawPlan, type Ctx2D } from "../lib/render/render2d.ts";
import { Scene3D } from "../lib/render/render3d.ts";
import { inverse, xf } from "../lib/xform.ts";
import { BOARD_TARGETS } from "../lib/board.ts";

const tool = { tipCam: [0, 0.058, 0.172] as [number, number, number], axisCam: [0, 0, 1] as [number, number, number] };

/** an engine with the camera measured: tool tip 10 mm in front of A1, square */
function snapshotOnA1() {
  const e = core.createEngine();
  const b = buildEngine(e, smartToolsScene({ tool }));
  e.setCalibrated(b.ids.tool, true);
  e.start(0);
  const a1 = BOARD_TARGETS[0];
  // camera world: looking into the sheet (180° about X), tip = camera + R·tipCam
  const camW = xf([a1.x, a1.y + 0.058, 0.01 + 0.172], [0, 1, 0, 0]);
  e.push(b.ids.camera, b.ids.sheet, inverse(camW), 0, 9, 0.3);
  e.advance(0);
  return { e, b, s: e.snapshot() };
}

function mockCtx() {
  const calls: { op: string; args: number[] }[] = [];
  const ctx = {
    strokeStyle: "", fillStyle: "", lineWidth: 1, globalAlpha: 1, font: "",
    save() {}, restore() {}, beginPath() {}, closePath() {}, stroke() {}, fill() {}, setLineDash() {},
    moveTo: (x: number, y: number) => calls.push({ op: "moveTo", args: [x, y] }),
    lineTo: (x: number, y: number) => calls.push({ op: "lineTo", args: [x, y] }),
    arc: (x: number, y: number, r: number) => calls.push({ op: "arc", args: [x, y, r] }),
    fillRect: () => {},
    fillText: (t: string, x: number, y: number) => calls.push({ op: `text:${t}`, args: [x, y] }),
  } satisfies Ctx2D;
  return { ctx, calls };
}

test("2D plan: targets as crosshairs and the drill as tip/chuck rings, in sheet coordinates", () => {
  const { e, b, s } = snapshotOnA1();
  const { ctx, calls } = mockCtx();
  const view = { frame: "sheet", pxPerM: 2000, width: 800, height: 800 };
  const drawn = drawPlan(ctx, b.def, b.ids, s, view);
  // A1 at (0, 0.06) m -> (400, 400 - 120)
  assert.deepEqual([Math.round(drawn.A1.x), Math.round(drawn.A1.y)], [400, 280]);
  assert.ok(calls.some((c) => c.op === "text:A1"));
  // the tool's tip ring is drawn at the tip (10 mm in front of A1 projects onto A1)
  const tipRing = calls.filter((c) => c.op === "arc").find((c) => Math.abs(c.args[0] - 400) < 0.5 && Math.abs(c.args[1] - 280) < 0.5 && c.args[2] === Math.max(2, 0.004 * 2000));
  assert.ok(tipRing, "tip ring on A1");
  // the camera (no visual2d other than a dot) and the sheet are drawn too
  assert.ok(drawn.sheet && drawn.camera && drawn.tool);
  e.free();
});

test("2D plan follows a node", () => {
  const { e, b, s } = snapshotOnA1();
  const { ctx } = mockCtx();
  const drawn = drawPlan(ctx, b.def, b.ids, s, { frame: "sheet", follow: "tool", pxPerM: 1000, width: 400, height: 400 });
  assert.ok(Math.abs(drawn.tool.x - 200) < 1e-6 && Math.abs(drawn.tool.y - 200) < 1e-6);
  e.free();
});

test("3D: one object per node with visuals, placed from the snapshot; STL meshes load", async () => {
  const { e, b, s } = snapshotOnA1();
  const stl = (url: string) => {
    const file = url.endsWith("dock-arm.stl") ? "dock-arm.stl" : "dock-saddle.stl";
    const buf = readFileSync(new URL(`../public/models/${file}`, import.meta.url));
    return Promise.resolve(new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
  };
  const scene = new Scene3D(b.def, { loadMesh: stl });
  await scene.ready;
  for (const n of b.def.nodes) assert.equal(scene.objects.has(n.name), !!n.visual3d?.length, n.name);
  scene.update(s, b.ids);
  const toolObj = scene.objects.get("tool")!;
  const p = new THREE.Vector3().setFromMatrixPosition(toolObj.matrixWorld);
  const tw = s.nodes.find((n) => n.id === b.ids.tool)!.world;
  assert.ok(p.distanceTo(new THREE.Vector3(...tw.p)) < 1e-9, "tool placed at its world transform");
  // the dock mesh (display node with scale 0.001) is in millimetres -> a few cm in the world
  const dock = scene.objects.get("dock")!;
  const box = new THREE.Box3().setFromObject(dock);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(size.length() > 0.05 && size.length() < 0.5, `dock size ${size.length()} m`);
  scene.dispose();
  e.free();
});
