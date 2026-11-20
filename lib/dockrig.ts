// The dock's geometry as transforms, from hardware/dock/dock.py (lib/dockgeom.ts is generated there).
// One source of truth: the scene simulator, the 3D view and the end-to-end tests all place the camera,
// the bit and the dock parts from it.
//
// Frames (mm):
// - saddle S: X toward the bit, Y lateral, Z up (the dock.py frame);
// - arm A: the saddle frame rotated by the tilt about the pivot;
// - camera C (OpenCV): x right, y down, z forward;
// - tool T: origin at the bit tip, +Z along the bit (drilling direction).

import { DOCK } from "./dockgeom.ts";
import { phoneById, type PhoneProfile } from "./phones.ts";
import type { ToolCalib } from "./engine.ts";
import { applyDir, compose, inverse, qaxis, qfromM3, type Xf } from "./xform.ts";
import type { V3 } from "./pose.ts";

/** Camera / tool axes in the saddle frame when untilted: z along +X, x along -Y, y along -Z. */
const R_FORWARD = qfromM3([0, 0, 1, -1, 0, 0, 0, -1, 0]);

export interface DockRig {
  tiltDeg: number;
  phone: PhoneProfile | null;
  /** phone box (centre, mm, arm frame) and size [thickness, length, width] for drawing it */
  phoneCentreInArm: V3;
  phoneSize: V3;
  slidingJawInArm: V3;
  /** the bit relative to the camera (what the dock calibration measures), metres */
  tool: ToolCalib;
  /** T_saddle_camera and T_saddle_arm, mm */
  saddleCamera: Xf;
  saddleArm: Xf;
  /** T_camera_saddle, for placing the dock in the camera's frame (mm) */
  cameraSaddle: Xf;
}

export interface DockOptions {
  /** camera tilt on the hinge, degrees (positive = looks further down) */
  tiltDeg?: number;
  /** drill: motor body diameter and saddle-centre-to-tip distance, mm */
  bodyDiameter?: number;
  tipX?: number;
  /** the phone in the dock (default: the reference the dock was designed for) */
  phone?: PhoneProfile | string;
}

export function dockRig(o: DockOptions = {}): DockRig {
  const tiltDeg = o.tiltDeg ?? 0;
  const bodyD = o.bodyDiameter ?? DOCK.drill.bodyDiameter;
  const tipX = o.tipX ?? DOCK.drill.tipX;
  const axisZ = -(bodyD / 2) * Math.SQRT2;
  const saddleArm: Xf = { p: [...DOCK.pivot] as V3, q: qaxis([0, 1, 0], (tiltDeg * Math.PI) / 180), s: [1, 1, 1] };
  // the camera in the arm frame: lens at the fixed-jaw end, on the bottom edge (see lib/phones.ts)
  const phone = o.phone === undefined ? null : typeof o.phone === "string" ? phoneById(o.phone) : o.phone;
  const r = DOCK.rail;
  const len = phone?.length ?? DOCK.phone.length;
  const width = phone?.width ?? DOCK.phone.height;
  const thick = phone?.thickness ?? DOCK.phone.thickness;
  const camInArm: V3 = phone
    ? [r.chX + thick / 2 + r.camProtrude, r.fixFace + phone.camFromTop, r.baseZ1 + phone.camFromLeft]
    : ([...DOCK.cameraInArm] as V3);
  const armCamera: Xf = { p: camInArm, q: R_FORWARD, s: [1, 1, 1] };
  const saddleCamera = compose(saddleArm, armCamera);
  const saddleTool: Xf = { p: [tipX, 0, axisZ], q: R_FORWARD, s: [1, 1, 1] };
  const cameraSaddle = inverse(saddleCamera);
  const camTool = compose(cameraSaddle, saddleTool);
  return {
    tiltDeg,
    phone,
    phoneCentreInArm: [r.chX, r.fixFace + len / 2, r.baseZ1 + width / 2],
    phoneSize: [thick, len, width],
    slidingJawInArm: [0, r.fixFace + len, 0],
    tool: { tipCam: camTool.p.map((v) => v / 1000) as V3, axisCam: applyDir(camTool, [0, 0, 1]) },
    saddleCamera,
    saddleArm,
    cameraSaddle,
  };
}

/** The dock calibration this phone should produce at some tilt within the dock's range, and how far a
 * measured calibration is from it (mm): a sanity check after "Calibrate". */
export function checkCalibration(tool: ToolCalib, o: DockOptions = {}) {
  let best = { distanceMm: Infinity, tiltDeg: 0 };
  for (let t = DOCK.tiltRange[0]; t <= DOCK.tiltRange[1] + 1e-9; t += 0.5) {
    const e = dockRig({ ...o, tiltDeg: t }).tool.tipCam;
    const d = Math.hypot(e[0] - tool.tipCam[0], e[1] - tool.tipCam[1], e[2] - tool.tipCam[2]) * 1000;
    if (d < best.distanceMm) best = { distanceMm: d, tiltDeg: t };
  }
  return best;
}

/** Angle between the optical axis and the direction to the bit tip (deg), and its sideways part. */
export function tipInView(tool: ToolCalib) {
  const [x, y, z] = tool.tipCam;
  return { downDeg: (Math.atan2(y, z) * 180) / Math.PI, sideDeg: (Math.atan2(x, z) * 180) / Math.PI };
}

export { DOCK };
export type { PhoneProfile };
