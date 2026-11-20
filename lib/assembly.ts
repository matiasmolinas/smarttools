// A 3D assembly job: a robot-arm base built from several parts, screwed together with the drill/driver.
// Not a flat sheet: screws go into faces at different angles, the parts are located by touching known
// points with the bit tip (paired-point registration), and placements are verified by probing.
//
// Frames: the marker sheet lies on the bench (world = sheet frame, Z up). The base part's frame has its
// origin at the bottom-front-left corner, X along its 160 mm side, Y back (110 mm), Z up. Every screw
// hole is a target frame (+Z = driving direction) that is a child of its part, so registering the part
// moves all its holes with it (docs/ENGINE_SPEC.md §4, §9).

import type { NavCore, NavEngine, ToolCalib } from "./engine.ts";
import { smartToolsScene, type NodeDef, type SceneDef, type Visual3D } from "./scenedef.ts";
import { applyPoint, compose, inverse, qaxis, qfromTo, qmul, xf, type Q, type Xf } from "./xform.ts";
import type { V3 } from "./pose.ts";

const MM = 0.001;
const BASE = { x: 0.16, y: 0.11, z: 0.03 };
const TOWER = { x0: 0.055, x1: 0.105, y0: 0.06, y1: 0.11, top: 0.1 };
const CHAMFER = { deg: 35, depthY: 0.03 }; // the front 30 mm of the top slope down at 35°
const chamferRise = CHAMFER.depthY * Math.tan((CHAMFER.deg * Math.PI) / 180); // 21 mm

/** Where the top surface is at depth y (on the chamfer near the front). */
const topZ = (y: number) => (y >= CHAMFER.depthY ? BASE.z : BASE.z - (CHAMFER.depthY - y) * Math.tan((CHAMFER.deg * Math.PI) / 180));

/** Target frame for a hole whose surface normal is `n` (pointing out of the part): +Z into the part. */
function holeFrame(p: V3, n: V3): Xf {
  return xf(p, qfromTo([0, 0, 1], [-n[0], -n[1], -n[2]]));
}
const UP: V3 = [0, 0, 1];
const CHAMFER_N: V3 = [0, -Math.sin((CHAMFER.deg * Math.PI) / 180), Math.cos((CHAMFER.deg * Math.PI) / 180)];

export interface ScrewSpec {
  name: string;
  part: "base" | "bracket";
  frame: Xf;
  /** seating depth from the surface, mm */
  depthMm: number;
  size: string;
  face: string;
}

/** Screws in the order the job drives them (cross pattern on the top, then the chamfer, then the bracket). */
export const SCREWS: ScrewSpec[] = [
  { name: "S1", part: "base", frame: holeFrame([0.022, 0.05, BASE.z], UP), depthMm: 14, size: "M5×16", face: "top" },
  { name: "S2", part: "base", frame: holeFrame([0.138, 0.095, BASE.z], UP), depthMm: 14, size: "M5×16", face: "top" },
  { name: "S3", part: "base", frame: holeFrame([0.138, 0.05, BASE.z], UP), depthMm: 14, size: "M5×16", face: "top" },
  { name: "S4", part: "base", frame: holeFrame([0.022, 0.095, BASE.z], UP), depthMm: 14, size: "M5×16", face: "top" },
  { name: "C1", part: "base", frame: holeFrame([0.045, CHAMFER.depthY / 2, topZ(CHAMFER.depthY / 2)], CHAMFER_N), depthMm: 10, size: "M4×12", face: "35° chamfer" },
  { name: "C2", part: "base", frame: holeFrame([0.115, CHAMFER.depthY / 2, topZ(CHAMFER.depthY / 2)], CHAMFER_N), depthMm: 10, size: "M4×12", face: "35° chamfer" },
  // bracket holes, in the bracket's frame (origin at the centre of its top face)
  { name: "B1", part: "bracket", frame: holeFrame([-0.016, -0.016, 0], UP), depthMm: 12, size: "M4×16", face: "bracket" },
  { name: "B2", part: "bracket", frame: holeFrame([0.016, 0.016, 0], UP), depthMm: 12, size: "M4×16", face: "bracket" },
  { name: "B3", part: "bracket", frame: holeFrame([0.016, -0.016, 0], UP), depthMm: 12, size: "M4×16", face: "bracket" },
  { name: "B4", part: "bracket", frame: holeFrame([-0.016, 0.016, 0], UP), depthMm: 12, size: "M4×16", face: "bracket" },
];

