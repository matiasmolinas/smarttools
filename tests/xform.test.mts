import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPoint, compose, fromArray, fromPose, inverse, qangle, qaxis, qfromM3, qfromTo, qmul, qrot, qtoM3, relative, toArray, toMatrix4ColumnMajor, toPose, xf } from "../lib/xform.ts";
import { nearV } from "./helpers.mts";

let seed = 1;
const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
const randXf = () => xf([r(), r(), r()], qaxis([r(), r(), r()], r() * 3));

test("quaternion rotation matches its matrix and survives a round trip", () => {
  for (let i = 0; i < 100; i++) {
    const q = qaxis([r(), r(), r()], r() * 3);
    const m = qtoM3(q);
    const v: [number, number, number] = [r(), r(), r()];
    const mv = [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
    assert.ok(nearV(qrot(q, v), mv, 1e-12));
    assert.ok(qangle(qfromM3(m), q) < 1e-9);
  }
});

test("compose matches 4x4 matrices; inverse and relative are exact", () => {
  for (let i = 0; i < 100; i++) {
    const a = randXf(), b = randXf();
    const A = toMatrix4ColumnMajor(a), B = toMatrix4ColumnMajor(b), AB = toMatrix4ColumnMajor(compose(a, b));
    for (let c = 0; c < 4; c++)
      for (let rr = 0; rr < 4; rr++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += A[k * 4 + rr] * B[c * 4 + k];
        assert.ok(Math.abs(v - AB[c * 4 + rr]) < 1e-12);
      }
    const p: [number, number, number] = [r(), r(), r()];
    assert.ok(nearV(applyPoint(inverse(a), applyPoint(a, p)), p, 1e-12));
    assert.ok(nearV(compose(a, relative(a, b)).p, b.p, 1e-12));
  }
});

test("pose (x_cam = R X + t) converts both ways; arrays round-trip", () => {
  const t = randXf();
  const pose = toPose(t);
  const back = fromPose(pose);
  assert.ok(nearV(back.p, t.p, 1e-12) && qangle(back.q, t.q) < 1e-9);
  assert.deepEqual(fromArray(toArray(t)).p, t.p);
});

test("fromTo takes a direction to another (including the opposite)", () => {
  const q = qfromTo([0, 0, 1], [0.2, -0.3, 0.9]);
  const l = Math.hypot(0.2, -0.3, 0.9);
  assert.ok(nearV(qrot(q, [0, 0, 1]), [0.2 / l, -0.3 / l, 0.9 / l], 1e-12));
  assert.ok(nearV(qrot(qfromTo([0, 0, 1], [0, 0, -1]), [0, 0, 1]), [0, 0, -1], 1e-12));
  assert.ok(nearV(qrot(qmul(qaxis([0, 0, 1], Math.PI / 2), qaxis([1, 0, 0], Math.PI / 2)), [0, 1, 0]), qrot(qaxis([0, 0, 1], Math.PI / 2), [0, 0, 1]), 1e-12));
});
