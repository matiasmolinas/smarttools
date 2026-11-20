// Gallery scenarios for the home page: short scripted stories that run the real engine (Rust/WASM)
// on scripted tool motion and show it in 3D, in 2D (the phone HUD over the simulated camera image, or
// a plan) and in a side panel. Scenarios about athos, contract-gatekeeper and agentvcs are marked as
// planned integrations: their panels illustrate how each project plugs in.

import { BOARD_TARGETS } from "../board.ts";
import { GATE_REASONS, gateReasonNames, type EngineEvent, type EngineSnapshot, type NavCore, type NavEngine } from "../engine.ts";
import { DEFAULT_DISTURBANCE, DEFAULT_RIG, RUN_TIME, V02_RIG, disturb, dockRigAt, toolWorldFromHold, truthAt, type Hold, type Rig } from "../scene.ts";
import { smartToolsScene, toXf, type SceneDef } from "../scenedef.ts";
import { compose, qaxis, xf, type Xf } from "../xform.ts";
import { phoneById } from "../phones.ts";
import type { V3 } from "../pose.ts";

export type Project = "athos" | "contract-gatekeeper" | "agentvcs";

export interface PanelLine {
  label: string;
  value: string;
  state?: "ok" | "warn" | "bad" | "idle";
}
export interface PanelStep {
  id: string;
  title: string;
  when: string;
  do: string;
  check: string;
  because: string;
  state: "done" | "active" | "todo";
}
export interface PanelModel {
  caption: string;
  lines?: PanelLine[];
  steps?: PanelStep[];
  records?: { cols: string[]; rows: string[][] };
  note?: string;
}

export interface Segment {
  from: number;
  rig: Rig;
  /** scene options for this segment */
  phone?: string;
  hideDock?: boolean;
  label: string;
}

export interface Ctx {
  core: NavCore;
  t: number;
  snap: EngineSnapshot | null;
  rig: Rig;
  names: Record<number, string>;
  /** every event since the scenario (re)started */
  events: EngineEvent[];
  /** per-run scratch space */
  store: Record<string, unknown>;
}

export interface ToolState {
  toolW: Xf;
  /** false: the camera does not see the markers this instant (no measurement) */
  seen?: boolean;
  markers?: number;
}

export interface EngineHooks {
  core: NavCore;
  engine: NavEngine;
  ids: Record<string, number>;
}

/** The real world, drawn next to the engine's model: parts where they truly are. */
export interface RealWorld {
  /** scene definition holding the real parts (rendered solid) */
  def: SceneDef;
  /** nodes of `def` to draw */
  nodes: string[];
  /** live local transforms (relative to the parent) for some real nodes; null hides the node */
  pose?: (ctx: Ctx) => Record<string, Xf | null>;
}

export interface Scenario {
  id: string;
  title: string;
  kicker: string;
  summary: string;
  project?: Project;
  /** a planned integration, illustrated (not implemented yet) */
  concept?: boolean;
  duration: number;
  view2d: "hud" | "plan" | "phone";
  segments: Segment[];
  scene: (seg: Segment) => SceneDef;
  tool: (ctx: Ctx) => ToolState;
  /** the dock is calibrated from this time on (default: always) */
  calibratedAt?: number;
  /** node names hidden in 3D at this time */
  hidden?: (ctx: Ctx) => string[];
  panel: (ctx: Ctx) => PanelModel;
  /** 3D camera position and target (metres, world: the sheet is the wall z = 0, Y up) */
  view3d?: { pos: V3; target: V3; up?: V3 };
  /** depth to reach per target (mm), in navigation order */
  depths?: number[];
  /** "drive" for screws: the HUD says Drive / Seated */
  action?: "drill" | "drive";
  /** called every step before the engine advances: register parts, change calibrations… */
  onStep?: (ctx: Ctx, h: EngineHooks) => void;
  /** a big line over the 3D view */
  headline?: (ctx: Ctx) => string;
  /** chapter chips (hero) */
  chapters?: { from: number; label: string }[];
  /** nodes of the engine's scene drawn as the CAD "ghost", and nodes hidden from the phone's own camera */
  ghost?: string[];
  phoneHidden?: string[];
  real?: RealWorld;
}

// ---------------- helpers ----------------

