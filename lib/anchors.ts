// Markers on the part itself ("anchors"). Two ways to get them:
//  - learned: register the part by touch, stick a few marker stickers on it anywhere, and let the camera
//    see them once while the part is located: where each sticker sits on the part is then known;
//  - factory: the part comes with markers printed, engraved or labelled at known CAD positions; seeing
//    them locates the part, no touching needed.
// Either way the part becomes a moving reference: the engine follows it when it is moved or flipped, it
// can replace the sheet, and a part slipping in the vise while driving is caught (docs/ENGINE_SPEC.md §16).
//
// A body = the markers of one part, in the part's frame. Its markers are grouped in stickers (each one
// planar): the pose is solved on the best sticker, then refined on every visible marker in 3D.

import type { NavCore, SolidSpec, StickerSpec } from "./engine.ts";
import type { Intrinsics, Pose, V3 } from "./pose.ts";
import { applyPoint, compose, fromPose, inverse, qnorm, toPose, xf, type Q, type Xf } from "./xform.ts";

type P = { x: number; y: number };

export interface StickerDef {
  name: string;
  /** part ← sticker (the sticker's plane is its z = 0, markers face +Z) */
  pose: Xf;
  /** marker edge (black square), m */
  size: number;
  markers: { id: number; x: number; y: number }[];
  /** half size of the paper, m */
  half: [number, number];
}
export interface MarkerBody {
  /** the engine node the measurements go to (a calibrated node under the part) */
  name: string;
  stickers: StickerDef[];
}
export interface BodyPose {
  name: string;
  /** T_camera_body as the pose solver returns it (x_cam = R X + t) */
  pose: Pose;
  markers: number;
  stickers: number;
  rmsPx: number;
}

/** A sticker with a grid of markers (row-major ids from `firstId`), centred on its frame. */
export function gridSticker(name: string, pose: Xf, firstId: number, cols: number, rows: number, size: number, gap = size * 0.3): StickerDef {
  const pitch = size + gap;
  const markers: StickerDef["markers"] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) markers.push({ id: firstId + r * cols + c, x: (c - (cols - 1) / 2) * pitch, y: ((rows - 1) / 2 - r) * pitch });
  return { name, pose, size, markers, half: [(cols * pitch + gap) / 2, (rows * pitch + gap) / 2] };
}

/** Corners of a marker in its sticker's plane, in js-aruco2 order (clockwise from top-left). */
function planeCorners(m: { x: number; y: number }, size: number): P[] {
  const h = size / 2;
  return [
    { x: m.x - h, y: m.y + h },
    { x: m.x + h, y: m.y + h },
    { x: m.x + h, y: m.y - h },
    { x: m.x - h, y: m.y - h },
  ];
}

export function bodyIds(bodies: MarkerBody[]): Set<number> {
  return new Set(bodies.flatMap((b) => b.stickers.flatMap((s) => s.markers.map((m) => m.id))));
}

/**
 * Poses of the bodies seen in a frame. `seen`: detected markers with their undistorted corners.
 * Each body: solved on its sticker with the most markers (planar, robust), then refined on all its
 * visible markers in 3D when more than one sticker is seen.
 */
export function solveBodies(core: NavCore, bodies: MarkerBody[], seen: Map<number, P[]>, K: Intrinsics): BodyPose[] {
  const out: BodyPose[] = [];
  for (const b of bodies) {
    const per = b.stickers
      .map((st) => ({ st, ms: st.markers.filter((m) => seen.has(m.id)) }))
      .filter((x) => x.ms.length > 0)
      .sort((a, c) => c.ms.length - a.ms.length);
    if (!per.length) continue;
    const best = per[0];
    // a lone marker gives a poor rotation: need 2 on the best sticker, or 3 in all
    const total = per.reduce((a, x) => a + x.ms.length, 0);
    if (best.ms.length < 2 && total < 3) continue;
    const world = best.ms.flatMap((m) => planeCorners(m, best.st.size));
    const img = best.ms.flatMap((m) => seen.get(m.id)!);
    const sol = core.solvePoseRobust(world, img, K);
    if (!sol || sol.pose.rms > 4) continue;
    let camBody = compose(fromPose(sol.pose), inverse(best.st.pose));
    let rms = sol.pose.rms;
    let used = sol.kept;
    if (per.length > 1) {
      const w3: V3[] = [];
      const i2: P[] = [];
      for (const { st, ms } of per)
        for (const m of ms) {
          planeCorners(m, st.size).forEach((c) => w3.push(applyPoint(st.pose, [c.x, c.y, 0])));
          i2.push(...seen.get(m.id)!);
        }
      const r = core.refinePose3(toPose(camBody), w3, i2, K, 10);
      if (r.rms < 4) {
        camBody = fromPose(r);
        rms = r.rms;
        used = total;
      }
    }
    out.push({ name: b.name, pose: toPose(camBody), markers: used, stickers: per.length, rmsPx: rms });
  }
  return out;
}

