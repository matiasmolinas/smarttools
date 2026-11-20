// HUD adapter: an engine snapshot -> what the phone HUD draws (lib/hud.ts). The HUD stays a pure
// renderer: "ready", "locking" and the reason it is not ready all come from the engine.

import type { EngineSnapshot } from "../engine.ts";
import type { SceneDef } from "../scenedef.ts";
import type { Overlay } from "../hud.ts";
import type { SimState } from "../sim.ts";
import { applyDir, applyPoint, inverse } from "../xform.ts";
import { gateMessage } from "../session.ts";

type P = { x: number; y: number };
const BIT_LEN = 0.11;

export interface HudInputs {
  def: SceneDef;
  ids: Record<string, number>;
  snapshot: EngineSnapshot;
  /** image-space overlay (camera views only) */
  image?: { aim: P | null; mark: P | null; quads: P[][]; scale?: number } | null;
  info?: string;
  calibrating?: Overlay["calibrating"];
  /** display thresholds for the ring colours (the engine's gate limits) */
  limits?: { maxAngleDeg: number; maxOffsetMm: number };
  /** depth per target (mm, by target node id) and whether marks are drilled or screws driven */
  depthTargetMm?: (targetId: number) => number | undefined;
  action?: "drill" | "drive";
  /** a guidance hint (out of order, material left under the tip) */
  hint?: string | null;
}

export function hudView(i: HudInputs): { state: SimState; overlay: Overlay } {
  const s = i.snapshot;
  const nav = i.def.navigation;
  const w = (name: string) => s.nodes.find((n) => n.id === i.ids[name]);
  const ref = w(nav.reference)?.world;
  const tool = w(nav.tool)?.world;
  const cam = w(nav.tracked);
  const active = s.active >= 0 ? s.targets[s.active] : null;
  const activeName = active ? Object.keys(i.ids).find((k) => i.ids[k] === active.id) ?? "" : "";
  const tgW = active ? s.nodes.find((n) => n.id === active.id)?.world : null;
  const lim = i.limits ?? { maxAngleDeg: 0.4, maxOffsetMm: 0.75 };

  // drawing frame: the reference (sheet, z out of the surface), as the HUD always used
  const toRef = ref ? inverse(ref) : null;
  const tip = tool && toRef ? applyPoint(toRef, tool.p) : [0, 0, 0.2];
  const axis = tool && toRef ? applyDir(toRef, applyDir(tool, [0, 0, 1])) : [0, 0, -1];
  const tg = tgW && toRef ? applyPoint(toRef, tgW.p) : [0, 0, 0];
  const lost = !cam || cam.status === "lost" || cam.status === "stale";
  const sc = i.image?.scale ?? 1;
  const px = (p: P | null) => (p ? { x: p.x * sc, y: p.y * sc } : null);

  const state: SimState = {
    t: s.t,
    phase: s.phase,
    targetIndex: Math.max(0, s.active),
    target: { x: tg[0], y: tg[1] },
    tip: { x: tip[0], y: tip[1], z: tip[2] },
    chuck: { x: tip[0] - axis[0] * BIT_LEN, y: tip[1] - axis[1] * BIT_LEN, z: tip[2] - axis[2] * BIT_LEN },
    axis: { x: axis[0], y: axis[1], z: axis[2] },
    // tilt relative to the active mark's own axis (any face, any angle); same signs as before for square holes
    yawDeg: active ? active.yawDeg : (Math.atan2(axis[0], -axis[2]) * 180) / Math.PI,
    pitchDeg: active ? -active.pitchDeg : (Math.atan2(axis[1], -axis[2]) * 180) / Math.PI,
    angleErrDeg: active?.angleErrDeg ?? 90,
    offsetMm: active?.offsetMm ?? 1e3,
    gapMm: active?.gapMm ?? 200,
    depthMm: active?.depthMm ?? 0,
    aligned: !!active && active.angleErrDeg < lim.maxAngleDeg,
    onTarget: !!active && active.offsetMm < lim.maxOffsetMm,
    drilled: s.targets.map((t) => t.drilled),
    bitSpin: 0,
    label: activeName,
    depthTargetMm: active ? i.depthTargetMm?.(active.id) : undefined,
    action: i.action,
  };
  const overlay: Overlay = {
    lost,
    aim: lost ? null : px(i.image?.aim ?? null),
    mark: lost ? null : px(i.image?.mark ?? null),
    quads: (i.image?.quads ?? []).map((q) => q.map((p) => ({ x: p.x * sc, y: p.y * sc }))),
    info: i.info ?? (lost ? "searching" : `${s.markers} tags`),
    gate: { ready: s.ready, locking: s.locking, message: gateMessage(s.gate) },
    calibrating: i.calibrating ?? null,
    alarms: s.alarms,
    hint: i.hint ?? null,
  };
  return { state, overlay };
}