const ease = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const DOCK_NODES = ["dock", "dock-lower", "dock-arm", "dock-jaw"];
const reference = DEFAULT_RIG;
const v03 = (phone?: string, tilt?: number): Segment => ({ from: 0, rig: dockRigAt(tilt, reference, phone), phone, label: "dock v0.4" });

function active(ctx: Ctx) {
  const s = ctx.snap;
  if (!s || s.active < 0) return null;
  const n = s.targets[s.active];
  return { ...n, name: ctx.names[n.id] ?? "?" };
}

/** One hole on a square target, scripted in phases (seconds from `t0`). */
function oneHole(ctx: Ctx, target: { x: number; y: number }, t0: number, d = { approach: 3, align: 2.6, drill: 3.4, hold: 0.8, retract: 2 }, startTilt: [number, number] = [5, -4]): Hold {
  let t = ctx.t - t0;
  const tip = (dx: number, dy: number, z: number): V3 => [target.x + dx, target.y + dy, z];
  if (t < 0) return { tipWorld: tip(0.012, -0.01, 0.045), yawDeg: startTilt[0], pitchDeg: startTilt[1], twistDeg: 0 };
  if (t < d.approach) {
    const k = ease(t / d.approach);
    return { tipWorld: tip(lerp(0.012, 0.0004, k), lerp(-0.01, 0.0003, k), lerp(0.045, 0, k)), yawDeg: lerp(startTilt[0], 1.8, k), pitchDeg: lerp(startTilt[1], -1.4, k), twistDeg: 0 };
  }
  t -= d.approach;
  if (t < d.align) {
    const k = ease(t / (d.align * 0.75));
    return { tipWorld: tip(lerp(0.0004, 0.0001, k), lerp(0.0003, 0.0001, k), 0), yawDeg: lerp(1.8, 0.08, k), pitchDeg: lerp(-1.4, -0.06, k), twistDeg: 0 };
  }
  t -= d.align;
  const along = (depth: number): V3 => tip(0.0001, 0.0001, -depth);
  if (t < d.drill) return { tipWorld: along(0.035 * ease(t / d.drill)), yawDeg: 0.08, pitchDeg: -0.06, twistDeg: 0 };
  t -= d.drill;
  if (t < d.hold) return { tipWorld: along(0.035), yawDeg: 0.08, pitchDeg: -0.06, twistDeg: 0 };
  t -= d.hold;
  return { tipWorld: along(lerp(0.035, -0.05, ease(t / d.retract))), yawDeg: 0.08, pitchDeg: -0.06, twistDeg: 0 };
}

const withTremor = (ctx: Ctx, h: Hold, phase: "approach" | "align" | "drill" = "align", k = 1) =>
  disturb(h, ctx.t, phase, { ...DEFAULT_DISTURBANCE, tremorMm: DEFAULT_DISTURBANCE.tremorMm * k, tremorDeg: DEFAULT_DISTURBANCE.tremorDeg * k });
const toolOf = (ctx: Ctx, h: Hold): ToolState => ({ toolW: toolWorldFromHold(ctx.core, ctx.rig, h) });

function gateLines(ctx: Ctx): PanelLine[] {
  const s = ctx.snap;
  const a = active(ctx);
  if (!s) return [];
  return [
    { label: "mark", value: a ? a.name : "–" },
    { label: "phase", value: s.phase },
    { label: "angle", value: a ? `${fmt(a.angleErrDeg)}°` : "–", state: a && a.angleErrDeg < 0.4 ? "ok" : "warn" },
    { label: "offset", value: a ? `${fmt(a.offsetMm)} mm` : "–", state: a && a.offsetMm < 0.75 ? "ok" : "warn" },
    { label: a && a.depthMm > 0 ? "depth" : "gap", value: a ? `${fmt(a.depthMm > 0 ? a.depthMm : a.gapMm, 1)} mm` : "–" },
    s.phase === "drill" || s.phase === "hold" || s.phase === "retract"
      ? { label: "gate", value: "n/a while drilling (depth and angle alarms apply)", state: "idle" }
      : { label: "gate", value: s.ready ? "READY" : s.gate ? gateReasonNames(s.gate).join(", ").toLowerCase().replace(/_/g, " ") : s.locking ? "locking" : "–", state: s.ready ? "ok" : "warn" },
  ];
}

// ---------------- the scenarios ----------------

