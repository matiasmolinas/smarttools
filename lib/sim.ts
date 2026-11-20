// Deterministic drill-navigation simulation shared by the 3D scene and the 2D HUD.
// Units: metres and degrees. Wall is the plane z = 0, normal +z. Drill points toward -z.

export type Phase = "approach" | "align" | "drill" | "hold" | "retract";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface SimState {
  t: number;
  phase: Phase;
  targetIndex: number;
  target: { x: number; y: number };
  tip: Vec3; // bit tip position
  chuck: Vec3; // chuck nose position (BIT_LEN behind the tip along the axis)
  axis: Vec3; // unit vector, tip direction (toward wall)
  yawDeg: number;
  pitchDeg: number;
  angleErrDeg: number;
  offsetMm: number; // lateral tip-to-target distance
  gapMm: number; // tip-to-wall distance (0 while drilling)
  depthMm: number;
  aligned: boolean;
  onTarget: boolean;
  drilled: boolean[];
  bitSpin: number;
  label: string;
  /** depth to reach for this mark (default 35 mm) and whether it is drilled or a screw is driven */
  depthTargetMm?: number;
  action?: "drill" | "drive";
}

export const TARGETS = [
  { x: -0.24, y: 0.1, label: "A1" },
  { x: 0.04, y: -0.06, label: "A2" },
  { x: 0.28, y: 0.12, label: "A3" },
];
export const MARKERS = [
  { x: -0.42, y: 0.26 },
  { x: 0.44, y: 0.26 },
  { x: -0.42, y: -0.24 },
  { x: 0.44, y: -0.24 },
];

export const BIT_LEN = 0.11;
export const DEPTH_TARGET_MM = 35;
export const ANGLE_TOL_DEG = 0.5;
export const OFFSET_TOL_MM = 1.0;
export const START_GAP = 0.22;

const START_OFFSET = { x: 0.07, y: -0.05 };
const START_TILT = { yaw: 9, pitch: -6 };

// seconds
const T_APPROACH = 3.6;
const T_ALIGN = 1.8;
const T_DRILL = 3.0;
const T_HOLD = 1.1;
const T_RETRACT = 2.0;
export const CYCLE = T_APPROACH + T_ALIGN + T_DRILL + T_HOLD + T_RETRACT;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => {
  const x = clamp01(v);
  return x * x * (3 - 2 * x);
};
const easeOut = (v: number) => 1 - Math.pow(1 - clamp01(v), 3);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

