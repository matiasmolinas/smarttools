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
import type { ToolCalib } from "./engine.ts";
import { applyDir, compose, inverse, qaxis, qfromM3, type Xf } from "./xform.ts";
import type { V3 } from "./pose.ts";

/** Camera / tool axes in the saddle frame when untilted: z along +X, x along -Y, y along -Z. */
const R_FORWARD = qfromM3([0, 0, 1, -1, 0, 0, 0, -1, 0]);

export interface DockRig {
  tiltDeg: number;
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
}

export function dockRig(o: DockOptions = {}): DockRig {
  const tiltDeg = o.tiltDeg ?? 0;
  const bodyD = o.bodyDiameter ?? DOCK.drill.bodyDiameter;
  const tipX = o.tipX ?? DOCK.drill.tipX;
  const axisZ = -(bodyD / 2) * Math.SQRT2;
  const saddleArm: Xf = { p: [...DOCK.pivot] as V3, q: qaxis([0, 1, 0], (tiltDeg * Math.PI) / 180), s: [1, 1, 1] };
  const armCamera: Xf = { p: [...DOCK.cameraInArm] as V3, q: R_FORWARD, s: [1, 1, 1] };
  const saddleCamera = compose(saddleArm, armCamera);
  const saddleTool: Xf = { p: [tipX, 0, axisZ], q: R_FORWARD, s: [1, 1, 1] };
  const cameraSaddle = inverse(saddleCamera);
  const camTool = compose(cameraSaddle, saddleTool);
  return {
    tiltDeg,
    tool: { tipCam: camTool.p.map((v) => v / 1000) as V3, axisCam: applyDir(camTool, [0, 0, 1]) },
    saddleCamera,
    saddleArm,
    cameraSaddle,
  };
}

/** Angle between the optical axis and the direction to the bit tip (deg), and its sideways part. */
export function tipInView(tool: ToolCalib) {
  const [x, y, z] = tool.tipCam;
  return { downDeg: (Math.atan2(y, z) * 180) / Math.PI, sideDeg: (Math.atan2(x, z) * 180) / Math.PI };
}

export { DOCK };
