// Planar pose from marker corners: homography (normalised DLT) + decomposition with known intrinsics.
// Camera frame (OpenCV): x right, y down, z forward. x_cam = R * X_world + t.

export type V3 = [number, number, number];
export type M3 = [number, number, number, number, number, number, number, number, number]; // row-major

export interface Intrinsics {
  f: number;
  cx: number;
  cy: number;
}

export interface Pose {
  R: M3;
  t: V3;
  rms: number; // reprojection error, px
}

export function homography(world: { x: number; y: number }[], img: { x: number; y: number }[]): M3 | null {
  const n = world.length;
  if (n < 4) return null;
  const norm = (pts: { x: number; y: number }[]) => {
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= pts.length; my /= pts.length;
    let d = 0;
    for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
    d /= pts.length;
    const s = d > 0 ? Math.SQRT2 / d : 1;
    return { s, mx, my, pts: pts.map((p) => ({ x: (p.x - mx) * s, y: (p.y - my) * s })) };
  };
  const W = norm(world);
  const I = norm(img);
  // A h = b with h33 = 1 -> normal equations (8x8)
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row: number[], b: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * b;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < n; i++) {
    const { x: X, y: Y } = W.pts[i];
    const { x: u, y: v } = I.pts[i];
    add([X, Y, 1, 0, 0, 0, -u * X, -u * Y], u);
    add([0, 0, 0, X, Y, 1, -v * X, -v * Y], v);
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const Hn: M3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // denormalise: H = Ti^-1 * Hn * Tw
  const Tw: M3 = [W.s, 0, -W.s * W.mx, 0, W.s, -W.s * W.my, 0, 0, 1];
  const TiInv: M3 = [1 / I.s, 0, I.mx, 0, 1 / I.s, I.my, 0, 0, 1];
  return mul(mul(TiInv, Hn), Tw);
}

export function poseFromHomography(H: M3, K: Intrinsics): Pose | null {
  // Kinv * H
  const kinv = (c: number) => [(H[c] - K.cx * H[6 + c]) / K.f, (H[3 + c] - K.cy * H[6 + c]) / K.f, H[6 + c]] as V3;
  const h1 = kinv(0);
  const h2 = kinv(1);
  const h3 = kinv(2);
  const lam = 2 / (len(h1) + len(h2));
  let r1 = scale(h1, lam);
  let r2 = scale(h2, lam);
  let t = scale(h3, lam);
  if (t[2] < 0) {
    r1 = scale(r1, -1);
    r2 = scale(r2, -1);
    t = scale(t, -1);
  }
  // orthonormalise (symmetric split of the error between r1 and r2)
  const a = normalize(r1);
  const b = normalize(r2);
  const c = normalize(add3(a, b));
  const d = normalize(cross(cross(a, b), c));
  r1 = normalize(sub3(c, d));
  r2 = normalize(add3(c, d));
  const r3 = cross(r1, r2);
  const R: M3 = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  return { R, t, rms: 0 };
}

export function project(p: V3, pose: Pose, K: Intrinsics): { x: number; y: number } | null {
  const c = apply(pose, p);
  if (c[2] <= 1e-6) return null;
  return { x: K.cx + (K.f * c[0]) / c[2], y: K.cy + (K.f * c[1]) / c[2] };
}

export function apply(pose: Pose, p: V3): V3 {
  const R = pose.R;
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + pose.t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + pose.t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + pose.t[2],
  ];
}

/** camera-frame point -> world */
export function toWorld(pose: Pose, c: V3): V3 {
  const R = pose.R;
  const d: V3 = [c[0] - pose.t[0], c[1] - pose.t[1], c[2] - pose.t[2]];
  return [R[0] * d[0] + R[3] * d[1] + R[6] * d[2], R[1] * d[0] + R[4] * d[1] + R[7] * d[2], R[2] * d[0] + R[5] * d[1] + R[8] * d[2]];
}

/** camera-frame direction -> world */
export function dirToWorld(pose: Pose, c: V3): V3 {
  const R = pose.R;
  return [R[0] * c[0] + R[3] * c[1] + R[6] * c[2], R[1] * c[0] + R[4] * c[1] + R[7] * c[2], R[2] * c[0] + R[5] * c[1] + R[8] * c[2]];
}

