// Parity: the Rust core (public/engine/nav_core.wasm) must give the same results as the TypeScript
// prototype (lib/pose.ts, lib/subpix.ts) on the same inputs.
// Run: node --no-warnings scripts/engine-parity.mts   (after engine/build.sh)
import { readFileSync } from "node:fs";
import { NavCore } from "../lib/engine.ts";
import { homography, poseFromHomography, refinePose, focalFromHomography, project, type M3, type Pose, type V3 } from "../lib/pose.ts";
import { refineCorners } from "../lib/subpix.ts";
import { BOARD_MARKERS, BOARD_TARGETS, MARKER_SIZE } from "../lib/board.ts";

const core = await NavCore.load(readFileSync(new URL("../public/engine/nav_core.wasm", import.meta.url)));

// deterministic RNG
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const between = (a: number, b: number) => a + (b - a) * rnd();

function rodrigues(w: V3): M3 {
  const th = Math.hypot(...w);
  const [x, y, z] = w.map((v) => v / th);
  const c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}
const mul = (A: M3, B: M3) => {
  const o = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return o;
};
const BASE: M3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];

let worst = { H: 0, pose0: 0, refined: 0, focal: 0, corners: 0 };
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>, rel = false) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]) / (rel ? Math.max(1, Math.abs(a[i])) : 1);
    m = Math.max(m, d);
  }
  return m;
};
const flat = (p: Pose) => [...p.R, ...p.t];

// ---- pose pipeline: 300 random views of 6 markers (24 corners), with pixel noise ----
const CASES = 300;
let compared = 0;
let improved = 0;
let refinedCorners = 0;
for (let c = 0; c < CASES; c++) {
  const K = { f: between(700, 1500), cx: 640, cy: 360 };
  const R = mul(rodrigues([between(-0.6, 0.6), between(-0.6, 0.6), between(-0.4, 0.4)]), BASE);
  const pose: Pose = { R, t: [between(-0.05, 0.05), between(-0.05, 0.05), between(0.15, 0.45)], rms: 0 };
  const world: { x: number; y: number }[] = [];
  for (const mx of [-0.07, 0.07]) for (const my of [0.115, 0, -0.115]) for (const [dx, dy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) world.push({ x: mx + dx * 0.02, y: my + dy * 0.02 });
  const img = world.map((w) => {
    const q = project([w.x, w.y, 0], pose, K)!;
    return { x: q.x + between(-0.4, 0.4), y: q.y + between(-0.4, 0.4) };
  });
  const hT = homography(world, img), hR = core.homography(world, img);
  if (!hT || !hR) throw new Error(`case ${c}: homography missing (ts ${!!hT}, rust ${!!hR})`);
  worst.H = Math.max(worst.H, maxDiff(hT, hR, true));
  const pT = poseFromHomography(hT, K)!, pR = core.poseFromHomography(hT, K)!;
  worst.pose0 = Math.max(worst.pose0, maxDiff(flat(pT), flat(pR)));
  const rT = refinePose({ ...pT, R: [...pT.R] as M3 }, world, img, K), rR = core.refinePose(pT, world, img, K);
  worst.refined = Math.max(worst.refined, maxDiff(flat(rT), flat(rR)), Math.abs(rT.rms - rR.rms));
  const fT = focalFromHomography(hT, K.cx, K.cy), fR = core.focalFromHomography(hT, K.cx, K.cy);
  if ((fT == null) !== (fR == null)) throw new Error(`case ${c}: focal presence differs`);
  if (fT != null && fR != null) worst.focal = Math.max(worst.focal, Math.abs(fT - fR) / fT);
  if (maxDiff(flat(rR), flat(pT)) > 1e-9) improved++;
  compared++;
}

// ---- sub-pixel corners: 60 rotated, anti-aliased black squares ----
for (let c = 0; c < 60; c++) {
  const W = 160, H = 160;
  const cx = between(70, 90), cy = between(70, 90), half = between(18, 40), ang = between(-0.8, 0.8);
  const s = Math.sin(ang), co = Math.cos(ang);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4 - cx, py = y + (sy + 0.5) / 4 - cy;
      const u = co * px + s * py, v = -s * px + co * py;
      acc += Math.abs(u) < half && Math.abs(v) < half ? 20 : 235;
    }
    const i = (y * W + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = Math.round(acc / 16);
    data[i + 3] = 255;
  }
  const truth = [[-half, -half], [half, -half], [half, half], [-half, half]].map(([u, v]) => ({ x: cx + co * u - s * v, y: cy + s * u + co * v }));
  const rough = truth.map((p) => ({ x: Math.floor(p.x + Math.sign(cx - p.x) * 0.5), y: Math.floor(p.y + Math.sign(cy - p.y) * 0.5) }));
  const img = { width: W, height: H, data };
  const a = refineCorners(img, rough), b = core.refineCorners(img, rough);
  if (b !== rough) refinedCorners++;
  worst.corners = Math.max(worst.corners, maxDiff(a.flatMap((p) => [p.x, p.y]), b.flatMap((p) => [p.x, p.y])));
}

// ---- the marker sheet compiled into the core must match lib/board.ts ----
{
  const b = core.boardInfo();
  const same =
    b.markerSize === MARKER_SIZE &&
    b.markers.length === BOARD_MARKERS.length &&
    BOARD_MARKERS.every((m) => b.markers[m.id].x === m.x && b.markers[m.id].y === m.y) &&
    b.targets.length === BOARD_TARGETS.length &&
    BOARD_TARGETS.every((t, i) => b.targets[i].x === t.x && b.targets[i].y === t.y);
  console.log(`${same ? "ok  " : "FAIL"} board    ${b.markers.length} markers of ${b.markerSize * 1000} mm, ${b.targets.length} targets`);
  if (!same) process.exitCode = 1;
}

const LIMITS = { H: 1e-9, pose0: 1e-9, refined: 1e-7, focal: 1e-9, corners: 1e-9 };
let ok = true;
for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
  const pass = worst[k] <= LIMITS[k];
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${k.padEnd(8)} max diff ${worst[k].toExponential(2)}  (limit ${LIMITS[k].toExponential(0)})`);
}
console.log(`${compared} pose cases (Gauss-Newton moved the pose in ${improved}), 60 corner cases (refined in ${refinedCorners})`);
ok &&= improved > compared * 0.9 && refinedCorners > 50;
console.log(ok ? "PARITY PASS" : "PARITY FAIL");
process.exit(ok && !process.exitCode ? 0 : 1);
