// Transforms on the TypeScript side (renderers, scene definitions, the simulator). Same conventions
// as engine/src/scene.rs: Hamilton quaternions [w, x, y, z], T_a_b maps points from b to a, metres.

import type { M3, Pose, V3 } from "./pose.ts";

export type Q = [number, number, number, number];
export interface Xf {
  p: V3;
  q: Q;
  s: V3;
}

export const QI: Q = [1, 0, 0, 0];
export const XI: Xf = { p: [0, 0, 0], q: QI, s: [1, 1, 1] };

export const xf = (p: V3 = [0, 0, 0], q: Q = QI, s: V3 = [1, 1, 1]): Xf => ({ p, q: qnorm(q), s });

export function qnorm(q: Q): Q {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-300 && Number.isFinite(n) ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
}
export function qmul(a: Q, b: Q): Q {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
export const qconj = (q: Q): Q => [q[0], -q[1], -q[2], -q[3]];
export function qrot(q: Q, v: V3): V3 {
  const [w, x, y, z] = q;
  const c1: V3 = [y * v[2] - z * v[1] + w * v[0], z * v[0] - x * v[2] + w * v[1], x * v[1] - y * v[0] + w * v[2]];
  return [v[0] + 2 * (y * c1[2] - z * c1[1]), v[1] + 2 * (z * c1[0] - x * c1[2]), v[2] + 2 * (x * c1[1] - y * c1[0])];
}
export function qaxis(axis: V3, angle: number): Q {
  const l = Math.hypot(...axis);
  if (l < 1e-300) return QI;
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), (axis[0] / l) * s, (axis[1] / l) * s, (axis[2] / l) * s];
}
/** Smallest rotation taking direction a to direction b. */
export function qfromTo(a: V3, b: V3): Q {
  const na = unit(a), nb = unit(b);
  const d = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
  if (d < -1 + 1e-12) return qaxis(Math.abs(na[0]) < 0.9 ? cross(na, [1, 0, 0]) : cross(na, [0, 1, 0]), Math.PI);
  const c = cross(na, nb);
  return qnorm([1 + d, c[0], c[1], c[2]]);
}
export function qtoM3(q: Q): M3 {
  const [w, x, y, z] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
export function qfromM3(m: M3): Q {
  const tr = m[0] + m[4] + m[8];
  let q: Q;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    q = [(m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    q = [(m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s];
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
    q = [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s];
  }
  return qnorm(q);
}
/** Angle between rotations, radians (q ≡ -q). */
export function qangle(a: Q, b: Q): number {
  const d = qmul(qconj(a), b);
  return 2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), Math.abs(d[0]));
}

/** a · b */
export function compose(a: Xf, b: Xf): Xf {
  const r = qrot(a.q, [a.s[0] * b.p[0], a.s[1] * b.p[1], a.s[2] * b.p[2]]);
  return { p: [a.p[0] + r[0], a.p[1] + r[1], a.p[2] + r[2]], q: qnorm(qmul(a.q, b.q)), s: [a.s[0] * b.s[0], a.s[1] * b.s[1], a.s[2] * b.s[2]] };
}
/** Inverse of the rigid part. */
export function inverse(a: Xf): Xf {
  const qi = qconj(a.q);
  const p = qrot(qi, a.p);
  return { p: [-p[0], -p[1], -p[2]], q: qi, s: [1, 1, 1] };
}
export function applyPoint(a: Xf, v: V3): V3 {
  const r = qrot(a.q, [a.s[0] * v[0], a.s[1] * v[1], a.s[2] * v[2]]);
  return [a.p[0] + r[0], a.p[1] + r[1], a.p[2] + r[2]];
}
export const applyDir = (a: Xf, v: V3): V3 => qrot(a.q, v);
/** T_a_b from world transforms of a and b. */
export const relative = (wa: Xf, wb: Xf): Xf => compose(inverse(wa), wb);

/** Column-major 4x4 (three.js Matrix4.fromArray / WebGL). */
export function toMatrix4ColumnMajor(a: Xf): number[] {
  const r = qtoM3(a.q);
  const s = a.s;
  return [r[0] * s[0], r[3] * s[0], r[6] * s[0], 0, r[1] * s[1], r[4] * s[1], r[7] * s[1], 0, r[2] * s[2], r[5] * s[2], r[8] * s[2], 0, a.p[0], a.p[1], a.p[2], 1];
}

/** Pose solver output (x_cam = R X + t) as T_cam_ref, and back. */
export const fromPose = (p: Pose): Xf => ({ p: [...p.t] as V3, q: qfromM3(p.R), s: [1, 1, 1] });
export const toPose = (a: Xf): Pose => ({ R: qtoM3(a.q), t: [...a.p] as V3, rms: 0 });

export const toArray = (a: Xf): number[] => [...a.p, ...a.q, ...a.s];
export const fromArray = (v: ArrayLike<number>, o = 0): Xf => ({
  p: [v[o], v[o + 1], v[o + 2]],
  q: qnorm([v[o + 3], v[o + 4], v[o + 5], v[o + 6]]),
  s: [v[o + 7], v[o + 8], v[o + 9]],
});

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function unit(v: V3): V3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