/** Registration dimples on the base (part frame): spread in 3D, one on the tower. */
export const FIDUCIALS: { name: string; p: V3 }[] = [
  { name: "F1", p: [0.006, 0.04, BASE.z] },
  { name: "F2", p: [0.154, 0.04, BASE.z] },
  { name: "F3", p: [0.154, 0.104, BASE.z] },
  { name: "F4", p: [0.08, 0.085, TOWER.top] },
];
/** Points to verify the registration with (not used to compute it): on the chamfer and the tower side. */
export const CHECKPOINTS: { name: string; p: V3 }[] = [
  { name: "K1", p: [0.08, CHAMFER.depthY / 2, topZ(CHAMFER.depthY / 2)] },
  { name: "K2", p: [TOWER.x1, 0.085, 0.07] },
];
/** Bracket probe points (bracket frame). */
export const BRACKET_POINTS: { name: string; p: V3 }[] = [
  { name: "P1", p: [-0.03, -0.03, 0] },
  { name: "P2", p: [0.03, -0.03, 0] },
  { name: "P3", p: [0.03, 0.03, 0] },
];
/** Where the bracket is designed to sit, in the base frame: centred on the tower top. */
export const BRACKET_MOUNT: Xf = xf([(TOWER.x0 + TOWER.x1) / 2, (TOWER.y0 + TOWER.y1) / 2 - 0.005, TOWER.top + 0.006]);

/** The base on the bench beside the marker sheet, its long side along the sheet and its chamfer facing
 * away from it, so that the camera behind the bit keeps the sheet in view on every face. This is the
 * true pose; the engine finds it by registration. */
export const BASE_ON_BENCH: Xf = xf([0.232, -0.082, 0], qaxis([0, 0, 1], (96 * Math.PI) / 180));
/** Where the CAD places the base before registering (a rough guess: ~2 cm and 7° off). */
export const BASE_NOMINAL: Xf = xf([0.25, -0.07, 0], qaxis([0, 0, 1], (89 * Math.PI) / 180));

const C = { metal: "#9fb3c8", dark: "#1f2a36", cyan: "#5ad8ff", amber: "#ffb547", green: "#3dffa8", white: "#e8eef5" };
const alu = (opacity = 0.92) => ({ color: C.metal, metalness: 0.55, roughness: 0.45, opacity, edges: true });

function baseVisuals(): Visual3D[] {
  const a = (CHAMFER.deg * Math.PI) / 180;
  const slope = CHAMFER.depthY / Math.cos(a);
  return [
    // main block behind the chamfer
    { kind: "box", size: [BASE.x, BASE.y - CHAMFER.depthY, BASE.z], offset: { p: [BASE.x / 2, CHAMFER.depthY + (BASE.y - CHAMFER.depthY) / 2, BASE.z / 2] }, material: alu() },
    // front: lower block + the 35° slope
    { kind: "box", size: [BASE.x, CHAMFER.depthY, BASE.z - chamferRise], offset: { p: [BASE.x / 2, CHAMFER.depthY / 2, (BASE.z - chamferRise) / 2] }, material: alu() },
    {
      kind: "box",
      size: [BASE.x, slope, 0.003],
      offset: { p: [BASE.x / 2, CHAMFER.depthY / 2, BASE.z - chamferRise / 2 - 0.0015], q: qaxis([1, 0, 0], a) },
      material: alu(),
    },
    // the tower
    { kind: "box", size: [TOWER.x1 - TOWER.x0, TOWER.y1 - TOWER.y0, TOWER.top - BASE.z], offset: { p: [(TOWER.x0 + TOWER.x1) / 2, (TOWER.y0 + TOWER.y1) / 2, (BASE.z + TOWER.top) / 2] }, material: alu() },
  ];
}

