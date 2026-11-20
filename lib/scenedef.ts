// Scene definitions: what exists in a job, separate from how it is drawn.
//
// A SceneDef lists nodes (a tree of coordinate frames, see docs/ENGINE_SPEC.md §4) and, for each
// node, optional visual representations:
// - visual3d: for a 3D scene (primitives or meshes such as STL, with surface properties);
// - visual2d: for a 2D plan / HUD (simplified symbols: a crosshair for a hole, rings for the drill).
// The engine only receives the structure (buildEngine); renderers only read the visuals and the
// engine's snapshots. Navigation works with no renderer at all.

import { BOARD_MARKERS, BOARD_TARGETS, MARKER_SIZE, SHEET } from "./board.ts";
import type { NavEngine, NodeKindName, ToolCalib } from "./engine.ts";
import { NODE_KINDS } from "./engine.ts";
import { QI, qaxis, qfromTo, qmul, type Q, type Xf } from "./xform.ts";
import type { V3 } from "./pose.ts";

export interface XfDef {
  p?: V3;
  q?: Q;
  s?: V3;
}

export interface Material {
  color: string;
  opacity?: number;
  metalness?: number;
  roughness?: number;
  emissive?: string;
  wireframe?: boolean;
  /** draw edges as lines on top (the line style of the landing page) */
  edges?: boolean;
}

/** 3D representation, in the node frame (plus an optional offset, which may scale). */
export type Visual3D =
  | { kind: "box"; size: V3; material: Material; offset?: XfDef }
  | { kind: "cylinder"; radius: number; length: number; axis?: "x" | "y" | "z"; material: Material; offset?: XfDef }
  | { kind: "sphere"; radius: number; material: Material; offset?: XfDef }
  | { kind: "plane"; size: [number, number]; material: Material; offset?: XfDef }
  | { kind: "mesh"; url: string; format: "stl"; material: Material; offset?: XfDef }
  | { kind: "markerSheet"; offset?: XfDef }
  | { kind: "axes"; length: number; offset?: XfDef }
  | { kind: "line"; points: V3[]; material: Material; dashed?: boolean; offset?: XfDef };

/** 2D representation, drawn in a plane view (see lib/render/render2d.ts). Sizes in metres. */
export type Visual2D =
  | { kind: "crosshair"; size: number; color?: string; label?: string }
  | { kind: "rings"; tipRadius: number; chuckRadius: number; chuckOffset: number; color?: string }
  | { kind: "markerSheet" }
  | { kind: "dot"; radius: number; color?: string }
  | { kind: "label"; text: string; color?: string }
  | { kind: "rect"; size: [number, number]; color?: string };

export interface NodeDef {
  name: string;
  /** parent node name; omitted = the world root */
  parent?: string;
  kind: NodeKindName;
  local?: XfDef;
  visual3d?: Visual3D[];
  visual2d?: Visual2D[];
  /** free-form metadata for tools, plans and UIs */
  meta?: Record<string, string | number | boolean>;
}

export interface SceneDef {
  name: string;
  nodes: NodeDef[];
  navigation: { tool: string; targets: string[]; tracked: string; reference: string };
}

export const toXf = (d?: XfDef): Xf => ({ p: d?.p ?? [0, 0, 0], q: d?.q ?? QI, s: d?.s ?? [1, 1, 1] });

/** Problems with a scene definition (empty = valid). */
export function validateScene(def: SceneDef): string[] {
  const errs: string[] = [];
  const names = new Set<string>();
  const kinds = new Map<string, NodeKindName>();
  for (const n of def.nodes) {
    if (!n.name || n.name === "world") errs.push(`invalid node name "${n.name}"`);
    if (names.has(n.name)) errs.push(`duplicate node "${n.name}"`);
    if (n.parent && !names.has(n.parent)) errs.push(`"${n.name}": parent "${n.parent}" must be defined before it`);
    if (!NODE_KINDS.includes(n.kind)) errs.push(`"${n.name}": unknown kind "${n.kind}"`);
    const s = n.local?.s;
    if (s && n.kind !== "display" && s.some((v) => Math.abs(v - 1) > 1e-12)) errs.push(`"${n.name}": scale is only allowed on display nodes`);
    const q = n.local?.q;
    if (q && Math.abs(Math.hypot(...q) - 1) > 1e-6) errs.push(`"${n.name}": orientation is not a unit quaternion`);
    for (const v of n.visual3d ?? []) {
      if (v.kind === "mesh" && !/\.stl$/i.test(v.url)) errs.push(`"${n.name}": only STL meshes are supported (${v.url})`);
      if ((v.kind === "box" && v.size.some((x) => !(x > 0))) || ((v.kind === "cylinder" || v.kind === "sphere") && !(v.radius > 0)))
        errs.push(`"${n.name}": ${v.kind} needs positive dimensions`);
    }
    names.add(n.name);
    kinds.set(n.name, n.kind);
  }
  const nav = def.navigation;
  if (!kinds.has(nav.tool)) errs.push(`navigation tool "${nav.tool}" is not a node`);
  if (kinds.get(nav.tracked) !== "tracked") errs.push(`navigation tracked node "${nav.tracked}" must be of kind "tracked"`);
  if (!kinds.has(nav.reference)) errs.push(`navigation reference "${nav.reference}" is not a node`);
  if (!nav.targets.length) errs.push("navigation needs at least one target");
  for (const t of nav.targets) if (kinds.get(t) !== "planned") errs.push(`target "${t}" must be a planned node`);
  // the tool must hang from the tracked node
  const parentOf = new Map(def.nodes.map((n) => [n.name, n.parent]));
  let p: string | undefined = nav.tool;
  while (p && p !== nav.tracked) p = parentOf.get(p);
  if (p !== nav.tracked) errs.push(`tool "${nav.tool}" must be below the tracked node "${nav.tracked}"`);
  return errs;
}

