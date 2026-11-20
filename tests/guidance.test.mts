import { test } from "node:test";
import assert from "node:assert/strict";
import { guidance, materialAlong } from "../lib/guidance.ts";
import { BASE_ON_BENCH, BRACKET_MOUNT, SCREWS, SCREW_DEPTHS, baseSolids, bracketSolids } from "../lib/assembly.ts";
import { boxPlanes } from "../lib/anchors.ts";
import { compose, xf } from "../lib/xform.ts";
import type { EngineSnapshot, TargetNav } from "../lib/engine.ts";

const solids = [...baseSolids(BASE_ON_BENCH), ...bracketSolids(compose(BASE_ON_BENCH, BRACKET_MOUNT))];
const order = SCREWS.map((s) => s.name);
const ids = Object.fromEntries(order.map((n, i) => [n, i + 10]));
const worldOf = (n: string) => {
  const s = SCREWS.find((x) => x.name === n)!;
  return s.part === "base" ? compose(BASE_ON_BENCH, s.frame) : compose(compose(BASE_ON_BENCH, BRACKET_MOUNT), s.frame);
};
const nav = (id: number, o: Partial<TargetNav> = {}): TargetNav => ({ id, drilled: false, tip: [0, 0, -0.01], axis: [0, 0, 1], aim: [0, 0], yawDeg: 0, pitchDeg: 0, angleErrDeg: 0.1, offsetMm: 0.2, gapMm: 10, depthMm: 0, ...o });
function snap(activeName: string, drilled: string[], o: Partial<TargetNav> = {}): EngineSnapshot {
  const targets = order.map((n) => nav(ids[n], { drilled: drilled.includes(n), ...(n === activeName ? { gapMm: 1, ...o } : {}) }));
  return { nodes: order.map((n) => ({ id: ids[n], status: "static", age: 0, world: worldOf(n) })), targets, active: order.indexOf(activeName) } as unknown as EngineSnapshot;
}

test("materialAlong: through a box, and across touching solids as one stretch", () => {
  const box = { pose: xf(), planes: boxPlanes([0, 0, 0], [0.1, 0.1, 0.03]), shade: 1 };
  const top = { pose: xf(), planes: boxPlanes([0, 0, 0.03], [0.1, 0.1, 0.05]), shade: 1 };
  const span = materialAlong([box], [0.05, 0.05, 0.04], [0, 0, -1])!;
  assert.ok(Math.abs(span[0] - 0.01) < 1e-12 && Math.abs(span[1] - 0.04) < 1e-12);
  const both = materialAlong([box, top], [0.05, 0.05, 0.06], [0, 0, -1])!;
  assert.ok(Math.abs(both[1] - both[0] - 0.05) < 1e-12);
  assert.equal(materialAlong([box], [0.2, 0.05, 0.04], [0, 0, -1]), null);
});

test("x-ray: material left under each screw of the robot-arm base", () => {
  // S1 into the 30 mm block: 14 mm screw, 16 mm left; B1 through the bracket into the tower: plenty
  const s1 = guidance({ snap: snap("S1", []), order, ids, depths: SCREW_DEPTHS, solids }).xray!;
  assert.ok(Math.abs(s1.materialMm - 30) < 0.6 && Math.abs(s1.leftMm - 16) < 0.6 && !s1.breakthrough, JSON.stringify(s1));
  const b1 = guidance({ snap: snap("B1", []), order, ids, depths: SCREW_DEPTHS, solids }).xray!;
  assert.ok(b1.materialMm > 90 && !b1.breakthrough, `${b1.materialMm}`);
  // a 35 mm screw into the 30 mm block breaks through
  const deep = guidance({ snap: snap("S1", []), order, ids, depths: [35, ...SCREW_DEPTHS.slice(1)], solids }).xray!;
  assert.ok(deep.breakthrough && deep.leftMm < 0);
});

test("glow and order: the next hole, done screws, and a hole taken out of turn", () => {
  const g = guidance({ snap: snap("S3", ["S1"]), order, ids, depths: SCREW_DEPTHS, solids });
  const st = Object.fromEntries(g.holes.map((h) => [h.name, h.state]));
  assert.equal(st.S1, "done");
  assert.equal(st.S2, "next");
  assert.equal(st.S3, "active");
  assert.deepEqual(g.outOfOrder, { active: "S3", expected: "S2" });
  const ok = guidance({ snap: snap("S2", ["S1"]), order, ids, depths: SCREW_DEPTHS, solids });
  assert.equal(ok.outOfOrder, null);
  // passing over S3 on the way (far above it) is not taking it out of turn
  assert.equal(guidance({ snap: snap("S3", ["S1"], { gapMm: 40, offsetMm: 20 }), order, ids, depths: SCREW_DEPTHS }).outOfOrder, null);
  // holes on a part that is not located are not drawn
  const none = guidance({ snap: snap("S3", []), order, ids, depths: SCREW_DEPTHS, located: (n) => n.startsWith("B") });
  assert.ok(none.holes.every((h) => h.name.startsWith("B")) && none.tunnel === null && none.xray === null);
});

test("approach tunnel: coloured by the error", () => {
  const t = (o: Partial<TargetNav>) => guidance({ snap: snap("S1", [], o), order, ids, depths: SCREW_DEPTHS }).tunnel!.state;
  assert.equal(t({ offsetMm: 0.3, angleErrDeg: 0.2 }), "ok");
  assert.equal(t({ offsetMm: 1.5, angleErrDeg: 0.2 }), "warn");
  assert.equal(t({ offsetMm: 6, angleErrDeg: 4 }), "bad");
});