const drillThree: Scenario = {
  id: "drill-three",
  kicker: "The core loop",
  title: "Three holes, square and to depth",
  summary: "The phone on the drill tracks the printed sheet. For each mark: tip to the cross, line up the rings, drill, stop at 35 mm.",
  duration: RUN_TIME,
  view2d: "hud",
  segments: [v03()],
  scene: () => smartToolsScene({ tool: reference.tool }),
  tool: (ctx) => {
    const st = truthAt(ctx.t);
    return toolOf(ctx, disturb(st.hold, ctx.t, st.phase, DEFAULT_DISTURBANCE));
  },
  panel: (ctx) => {
    const s = ctx.snap;
    const caption = !s
      ? "Starting the engine…"
      : s.phase === "approach"
        ? "Bring the tip to the cross. The engine picks the nearest mark not drilled yet."
        : s.phase === "align"
          ? s.ready
            ? "Square within 0.4°, on the mark within 0.75 mm, steady: ready to drill."
            : "Pivot on the tip until the two rings are concentric."
          : s.phase === "drill"
            ? "Depth is measured along the bit, every tick (120 Hz)."
            : s.phase === "hold"
              ? "35 mm reached: stop. The hole is logged."
              : "Next mark.";
    return { caption, lines: gateLines(ctx) };
  },
};

const calibrate: Scenario = {
  id: "calibrate",
  kicker: "Set-up, once per phone and drill",
  title: "Calibrate: circle around the tip, then twist",
  summary: "The phone does not need to be aligned with the bit. Two short motions measure where the tip and the bit axis really are.",
  duration: 13,
  view2d: "plan",
  segments: [v03()],
  scene: (seg) => smartToolsScene({ tool: seg.rig.tool }),
  calibratedAt: 10.5,
  tool: (ctx) => {
    const a2 = BOARD_TARGETS[1];
    const tip: V3 = [a2.x, a2.y, 0];
    const t = ctx.t;
    if (t < 5) {
      const r = 3 + 9 * Math.min(1, t / 2);
      const a = t * 2 * Math.PI * 0.55;
      return toolOf(ctx, { tipWorld: tip, yawDeg: r * Math.cos(a), pitchDeg: r * Math.sin(a), twistDeg: 0 });
    }
    if (t < 10) return toolOf(ctx, { tipWorld: tip, yawDeg: 0.3, pitchDeg: -0.2, twistDeg: 28 * Math.sin(((t - 5) / 5) * 2 * Math.PI) });
    return toolOf(ctx, withTremor(ctx, { tipWorld: tip, yawDeg: 0.05, pitchDeg: -0.04, twistDeg: 0 }));
  },
  panel: (ctx) => {
    const t = ctx.t;
    const tool = ctx.rig.tool;
    const pct = (a: number, b: number) => `${Math.round(Math.min(1, Math.max(0, (t - a) / (b - a))) * 100)} %`;
    return {
      caption:
        t < 5
          ? "Tip resting on A2: circle the drill around it. Every pose sees the tip at the same point: that fixes where the tip is."
          : t < 10
            ? "Now twist the drill around the bit. Every pose shares one line: that is the bit axis."
            : "Calibrated. The gate can open; the dock's real tilt was measured, not assumed.",
      lines: [
        { label: "tip (pivot)", value: t < 5 ? pct(0, 5) : `(${tool.tipCam.map((v) => fmt(v * 1000, 0)).join(", ")}) mm`, state: t < 5 ? "idle" : "ok" },
        { label: "bit axis (twist)", value: t < 5 ? "waiting" : t < 10 ? pct(5, 10) : `${fmt((Math.acos(tool.axisCam[2]) * 180) / Math.PI, 1)}° from the optical axis`, state: t < 10 ? "idle" : "ok" },
        { label: "in the simulator", value: "tip within 0.05 mm, axis within 0.003°" },
        ...(t >= 10.5 ? gateLines(ctx).slice(-1) : []),
      ],
    };
  },
};