const dimple = (color: string): Visual3D[] => [
  { kind: "sphere", radius: 0.0022, material: { color, emissive: color, opacity: 0.9 } },
];

/** A hole: the planned screw as a translucent shaft along +Z, and the screw head (shown when driven). */
function holeVisuals(depthMm: number, color = C.cyan): Visual3D[] {
  const d = depthMm * MM;
  return [{ kind: "cylinder", radius: 0.0021, length: d, axis: "z", offset: { p: [0, 0, d / 2] }, material: { color, opacity: 0.35 } }];
}
const screwVisuals = (depthMm: number): Visual3D[] => [
  { kind: "cylinder", radius: 0.0045, length: 0.003, axis: "z", offset: { p: [0, 0, -0.0015] }, material: { color: C.green, metalness: 0.7, roughness: 0.3, emissive: "#0b3d27" } },
  { kind: "cylinder", radius: 0.0022, length: depthMm * MM, axis: "z", offset: { p: [0, 0, (depthMm * MM) / 2] }, material: { color: C.green, metalness: 0.7, roughness: 0.3 } },
];

export interface AssemblyOptions {
  tool: ToolCalib;
  /** the base part's pose in the engine before registration (default: the CAD guess) */
  basePose?: Xf;
  /** the bracket's pose relative to the base (default: as designed) */
  bracketPose?: Xf;
  phone?: string;
}

/**
 * The robot-arm-base job: the marker sheet on the bench, the base part (registered by touching
 * F1-F4), its screw holes on the top and on the 35° chamfer, the bracket on the tower with its own
 * holes, and the docked phone on the drill/driver. Screws S1-S4, C1-C2, B1-B4 are the targets.
 */
export function assemblyScene(o: AssemblyOptions): SceneDef {
  const base = smartToolsScene({ tool: o.tool, bit: "driver", phone: o.phone });
  // keep the sheet, camera, dock and tool; drop the A1-A3 holes of the flat job
  const keep = base.nodes.filter((n) => !["A1", "A2", "A3"].includes(n.name));
  const nodes: NodeDef[] = [...keep.filter((n) => n.name === "sheet")];
  const local = (t: Xf) => ({ p: t.p, q: t.q as Q });
  nodes.push({ name: "base", kind: "calibrated", local: local(o.basePose ?? BASE_NOMINAL), visual3d: baseVisuals(), meta: { part: "robot-arm base", material: "aluminium" } });
  for (const f of FIDUCIALS) nodes.push({ name: f.name, parent: "base", kind: "display", local: { p: f.p }, visual3d: dimple(C.amber), visual2d: [{ kind: "dot", radius: 0.002, color: C.amber }, { kind: "label", text: f.name, color: C.amber }] });
  for (const k of CHECKPOINTS) nodes.push({ name: k.name, parent: "base", kind: "display", local: { p: k.p }, visual3d: dimple(C.white), visual2d: [{ kind: "dot", radius: 0.002, color: C.white }] });
  nodes.push({
    name: "bracket",
    parent: "base",
    kind: "calibrated",
    local: local(o.bracketPose ?? BRACKET_MOUNT),
    visual3d: [
      { kind: "box", size: [0.07, 0.07, 0.006], offset: { p: [0, 0, -0.003] }, material: { color: "#c7d3df", metalness: 0.6, roughness: 0.35, opacity: 0.95, edges: true } },
      { kind: "box", size: [0.07, 0.006, 0.05], offset: { p: [0, 0.032, 0.025] }, material: { color: "#c7d3df", metalness: 0.6, roughness: 0.35, opacity: 0.95, edges: true } },
    ],
    meta: { part: "L-bracket" },
  });
  for (const b of BRACKET_POINTS) nodes.push({ name: b.name, parent: "bracket", kind: "display", local: { p: b.p }, visual3d: dimple(C.white) });
  for (const s of SCREWS) {
    nodes.push({
      name: s.name,
      parent: s.part,
      kind: "planned",
      local: local(s.frame),
      visual3d: holeVisuals(s.depthMm),
      visual2d: [{ kind: "crosshair", size: 0.004, label: s.name }],
      meta: { depthMm: s.depthMm, size: s.size, face: s.face },
    });
    nodes.push({ name: `${s.name}-screw`, parent: s.name, kind: "display", visual3d: screwVisuals(s.depthMm) });
  }
  nodes.push(...keep.filter((n) => n.name !== "sheet"));
  // the hex bit on its own node, so a camera view can hide the drill body but still show the bit
  nodes.push({
    name: "bit",
    parent: "tool",
    kind: "display",
    visual3d: [
      { kind: "cylinder", radius: 0.0032, length: 0.045, axis: "z", offset: { p: [0, 0, -0.0225] }, material: { color: "#d8e2ec", metalness: 0.95, roughness: 0.25 } },
      { kind: "cylinder", radius: 0.0055, length: 0.065, axis: "z", offset: { p: [0, 0, -0.0775] }, material: { color: "#9aa6b2", metalness: 0.9, roughness: 0.3 } },
    ],
  });
  return { name: "robot-arm-base", nodes, navigation: { tool: "tool", targets: SCREWS.map((s) => s.name), tracked: "camera", reference: "sheet" } };
}