// ---------------- learning where stickers are on a located part ----------------

/** Collects views of stickers while the part is located, then fixes each sticker's pose on the part. */
export class StickerLearner {
  private samples = new Map<string, Xf[]>();
  readonly templates: StickerDef[];
  constructor(templates: StickerDef[]) {
    this.templates = templates;
  }

  /** One frame: the camera's world pose (from the engine), the part's world pose, and T_camera_sticker per sticker seen. */
  add(cameraW: Xf, partW: Xf, seen: Map<string, Pose>) {
    for (const [name, p] of seen) {
      const partSticker = compose(inverse(partW), compose(cameraW, fromPose(p)));
      const l = this.samples.get(name) ?? [];
      l.push(partSticker);
      this.samples.set(name, l);
    }
  }
  count(name: string) {
    return this.samples.get(name)?.length ?? 0;
  }
  /** The learned body (stickers seen at least `minViews` times), and the spread of each sticker's position (mm). */
  body(name: string, minViews = 5): { body: MarkerBody; spreadMm: Record<string, number> } {
    const stickers: StickerDef[] = [];
    const spreadMm: Record<string, number> = {};
    for (const t of this.templates) {
      const l = this.samples.get(t.name) ?? [];
      if (l.length < minViews) continue;
      // robust: views farther than 1.5 mm from the median position are outliers (a bad view of a small sticker)
      const med = [0, 1, 2].map((k) => [...l.map((x) => x.p[k])].sort((p, q) => p - q)[Math.floor(l.length / 2)]);
      const d = (x: Xf) => Math.hypot(x.p[0] - med[0], x.p[1] - med[1], x.p[2] - med[2]) * 1000;
      const kept = l.filter((x) => d(x) < 1.5);
      if (kept.length < minViews) continue;
      const mean = averageXf(kept);
      spreadMm[t.name] = Math.max(...kept.map((x) => Math.hypot(x.p[0] - mean.p[0], x.p[1] - mean.p[1], x.p[2] - mean.p[2]) * 1000));
      stickers.push({ ...t, pose: mean });
    }
    return { body: { name, stickers }, spreadMm };
  }
}

/** Mean of rigid transforms (positions averaged, quaternions summed in one hemisphere). */
export function averageXf(l: Xf[]): Xf {
  const p: V3 = [0, 0, 0];
  const q: Q = [0, 0, 0, 0];
  const ref = l[0].q;
  for (const x of l) {
    for (let k = 0; k < 3; k++) p[k] += x.p[k] / l.length;
    const s = x.q[0] * ref[0] + x.q[1] * ref[1] + x.q[2] * ref[2] + x.q[3] * ref[3] < 0 ? -1 : 1;
    for (let k = 0; k < 4; k++) q[k] += s * x.q[k];
  }
  return xf(p, qnorm(q));
}

// ---------------- the simulator's view of parts ----------------

/** The ArUco code of a marker as a number (first cell = most significant bit). */
export const codeOf = (codeList: string[], id: number) => parseInt(codeList[id], 2);

/** Stickers of a body placed on a part at `partW`, for the camera simulator. */
export function stickerSpecs(body: MarkerBody, partW: Xf, codeList: string[]): StickerSpec[] {
  return body.stickers.map((st) => ({
    pose: compose(partW, st.pose),
    half: st.half,
    markers: st.markers.map((m) => ({ x: m.x, y: m.y, size: st.size, code: codeOf(codeList, m.id) })),
  }));
}

/** Half-spaces of an axis-aligned box [min, max]. */
export function boxPlanes(min: V3, max: V3): SolidSpec["planes"] {
  return [
    [1, 0, 0, max[0]],
    [-1, 0, 0, -min[0]],
    [0, 1, 0, max[1]],
    [0, -1, 0, -min[1]],
    [0, 0, 1, max[2]],
    [0, 0, -1, -min[2]],
  ];
}