const angled: Scenario = {
  id: "angled",
  kicker: "Geometry, not special cases",
  title: "A hole planned 15° off the normal",
  summary: "Every mark is a full coordinate frame. An angled hole is just a rotated frame: the same rings, the same gate, depth along its own axis.",
  duration: 11,
  view2d: "plan",
  segments: [v03()],
  scene: () => smartToolsScene({ tool: reference.tool, angledTargetDeg: 15 }),
  view3d: { pos: [0.32, 0.02, 0.34], target: [0.03, -0.05, 0.05] },
  tool: (ctx) => {
    const def = smartToolsScene({ tool: reference.tool, angledTargetDeg: 15 });
    const b1 = def.nodes.find((n) => n.name === "B1")!;
    const tw = compose(toXf(), toXf(b1.local));
    const t = ctx.t;
    const k = Math.min(1, t / 3);
    const z = t < 3 ? -0.04 * (1 - ease(k)) : t < 5.5 ? 0 : Math.min(0.035, ((t - 5.5) / 3) * 0.035);
    const tilt = t < 3 ? 4 - 3.9 * ease(k) : 0.1;
    return { toolW: compose(tw, xf([0.0002, -0.0001, t > 9 ? lerp(0.035, -0.05, ease((t - 9) / 2)) : z], qaxis([1, 1, 0], (tilt * Math.PI) / 180))) };
  },
  panel: (ctx) => ({
    caption: "The engine measures the bit against B1's own axis: angle, offset and depth all come from one relative transform, tool in target.",
    lines: gateLines(ctx),
  }),
};

const safety: Scenario = {
  id: "safety",
  kicker: "Deterministic, every tick",
  title: "When the gate says no",
  summary: "Ready only when calibrated, seen, steady, square and on the mark. Covering the markers, shaking or tilting while drilling is caught.",
  duration: 16,
  view2d: "hud",
  segments: [v03()],
  scene: () => smartToolsScene({ tool: reference.tool }),
  tool: (ctx) => {
    const a2 = BOARD_TARGETS[1];
    const onA2: Hold = { tipWorld: [a2.x, a2.y, 0], yawDeg: 0.06, pitchDeg: -0.05, twistDeg: 0 };
    const t = ctx.t;
    if (t < 4) {
      const k = ease(t / 1.4);
      return toolOf(ctx, withTremor(ctx, { tipWorld: [a2.x + 0.006 * (1 - k), a2.y - 0.004 * (1 - k), 0.012 * (1 - k)], yawDeg: lerp(2, 0.06, k), pitchDeg: lerp(-1.5, -0.05, k), twistDeg: 0 }));
    }
    if (t < 7) return { ...toolOf(ctx, onA2), seen: false };
    if (t < 10.5) return toolOf(ctx, withTremor(ctx, onA2, "align", 6));
    const a = (1.2 * Math.PI) / 180;
    const d = Math.min(0.02, Math.max(0, t - 11) * 0.008);
    return toolOf(ctx, { tipWorld: [a2.x + Math.sin(a) * d, a2.y, -Math.cos(a) * d], yawDeg: 1.2, pitchDeg: 0, twistDeg: 0 });
  },
  panel: (ctx) => {
    const t = ctx.t;
    const s = ctx.snap;
    const alarm = s && s.alarms & 2;
    return {
      caption:
        t < 4
          ? "Calibrated, on the mark, square and steady: the gate opens after 0.4 s."
          : t < 7
            ? "A hand covers the markers: no measurement, the data ages, the gate closes."
            : t < 10.5
              ? "Shaking: the tip moves more than 0.4 mm over half a second. Held back."
              : alarm
                ? "Drilling 1.2° off square: angle alarm (the requirement is 0.5°)."
                : "Drilling with the bit tilted…",
      lines: [
        ...gateLines(ctx),
        { label: "alarms", value: s ? [s.alarms & 1 ? "depth" : "", s.alarms & 2 ? "angle" : "", s.alarms & 4 ? "lost while drilling" : ""].filter(Boolean).join(", ") || "none" : "–", state: s && s.alarms ? "bad" : "ok" },
        { label: "unsteady", value: s && s.gate & GATE_REASONS.UNSTEADY ? `yes (${fmt(s.jitterMm)} mm)` : "no", state: s && s.gate & GATE_REASONS.UNSTEADY ? "warn" : "ok" },
      ],
    };
  },
};