export function simulate(t: number): SimState {
  const cycleIndex = Math.floor(t / CYCLE);
  const local = t - cycleIndex * CYCLE;
  const targetIndex = cycleIndex % TARGETS.length;
  const target = TARGETS[targetIndex];
  const next = TARGETS[(targetIndex + 1) % TARGETS.length];

  let phase: Phase;
  let ox: number, oy: number, gap: number, depth: number, yaw: number, pitch: number;
  let tx = target.x;
  let ty = target.y;
  let tremor: number;
  let holeDone = false;

  const a1 = T_APPROACH;
  const a2 = a1 + T_ALIGN;
  const a3 = a2 + T_DRILL;
  const a4 = a3 + T_HOLD;

  if (local < a1) {
    phase = "approach";
    const k = easeOut(local / T_APPROACH);
    ox = lerp(START_OFFSET.x, 0.004, k);
    oy = lerp(START_OFFSET.y, -0.003, k);
    gap = lerp(START_GAP, 0.006, k);
    yaw = lerp(START_TILT.yaw, 2.4, k);
    pitch = lerp(START_TILT.pitch, -1.8, k);
    depth = 0;
    tremor = 1;
  } else if (local < a2) {
    phase = "align";
    const k = ease((local - a1) / T_ALIGN);
    ox = lerp(0.004, 0, k);
    oy = lerp(-0.003, 0, k);
    gap = lerp(0.006, 0, k);
    yaw = lerp(2.4, 0, k);
    pitch = lerp(-1.8, 0, k);
    depth = 0;
    tremor = lerp(1, 0.35, k);
  } else if (local < a3) {
    phase = "drill";
    const k = ease((local - a2) / T_DRILL);
    ox = 0;
    oy = 0;
    gap = 0;
    yaw = 0;
    pitch = 0;
    depth = (DEPTH_TARGET_MM / 1000) * k;
    tremor = 0.35;
  } else if (local < a4) {
    phase = "hold";
    ox = oy = gap = yaw = pitch = 0;
    depth = DEPTH_TARGET_MM / 1000;
    tremor = 0.25;
    holeDone = true;
  } else {
    phase = "retract";
    holeDone = true;
    const k = ease((local - a4) / T_RETRACT);
    const kd = ease(((local - a4) / T_RETRACT) * 2.5);
    depth = lerp(DEPTH_TARGET_MM / 1000, 0, kd);
    gap = lerp(0, START_GAP, k);
    // slide toward the next target; express the offset relative to the next target
    tx = next.x;
    ty = next.y;
    ox = lerp(target.x - next.x, START_OFFSET.x, k);
    oy = lerp(target.y - next.y, START_OFFSET.y, k);
    yaw = lerp(0, START_TILT.yaw, k);
    pitch = lerp(0, START_TILT.pitch, k);
    tremor = 1;
  }

  // hand tremor (deterministic, small)
  const tr = tremor;
  yaw += tr * (0.22 * Math.sin(t * 7.3) + 0.12 * Math.sin(t * 13.1 + 1.2));
  pitch += tr * (0.2 * Math.sin(t * 6.1 + 0.4) + 0.1 * Math.sin(t * 11.7 + 2.1));
  ox += tr * 0.00025 * Math.sin(t * 5.3);
  oy += tr * 0.00025 * Math.sin(t * 4.7 + 1);

  const ax = Math.tan((yaw * Math.PI) / 180);
  const ay = Math.tan((pitch * Math.PI) / 180);
  const n = Math.hypot(ax, ay, 1);
  const axis = { x: ax / n, y: ay / n, z: -1 / n };

  const tip = { x: tx + ox, y: ty + oy, z: gap - depth };
  const chuck = {
    x: tip.x - axis.x * BIT_LEN,
    y: tip.y - axis.y * BIT_LEN,
    z: tip.z - axis.z * BIT_LEN,
  };

  const angleErrDeg = Math.hypot(yaw, pitch);
  const offsetMm = Math.hypot(tip.x - (phase === "retract" ? next.x : target.x), tip.y - (phase === "retract" ? next.y : target.y)) * 1000;

  const drilled = TARGETS.map((_, i) => i < targetIndex || (i === targetIndex && holeDone));
  // spin while drilling
  const spinT = phase === "drill" || phase === "hold" ? local - a2 : 0;
  const bitSpin = phase === "drill" ? spinT * 40 : 0;

  return {
    t,
    phase,
    targetIndex: phase === "retract" ? (targetIndex + 1) % TARGETS.length : targetIndex,
    target: phase === "retract" ? next : target,
    tip,
    chuck,
    axis,
    yawDeg: yaw,
    pitchDeg: pitch,
    angleErrDeg,
    offsetMm,
    gapMm: Math.max(0, gap * 1000),
    depthMm: depth * 1000,
    aligned: angleErrDeg < ANGLE_TOL_DEG,
    onTarget: offsetMm < OFFSET_TOL_MM,
    drilled,
    bitSpin,
    label: (phase === "retract" ? next : target).label,
  };
}

export interface AthosStep {
  id: string;
  when: string;
  do: string;
  check: string;
  pass: boolean;
}

export function athosStep(s: SimState): AthosStep {
  const label = TARGETS[s.targetIndex].label;
  switch (s.phase) {
    case "approach":
      return {
        id: "#place-tip",
        when: `Bit approaches target ${label}`,
        do: "Bring the tip onto the crosshair",
        check: `tip offset < ${OFFSET_TOL_MM.toFixed(1)} mm`,
        pass: s.onTarget,
      };
    case "align":
      return {
        id: "#square-to-wall",
        when: "Tip resting on the mark",
        do: "Stack the chuck ring over the tip ring",
        check: `angle error < ${ANGLE_TOL_DEG}° for 500 ms`,
        pass: s.aligned && s.onTarget,
      };
    case "drill":
      return {
        id: "#drill-to-depth",
        when: "Aligned · trigger enabled",
        do: `Drill to ${DEPTH_TARGET_MM.toFixed(1)} mm, keep rings stacked`,
        check: `depth ≥ ${DEPTH_TARGET_MM} mm → STOP`,
        pass: s.depthMm >= DEPTH_TARGET_MM - 0.05,
      };
    case "hold":
      return {
        id: "#drill-to-depth",
        when: "Depth reached",
        do: "Release trigger",
        check: `depth ${DEPTH_TARGET_MM.toFixed(1)} mm · ∠ err ${s.angleErrDeg.toFixed(2)}°`,
        pass: true,
      };
    default:
      return {
        id: "#next-target",
        when: "Hole verified, logged to agentvcs",
        do: `Retract and move to ${label}`,
        check: "marker A-frame re-acquired",
        pass: false,
      };
  }
}