export interface BuiltScene {
  engine: NavEngine;
  ids: Record<string, number>;
  names: Record<number, string>;
  def: SceneDef;
}

/** Create the engine nodes for a scene (structure only: visuals stay in the definition). */
export function buildEngine(engine: NavEngine, def: SceneDef): BuiltScene {
  const errs = validateScene(def);
  if (errs.length) throw new Error(`invalid scene "${def.name}": ${errs.join("; ")}`);
  const ids: Record<string, number> = { world: 0 };
  for (const n of def.nodes) ids[n.name] = engine.addNode(n.name, n.parent ? ids[n.parent] : 0, n.kind, toXf(n.local));
  engine.setNavigation(ids[def.navigation.tool], def.navigation.targets.map((t) => ids[t]));
  const names: Record<number, string> = {};
  for (const [k, v] of Object.entries(ids)) names[v] = k;
  return { engine, ids, names, def };
}

/** The dock calibration as the tool's local transform in the camera frame. The rotation is the
 * smallest one taking +Z to the measured bit axis (the roll about the bit is irrelevant to drilling). */
export function toolLocal(tool: ToolCalib): Xf {
  return { p: [...tool.tipCam] as V3, q: qfromTo([0, 0, 1], tool.axisCam), s: [1, 1, 1] };
}

/** Square hole into the sheet: target +Z = -sheet normal (180° about X). */
export const INTO_SHEET: Q = [0, 1, 0, 0];

const DRILL = { bitLength: 0.11, bitRadius: 0.003 };
const C = { tool: "#ffb547", cyan: "#5ad8ff", green: "#3dffa8", white: "#e8eef5", steel: "#9aa6b2", body: "#1f2a36" };

/**
 * The SmartTools job: the A4 marker sheet v2 with holes A1-A3, the phone camera (tracked) and the
 * drill on the dock (calibrated). `tool` is the dock calibration; `angledTargetDeg` optionally adds
 * a fourth target "B1" tilted about the sheet's Y axis (an angled hole) for tests and demos.
 */