const cameraView: Scenario = {
  id: "camera-view",
  kicker: "Found by the simulator",
  title: "What the camera can see: dock v0.2 vs v0.4",
  summary: "v0.2 put the camera 17 cm above the bit: the tip left the image and A1 had no marker in view. v0.4 puts the lens right above the bit, high enough to see over the saddle, tilted 15° toward the tip.",
  duration: 14,
  view2d: "hud",
  segments: [
    { from: 0, rig: V02_RIG, hideDock: true, label: "dock v0.2: tip out of view" },
    { from: 7, rig: reference, label: "dock v0.4: tip 15° below the centre" },
  ],
  scene: (seg) => smartToolsScene({ tool: seg.rig.tool }),
  hidden: (ctx) => (ctx.t < 7 ? DOCK_NODES : []),
  tool: (ctx) => {
    const a1 = BOARD_TARGETS[0];
    const k = ((ctx.t % 7) / 7) * 2 * Math.PI;
    const st = toolOf(ctx, { tipWorld: [a1.x + 0.002 * Math.sin(k), a1.y, 0.004], yawDeg: 0.8 * Math.sin(k), pitchDeg: 0.6 * Math.cos(k), twistDeg: 0 });
    // v0.2: the camera sees no marker on A1, so the engine gets no measurement
    return ctx.t < 7 ? { ...st, seen: false } : st;
  },
  panel: (ctx) => {
    const v02 = ctx.t < 7;
    return {
      caption: v02
        ? "Dock v0.2: the lens sits 17 cm above the bit and 8 cm to the side. The bit tip is 39° below the optical axis; the camera sees ±19.6°."
        : "Dock v0.4: the lens is right above the bit and clear of the saddle and the hinge (checked by intersecting its view with the parts). The tip is 15° below the image centre, and 9-19 markers are in view on every mark.",
      lines: [
        { label: "tip in the image", value: v02 ? "no (39° below)" : "yes (15° below)", state: v02 ? "bad" : "ok" },
        { label: "markers in view on A1", value: v02 ? "0" : "9-12", state: v02 ? "bad" : "ok" },
        { label: "end-to-end tests", value: v02 ? "rig check fails" : "40/40 pass", state: v02 ? "bad" : "ok" },
      ],
      note: "From npm run test:e2e -- --only rig (v0.2: --rig v02).",
    };
  },
};

const phones: Scenario = {
  id: "phones",
  kicker: "One dock, any phone",
  title: "Redmi Note 13 or Redmi 15: same dock, own profile",
  summary: "Each phone has its own size and lens position. A profile places the camera in the same printed dock; calibration measures the rest.",
  duration: 14,
  view2d: "hud",
  segments: [
    { from: 0, rig: dockRigAt(undefined, reference, "redmi-note-13"), phone: "redmi-note-13", label: "Redmi Note 13" },
    { from: 7, rig: dockRigAt(undefined, reference, "redmi-15"), phone: "redmi-15", label: "Redmi 15 (provisional profile)" },
  ],
  scene: (seg) => smartToolsScene({ tool: seg.rig.tool, phone: seg.phone }),
  tool: (ctx) => {
    const a2 = BOARD_TARGETS[1];
    const k = ((ctx.t % 7) / 7) * 2 * Math.PI;
    return toolOf(ctx, { tipWorld: [a2.x, a2.y, 0.01 + 0.006 * Math.sin(k)], yawDeg: 0.5 * Math.sin(k), pitchDeg: 0.4 * Math.cos(k), twistDeg: 0 });
  },
  panel: (ctx) => {
    const p = phoneById(ctx.t < 7 ? "redmi-note-13" : "redmi-15");
    const [x, y, z] = ctx.rig.tool.tipCam;
    return {
      caption: `${p.name}: lens ${p.camFromTop} mm from the top and ${p.camFromLeft} mm from the left (back, upright). In the dock that puts the tip ${fmt((Math.atan2(y, z) * 180) / Math.PI, 1)}° below and ${fmt((Math.atan2(x, z) * 180) / Math.PI, 1)}° beside the image centre.`,
      lines: [
        { label: "size", value: `${p.length} × ${p.width} × ${p.thickness} mm` },
        { label: "profile", value: p.provisional ? "provisional: measure it" : "measured", state: p.provisional ? "warn" : "ok" },
        { label: "calibrations", value: "lens per phone, dock per phone and drill" },
        { label: "sanity check", value: "warns if Calibrate is > 15 mm from the profile" },
      ],
    };
  },
};