/** Depths per target, in the scene's navigation order. */
export const SCREW_DEPTHS = SCREWS.map((s) => s.depthMm);

// ---------------- registration and probing with the bit tip ----------------

/** World transform of a part's point. */
export const worldPoint = (partW: Xf, p: V3): V3 => applyPoint(partW, p);

/**
 * Register a part from tip touches: model points (part frame) and where the tip touched them (world).
 * Updates the engine node's pose (relative to its parent) and marks it calibrated. Returns the
 * registration error (FRE) and the new world pose.
 */
export function registerPart(core: NavCore, engine: NavEngine, partId: number, parentW: Xf, model: V3[], touchedWorld: V3[]) {
  const r = core.registerPoints(model, touchedWorld);
  if (!r) return null;
  engine.setLocal(partId, compose(inverse(parentW), r.transform));
  engine.setCalibrated(partId, true);
  return { world: r.transform, freMm: r.freMm, maxMm: r.maxMm };
}

/** Distance (mm) between where the tip is and where a part's point should be: a probe check. */
export function probeError(partW: Xf, model: V3, tipWorld: V3): number {
  const e = applyPoint(partW, model);
  return Math.hypot(e[0] - tipWorld[0], e[1] - tipWorld[1], e[2] - tipWorld[2]) * 1000;
}

/** A tool pose with its tip at `tip`, its bit along `axis` and the camera on the `cameraToward` side.
 * In practice: turn the drill about its bit so the camera faces the marker sheet. */
export function toolAt(tip: V3, axis: V3, cameraToward: V3 = [-1, 0, 0]): Xf {
  const q0 = qfromTo([0, 0, 1], axis);
  // the camera sits on the tool's -Y side: turn about the bit so that -Y points as close as possible to cameraToward
  const y = applyPoint(xf([0, 0, 0], q0), [0, -1, 0]);
  const z = axis;
  const d = [cameraToward[0], cameraToward[1], cameraToward[2]] as V3;
  const dz = d[0] * z[0] + d[1] * z[1] + d[2] * z[2];
  const want = [d[0] - dz * z[0], d[1] - dz * z[1], d[2] - dz * z[2]] as V3;
  const angle = Math.atan2(
    z[0] * (y[1] * want[2] - y[2] * want[1]) + z[1] * (y[2] * want[0] - y[0] * want[2]) + z[2] * (y[0] * want[1] - y[1] * want[0]),
    y[0] * want[0] + y[1] * want[1] + y[2] * want[2],
  );
  return xf(tip, qmul(qaxis(z, angle), q0));
}