/** focal length from one homography, principal point known, square pixels (needs a tilted view) */
export function focalFromHomography(H: M3, cx: number, cy: number): number | null {
  // remove principal point: H' = T * H, T = [[1,0,-cx],[0,1,-cy],[0,0,1]]
  const g = [H[0] - cx * H[6], H[1] - cx * H[7], H[3] - cy * H[6], H[4] - cy * H[7], H[6], H[7]];
  const [a1, a2, b1, b2, c1, c2] = g;
  const est: number[] = [];
  const d1 = c1 * c2;
  if (Math.abs(d1) > 1e-12) {
    const f2 = -(a1 * a2 + b1 * b2) / d1;
    if (f2 > 0) est.push(Math.sqrt(f2));
  }
  const d2 = c1 * c1 - c2 * c2;
  if (Math.abs(d2) > 1e-12) {
    const f2 = -(a1 * a1 + b1 * b1 - a2 * a2 - b2 * b2) / d2;
    if (f2 > 0) est.push(Math.sqrt(f2));
  }
  if (!est.length) return null;
  return est.reduce((s, v) => s + v, 0) / est.length;
}

// ---- small linear algebra ----
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function mul(A: M3, B: M3): M3 {
  const o = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return o;
}
const len = (v: V3) => Math.hypot(v[0], v[1], v[2]);
const scale = (v: V3, s: number): V3 => [v[0] * s, v[1] * s, v[2] * s];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normalize = (v: V3): V3 => scale(v, 1 / (len(v) || 1));
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Gauss-Newton refinement of the pose on reprojection error (numeric Jacobian, 6 params). */
export function refinePose(
  pose: Pose,
  world: { x: number; y: number }[],
  img: { x: number; y: number }[],
  K: Intrinsics,
  iters = 8,
): Pose {
  let cur = pose;
  const resid = (p: Pose) => {
    const r: number[] = [];
    for (let i = 0; i < world.length; i++) {
      const q = project([world[i].x, world[i].y, 0], p, K);
      if (!q) return null;
      r.push(q.x - img[i].x, q.y - img[i].y);
    }
    return r;
  };
  const perturb = (p: Pose, d: number[]): Pose => {
    const R = mul(rodrigues([d[0], d[1], d[2]]), p.R);
    return { R, t: [p.t[0] + d[3], p.t[1] + d[4], p.t[2] + d[5]], rms: 0 };
  };
  let r0 = resid(cur);
  if (!r0) return pose;
  for (let it = 0; it < iters; it++) {
    const J: number[][] = [];
    const steps = [1e-5, 1e-5, 1e-5, 1e-6, 1e-6, 1e-6];
    for (let k = 0; k < 6; k++) {
      const d = [0, 0, 0, 0, 0, 0];
      d[k] = steps[k];
      const rk = resid(perturb(cur, d));
      if (!rk) return cur;
      J.push(rk.map((v, i) => (v - r0![i]) / steps[k]));
    }
    const A = Array.from({ length: 6 }, (_, i) => Array.from({ length: 6 }, (_, j) => J[i].reduce((s, v, n) => s + v * J[j][n], 0)));
    for (let i = 0; i < 6; i++) A[i][i] *= 1.0001;
    const b = Array.from({ length: 6 }, (_, i) => -J[i].reduce((s, v, n) => s + v * r0![n], 0));
    const dx = solve(A, b);
    if (!dx) break;
    const next = perturb(cur, dx);
    const r1 = resid(next);
    if (!r1) break;
    const e0 = r0.reduce((s, v) => s + v * v, 0);
    const e1 = r1.reduce((s, v) => s + v * v, 0);
    if (e1 > e0) break;
    cur = next;
    r0 = r1;
    if (e0 - e1 < 1e-9) break;
  }
  cur.rms = Math.sqrt(r0.reduce((s, v) => s + v * v, 0) / Math.max(1, r0.length / 2));
  return cur;
}

function rodrigues(w: V3): M3 {
  const th = len(w);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(w, 1 / th);
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