export function smartToolsScene(opts: { tool: ToolCalib; angledTargetDeg?: number }): SceneDef {
  const nodes: NodeDef[] = [
    {
      name: "sheet",
      kind: "reference",
      visual3d: [{ kind: "markerSheet" }],
      visual2d: [{ kind: "markerSheet" }],
      meta: { width: SHEET.w, height: SHEET.h, markers: BOARD_MARKERS.length, markerSize: MARKER_SIZE },
    },
    ...BOARD_TARGETS.map(
      (t): NodeDef => ({
        name: t.label,
        parent: "sheet",
        kind: "planned",
        local: { p: [t.x, t.y, 0], q: INTO_SHEET },
        visual3d: [
          // the planned hole: 35 mm along +Z (into the material)
          { kind: "cylinder", radius: 0.003, length: 0.035, axis: "z", offset: { p: [0, 0, 0.0175] }, material: { color: C.cyan, opacity: 0.35 } },
          { kind: "line", points: [[-0.006, 0, 0], [0.006, 0, 0]], material: { color: C.white } },
          { kind: "line", points: [[0, -0.006, 0], [0, 0.006, 0]], material: { color: C.white } },
        ],
        visual2d: [{ kind: "crosshair", size: 0.006, label: t.label }],
        meta: { depthMm: 35, diameterMm: 6 },
      }),
    ),
  ];
  const targets = BOARD_TARGETS.map((t) => t.label);
  if (opts.angledTargetDeg) {
    const q = qmul(qaxis([0, 1, 0], (opts.angledTargetDeg * Math.PI) / 180), INTO_SHEET);
    nodes.push({
      name: "B1",
      parent: "sheet",
      kind: "planned",
      local: { p: [0.04, -0.06, 0], q },
      visual3d: [{ kind: "cylinder", radius: 0.003, length: 0.035, axis: "z", offset: { p: [0, 0, 0.0175] }, material: { color: C.green, opacity: 0.35 } }],
      visual2d: [{ kind: "crosshair", size: 0.006, label: `B1 ${opts.angledTargetDeg}°` }],
      meta: { depthMm: 35, angledDeg: opts.angledTargetDeg },
    });
    targets.push("B1");
  }
  nodes.push(
    {
      name: "camera",
      kind: "tracked",
      // the phone around the camera (camera frame: x right, y down, z forward)
      visual3d: [
        { kind: "box", size: [0.165, 0.077, 0.009], offset: { p: [0.06, 0.02, -0.006] }, material: { color: "#0b0f14", edges: true } },
        { kind: "cylinder", radius: 0.006, length: 0.004, axis: "z", material: { color: C.cyan, metalness: 0.6 } },
      ],
      visual2d: [{ kind: "dot", radius: 0.003, color: C.cyan }],
    },
    {
      // the 3D-printed dock (hardware/dock), display only: STL in millimetres
      name: "dock",
      parent: "camera",
      kind: "display",
      // dock frame (X toward the bit, Y lateral, Z up) -> camera frame (x right, y down, z forward)
      local: { p: [0.06, 0.072, 0.018], q: qfromM([0, -1, 0, 0, 0, -1, 1, 0, 0]), s: [0.001, 0.001, 0.001] },
      visual3d: [{ kind: "mesh", url: "/models/dock-arm.stl", format: "stl", material: { color: C.tool, opacity: 0.85, roughness: 0.7 } }],
    },
    {
      name: "dock-saddle",
      parent: "dock",
      kind: "display",
      local: { p: [0, 0, -32] },
      visual3d: [{ kind: "mesh", url: "/models/dock-saddle.stl", format: "stl", material: { color: C.tool, opacity: 0.85, roughness: 0.7 } }],
    },
    {
      // the drill: origin at the bit tip, +Z = drilling direction
      name: "tool",
      parent: "camera",
      kind: "calibrated",
      local: toolLocal(opts.tool),
      visual3d: [
        { kind: "cylinder", radius: DRILL.bitRadius, length: DRILL.bitLength, axis: "z", offset: { p: [0, 0, -DRILL.bitLength / 2] }, material: { color: C.steel, metalness: 0.9, roughness: 0.3 } },
        { kind: "cylinder", radius: 0.018, length: 0.04, axis: "z", offset: { p: [0, 0, -DRILL.bitLength - 0.02] }, material: { color: C.steel, metalness: 0.7, roughness: 0.4, edges: true } },
        { kind: "cylinder", radius: 0.027, length: 0.13, axis: "z", offset: { p: [0, 0, -DRILL.bitLength - 0.105] }, material: { color: C.body, edges: true } },
        { kind: "box", size: [0.034, 0.13, 0.045], offset: { p: [0, 0.085, -DRILL.bitLength - 0.13] }, material: { color: C.body, edges: true } },
        { kind: "box", size: [0.07, 0.03, 0.1], offset: { p: [0, 0.16, -DRILL.bitLength - 0.12] }, material: { color: "#2b3947", edges: true } },
      ],
      visual2d: [{ kind: "rings", tipRadius: 0.004, chuckRadius: 0.009, chuckOffset: DRILL.bitLength, color: C.tool }],
      meta: { bitLength: DRILL.bitLength, bitDiameterMm: 6 },
    },
    { name: "chuck", parent: "tool", kind: "derived", local: { p: [0, 0, -DRILL.bitLength] } },
  );
  return { name: "smarttools-a4-v2", nodes, navigation: { tool: "tool", targets, tracked: "camera", reference: "sheet" } };
}

function qfromM(m: number[]): Q {
  // proper rotation matrix (row-major) -> quaternion
  const tr = m[0] + m[4] + m[8];
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    return [0.25 * s, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
  }
  if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    return [(m[7] - m[5]) / s, 0.25 * s, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
  }
  if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    return [(m[2] - m[6]) / s, (m[1] + m[3]) / s, 0.25 * s, (m[5] + m[7]) / s];
  }
  const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
  return [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, 0.25 * s];
}