const ATHOS_STEPS = [
  { id: "#mark", title: "Tip on the mark", when: "the tip is near the planned hole", do: "rest the tip on the cross", check: "offset < 0.75 mm and the tip on the surface", because: "the hole goes exactly where planned" },
  { id: "#square", title: "Square the bit", when: "the tip rests on the mark", do: "pivot on the tip until the rings are concentric", check: "angle < 0.4° and steady for 0.4 s", because: "a tilted bit wanders and the hole ends off target" },
  { id: "#drill", title: "Drill to depth", when: "the gate says ready", do: "drill, keeping the rings centred", check: "depth reaches 35 mm with the angle under 0.5°", because: "the anchor needs 35 mm, not more" },
  { id: "#stop", title: "Stop and log", when: "depth reached", do: "stop and pull back", check: "the hole is recorded with its errors", because: "the next job learns from this one" },
];

const athos: Scenario = {
  id: "athos",
  project: "athos",
  concept: true,
  kicker: "athos · plan & guide",
  title: "Know-how as steps the drill can check",
  summary: "A master writes the recipe once (When / Do / Check / Because). The phone shows one step at a time, and every Check is a physical measurement from the engine.",
  duration: 13,
  view2d: "hud",
  segments: [v03()],
  scene: () => smartToolsScene({ tool: reference.tool }),
  tool: (ctx) => toolOf(ctx, withTremor(ctx, oneHole(ctx, BOARD_TARGETS[1], 0.5, { approach: 3, align: 2.6, drill: 3.4, hold: 0.8, retract: 2.2 }))),
  panel: (ctx) => {
    const s = ctx.snap;
    const a = active(ctx);
    const reached = ctx.events.some((e) => e.kind === "depth-reached");
    const i = !s || !a ? 0 : reached && s.phase !== "drill" ? 3 : s.phase === "drill" || s.phase === "hold" ? 2 : s.phase === "align" ? 1 : 0;
    return {
      caption: "The recipe is Markdown (athos). The engine decides when each Check passes; the HUD shows the current step.",
      steps: ATHOS_STEPS.map((st, k) => ({ ...st, state: k < i ? "done" : k === i ? "active" : "todo" })),
      lines: gateLines(ctx).slice(2, 6),
    };
  },
};

const gatekeeper: Scenario = {
  id: "gatekeeper",
  project: "contract-gatekeeper",
  concept: true,
  kicker: "contract-gatekeeper · evolve safely",
  title: "New tools, verified before they touch the core",
  summary: "An agent writes a plugin for a new tool. A deterministic verifier checks its Capability Card and selfTest in milliseconds: fast-track, escalate or reject.",
  duration: 16,
  view2d: "hud",
  segments: [v03()],
  scene: () => {
    const def = smartToolsScene({ tool: reference.tool });
    // the screwdriver plugin's tool: a hex bit on the same calibrated tool frame
    def.nodes.push({
      name: "driver",
      parent: "tool",
      kind: "display",
      visual3d: [
        { kind: "cylinder", radius: 0.0032, length: 0.06, axis: "z", offset: { p: [0, 0, -0.03] }, material: { color: "#3dffa8", metalness: 0.8, roughness: 0.3 } },
        { kind: "cylinder", radius: 0.005, length: 0.03, axis: "z", offset: { p: [0, 0, -0.075] }, material: { color: "#3dffa8", metalness: 0.6, roughness: 0.4 } },
      ],
    });
    return def;
  },
  hidden: (ctx) => (ctx.t < 6.5 || ctx.t > 13 ? ["driver"] : []),
  tool: (ctx) => {
    const a3 = BOARD_TARGETS[2];
    if (ctx.t < 6.5) return toolOf(ctx, withTremor(ctx, { tipWorld: [a3.x + 0.01, a3.y - 0.008, 0.05], yawDeg: 3, pitchDeg: -2, twistDeg: 0 }, "approach"));
    return toolOf(ctx, withTremor(ctx, oneHole(ctx, a3, 6.5, { approach: 1.8, align: 1.6, drill: 2.4, hold: 0.5, retract: 1.2 }, [3, -2])));
  },
  panel: (ctx) => {
    const t = ctx.t;
    const card = (name: string, reads: string, writes: string, test: string, verdict: string, state: PanelLine["state"]): PanelLine[] => [
      { label: "plugin", value: name },
      { label: "capability card", value: `reads ${reads} · writes ${writes}` },
      { label: "selfTest()", value: test },
      { label: "verdict", value: verdict, state },
    ];
    if (t < 3) return { caption: "An agent proposes screwdriver-depth v0.1: drive a screw flush using the same tracked tool frame.", lines: card("screwdriver-depth v0.1", "tool pose, target", "HUD hints", "running…", "pending", "idle") };
    if (t < 6.5) return { caption: "The verifier reads the Capability Card and runs the plugin's selfTest. No LLM in the loop: ~10 ms.", lines: card("screwdriver-depth v0.1", "tool pose, target", "HUD hints", "12/12 pass · 9 ms", "FAST_TRACK", "ok") };
    if (t < 12.5) return { caption: "Fast-tracked: the plugin drives at A3 on the same engine, gate and depth stop.", lines: [...card("screwdriver-depth v0.1", "tool pose, target", "HUD hints", "12/12 pass · 9 ms", "FAST_TRACK · loaded", "ok"), ...gateLines(ctx).slice(2, 5)] };
    return {
      caption: "auto-aim v0.1 asks to rewrite the calibration to make 'ready' easier. It would touch the geometry core: rejected before it ever runs.",
      lines: card("auto-aim v0.1", "tool pose", "dock calibration (geometry core)", "not run", "REJECTED", "bad"),
      note: "Illustrative: how contract-gatekeeper would sit between agent-written plugins and the navigation engine.",
    };
  },
};

