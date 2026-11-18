// Synthetic end-to-end check: render the A4 marker sheet with a known camera pose,
// detect markers with js-aruco2, solve the pose and compare with ground truth.
// Run: node scripts/pose-selftest.mts
import { createRequire } from "node:module";
import { refineCorners } from "../lib/subpix.ts";
import { BOARD_MARKERS, MARKER_SIZE, markerCorners } from "../lib/board.ts";
import { homography, poseFromHomography, refinePose, toWorld, dirToWorld, focalFromHomography, type M3, type V3 } from "../lib/pose.ts";

const require = createRequire(import.meta.url);
const { AR } = require("js-aruco2");
const dict = new AR.Dictionary("ARUCO_MIP_36h12");

const W = 1280, H = 720;
const K = { f: 1000, cx: W / 2, cy: H / 2 };

function rot(rx: number, ry: number, rz: number): M3 {
  const [a, b, c] = [rx, ry, rz].map((d) => (d * Math.PI) / 180);
  const Rx = [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
  const Ry = [Math.cos(b), 0, Math.sin(b), 0, 1, 0, -Math.sin(b), 0, Math.cos(b)];
  const Rz = [Math.cos(c), -Math.sin(c), 0, Math.sin(c), Math.cos(c), 0, 0, 0, 1];
  const m = (A: number[], B: number[]) => { const o = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i*3+j] += A[i*3+k]*B[k*3+j]; return o; };
  return m(m(Rz, Ry), Rx) as M3;
}

function sheetValue(X: number, Y: number): number {
  for (const mk of BOARD_MARKERS) {
    const h = MARKER_SIZE / 2;
    if (X >= mk.x - h && X < mk.x + h && Y > mk.y - h && Y <= mk.y + h) {
      const cell = MARKER_SIZE / 8;
      const col = Math.floor((X - (mk.x - h)) / cell);
      const row = Math.floor((mk.y + h - Y) / cell);
      if (col >= 1 && col <= 6 && row >= 1 && row <= 6) return dict.codeList[mk.id][(row - 1) * 6 + (col - 1)] === "1" ? 235 : 20;
      return 20;
    }
  }
  return Math.abs(X) < 0.105 && Math.abs(Y) < 0.1485 ? 235 : 90; // paper vs. wall
}

function render(R: M3, t: V3) {
  const data = new Uint8ClampedArray(W * H * 4);
  // camera centre and inverse rotation
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const C = [-(Rt[0]*t[0]+Rt[1]*t[1]+Rt[2]*t[2]), -(Rt[3]*t[0]+Rt[4]*t[1]+Rt[5]*t[2]), -(Rt[6]*t[0]+Rt[7]*t[1]+Rt[8]*t[2])];
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    let acc = 0;
    for (const [du, dv] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const d = [(u + du - K.cx) / K.f, (v + dv - K.cy) / K.f, 1];
      const dw = [Rt[0]*d[0]+Rt[1]*d[1]+Rt[2]*d[2], Rt[3]*d[0]+Rt[4]*d[1]+Rt[5]*d[2], Rt[6]*d[0]+Rt[7]*d[1]+Rt[8]*d[2]];
      const s = -C[2] / dw[2];
      acc += s > 0 ? sheetValue(C[0] + s * dw[0], C[1] + s * dw[1]) : 90;
    }
    const i = (v * W + u) * 4;
    data[i] = data[i + 1] = data[i + 2] = acc / 4;
    data[i + 3] = 255;
  }
  return data;
}

// world->camera: camera looks along -Z_world. Base rotation maps world (X right, Y up, Z out) to cam (x right, y down, z forward).
const BASE: M3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
const cases = [
  { name: "frontal 30 cm", tilt: [0, 0, 0], C: [0, 0, 0.3] },
  { name: "tilt 12°/-8° 25 cm", tilt: [12, -8, 3], C: [0.02, -0.03, 0.25] },
  { name: "tilt 25°/15° 35 cm", tilt: [25, 15, -10], C: [-0.03, 0.04, 0.35] },
];
let worst = 0;
for (const c of cases) {
  const Rd = rot(c.tilt[0], c.tilt[1], c.tilt[2]);
  const m = (A: number[], B: number[]) => { const o = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i*3+j] += A[i*3+k]*B[k*3+j]; return o as M3; };
  const R = m(Rd, BASE);
  const t: V3 = [-(R[0]*c.C[0]+R[1]*c.C[1]+R[2]*c.C[2]), -(R[3]*c.C[0]+R[4]*c.C[1]+R[5]*c.C[2]), -(R[6]*c.C[0]+R[7]*c.C[1]+R[8]*c.C[2])];
  const img = render(R, t);
  const det = new AR.Detector({ dictionaryName: "ARUCO_MIP_36h12" });
  const found = det.detect({ width: W, height: H, data: img });
  const world: { x: number; y: number }[] = [];
  const pix: { x: number; y: number }[] = [];
  for (const mk of found) {
    const wc = markerCorners(mk.id);
    if (!wc) continue;
    const rc = refineCorners({ width: W, height: H, data: img }, mk.corners);
    for (let i = 0; i < 4; i++) { world.push(wc[i]); pix.push(rc[i]); }
  }
  const Hm = homography(world, pix);
  const pose0 = Hm && poseFromHomography(Hm, K);
  const pose = pose0 && refinePose(pose0, world, pix, K);
  if (!pose) { console.log(c.name, "FAILED: markers", found.map((f: { id: number }) => f.id)); worst = 99; continue; }
  const camW = toWorld(pose, [0, 0, 0]);
  const axW = dirToWorld(pose, [0, 0, 1]);
  const axTrue = dirToWorld({ R, t, rms: 0 }, [0, 0, 1]);
  const posErr = Math.hypot(camW[0] - c.C[0], camW[1] - c.C[1], camW[2] - c.C[2]) * 1000;
  const angErr = (Math.acos(Math.min(1, axW[0]*axTrue[0] + axW[1]*axTrue[1] + axW[2]*axTrue[2])) * 180) / Math.PI;
  const f = Hm && focalFromHomography(Hm, K.cx, K.cy);
  console.log(`${c.name.padEnd(20)} markers ${found.length}  pos err ${posErr.toFixed(2)} mm  axis err ${angErr.toFixed(3)}°  f est ${f ? f.toFixed(0) : "n/a"}  rms ${pose.rms.toFixed(2)} px`);
  worst = Math.max(worst, angErr > 0.1 ? 99 : 0, posErr > 1 ? 99 : 0);
}
if (worst) { console.log("FAIL"); process.exit(1); }
console.log("PASS");