const agentvcs: Scenario = {
  id: "agentvcs",
  project: "agentvcs",
  concept: true,
  kicker: "agentvcs · learn in the field",
  title: "Every hole is a versioned step record",
  summary: "Each hole is recorded with its measured errors and the exact harness version. Across jobs, blame and bisect show which change made people more precise.",
  duration: RUN_TIME,
  view2d: "plan",
  segments: [v03()],
  scene: () => smartToolsScene({ tool: reference.tool }),
  tool: (ctx) => {
    const st = truthAt(ctx.t);
    return toolOf(ctx, disturb(st.hold, ctx.t, st.phase, DEFAULT_DISTURBANCE));
  },
  panel: (ctx) => {
    const s = ctx.snap;
    const rec = (ctx.store.records ??= []) as string[][];
    const seen = (ctx.store.seen ??= new Set<number>()) as Set<number>;
    const a = active(ctx);
    if (s && a && s.phase === "drill") ctx.store.angleDrill = Math.max((ctx.store.angleDrill as number) ?? 0, a.angleErrDeg);
    for (const e of ctx.events) {
      if (e.kind !== "depth-reached" || seen.has(e.tick)) continue;
      seen.add(e.tick);
      const name = ctx.names[e.node] ?? "?";
      rec.push([`step-${String(rec.length + 1).padStart(3, "0")}`, name, `${fmt((ctx.store.angleDrill as number) ?? 0)}°`, `${fmt(e.value, 1)} mm`, "nav-engine 0.4 · abi 3"]);
      ctx.store.angleDrill = 0;
    }
    return {
      caption: rec.length < 3 ? "Each hole becomes a step record: what was asked, what was measured, with which version." : "Across many jobs, records answer: which change made people more precise?",
      records: { cols: ["step", "mark", "max angle while drilling", "depth", "harness"], rows: rec },
      lines:
        rec.length >= 3
          ? [
              { label: "blame", value: "angle error p95 0.13° → 0.31° after filter beta 300 → 30", state: "warn" },
              { label: "bisect", value: "first bad: nav-engine 0.4.1 (commit 7f3a…)", state: "bad" },
            ]
          : undefined,
      note: "Records come from the live engine above; the blame/bisect lines are illustrative.",
    };
  },
};

export const SCENARIOS_FLAT: Scenario[] = [drillThree, calibrate, angled, safety, cameraView, phones, athos, gatekeeper, agentvcs];

export const PROJECT_INFO: Record<Project, { url: string; role: string }> = {
  athos: { url: "https://github.com/athos-agent/athos", role: "Plan & guide" },
  "contract-gatekeeper": { url: "https://github.com/matiasmolinas/contract-gatekeeper", role: "Evolve safely" },
  agentvcs: { url: "https://github.com/EvolvingAgentsLabs/agentvcs", role: "Learn in the field" },
};
