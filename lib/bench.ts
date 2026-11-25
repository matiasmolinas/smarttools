// The bench lab: measures how steady the navigation is on a real drill, motor off and motor on.
// Each tracker frame gives two tool poses in the sheet's frame:
//   raw       straight from that frame's marker pose and the tool calibration (no filtering)
//   filtered  the engine's (One Euro filter on the tip and the axis, then prediction)
// Recorded in labelled phases (motor-off, motor-on, drilling, check-a2), they become a run file that the
// /benchmarks page plots. The phone's accelerometer is recorded only as a witness of how hard the motor
// shakes: it never enters the pose (the navigation is purely optical).
//
// What this measures is stability (jitter, precision). Accuracy needs a reference: the check-a2 phase
// (the tip resting on the printed target A2) gives the tip's distance to a known point.

import type { EngineSnapshot } from "./engine.ts";
import type { V3 } from "./pose.ts";
import { applyDir, applyPoint, type Xf } from "./xform.ts";
import { BOARD_TARGETS } from "./board.ts";

export const BENCH_KIND = "smarttools-bench";
export const BENCH_VERSION = 1;

export const PHASES = {
  "motor-off": { label: "Motor off", seconds: 10, hint: "Drill still, motor off, bit a few mm above A2" },
  "motor-on": { label: "Motor on (free spin)", seconds: 10, hint: "Same position, trigger held: the bit spins in the air" },
  drilling: { label: "Drilling", seconds: 10, hint: "Drill into scrap wood beside the sheet, markers in view" },
  "check-a2": { label: "Check on A2", seconds: 5, hint: "Motor off, bit tip resting on the centre of A2, drill square" },
} as const;
export type PhaseId = keyof typeof PHASES;

/** A2, the check point, in the sheet's frame (mm) */
export const A2_MM: V3 = (() => {
  const a2 = BOARD_TARGETS.find((t) => t.label === "A2")!;
  return [a2.x * 1000, a2.y * 1000, 0];
})();

export interface ToolPose {
  /** bit tip, mm, sheet frame */
  tip: V3;
  /** bit axis (drilling direction), unit, sheet frame */
  axis: V3;
}
export interface BenchSample {
  /** s since the run started */
  t: number;
  phase: PhaseId;
  raw: ToolPose | null;
  filtered: ToolPose | null;
  markers: number;
  rmsPx: number;
  /** capture to processed, ms */
  latencyMs: number;
}
export interface AccelSample {
  t: number;
  phase: PhaseId;
  /** |acceleration without gravity|, m/s² */
  a: number;
}

export interface Stats {
  n: number;
  /** angle between the bit and the sheet's normal (into the sheet), mean, deg */
  tiltDeg: number;
  /** RMS angle of the bit around its mean direction, deg */
  angleJitterDeg: number;
  angleP95Deg: number;
  /** the same after removing slow drift (a 0.5 s moving average): what the motor adds */
  angleJitterHpDeg: number;
  /** RMS distance of the tip from its mean, mm */
  tipJitterMm: number;
  tipJitterHpMm: number;
}
export interface PhaseSummary {
  phase: PhaseId;
  frames: number;
  /** share of frames with a marker pose */
  tracked: number;
  markers: number;
  rmsPx: number;
  latencyMs: number;
  raw: Stats | null;
  filtered: Stats | null;
  /** RMS of the accelerometer around its mean, m/s² (null if the phone gave none) */
  accelRms: number | null;
  /** check-a2 only: the tip's mean distance to A2 in the sheet's plane and its height above it, mm */
  a2?: { planarMm: number; heightMm: number; distanceMm: number } | null;
}

export interface BenchRun {
  kind: typeof BENCH_KIND;
  v: typeof BENCH_VERSION;
  id: string;
  created: string;
  source: "camera" | "simulation";
  title: string;
  /** what held the phone: the printed dock, or a provisional mount */
  mount: string;
  phone: { id: string; name: string };
  calibration: { lens: boolean; dock: boolean };
  filter: Record<string, number | boolean>;
  /** how fast the tracker ran on this phone when the run was saved (frames/s, stage medians in ms) */
  tracker?: Record<string, number | { w: number; h: number }> | null;
  notes: string;
  samples: BenchSample[];
  accel: AccelSample[];
  summary: PhaseSummary[];
}

// ---------------- maths ----------------

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const angleDeg = (a: V3, b: V3) => (Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180) / Math.PI;
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const meanV = (vs: V3[]): V3 => {
  const s: V3 = [0, 0, 0];
  for (const v of vs) for (let i = 0; i < 3; i++) s[i] += v[i];
  return [s[0] / vs.length, s[1] / vs.length, s[2] / vs.length];
};
const rms = (xs: number[]) => (xs.length ? Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length) : 0);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const median = (xs: number[]) => pct(xs, 0.5);
const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

/** into the sheet (the drilling direction when square) */
export const SHEET_IN: V3 = [0, 0, -1];

/** A tool world transform (sheet = world, metres) as a bench pose (mm). */
export function toolPose(w: Xf): ToolPose {
  const tip = applyPoint(w, [0, 0, 0]);
  return { tip: [tip[0] * 1000, tip[1] * 1000, tip[2] * 1000], axis: norm(applyDir(w, [0, 0, 1])) };
}

/** Moving average over a time window (s), centred: the slow part of a signal. */
function movingMean(ts: number[], vs: V3[], win: number): V3[] {
  return vs.map((_, i) => {
    let lo = i, hi = i;
    while (lo > 0 && ts[i] - ts[lo - 1] <= win / 2) lo--;
    while (hi < vs.length - 1 && ts[hi + 1] - ts[i] <= win / 2) hi++;
    return meanV(vs.slice(lo, hi + 1));
  });
}

export function poseStats(ts: number[], ps: ToolPose[]): Stats | null {
  if (ps.length < 3) return null;
  const axes = ps.map((p) => p.axis), tips = ps.map((p) => p.tip);
  const meanAxis = norm(meanV(axes)), meanTip = meanV(tips);
  const ang = axes.map((a) => angleDeg(a, meanAxis));
  const slowA = movingMean(ts, axes, 0.5), slowT = movingMean(ts, tips, 0.5);
  return {
    n: ps.length,
    tiltDeg: round(angleDeg(meanAxis, SHEET_IN)),
    angleJitterDeg: round(rms(ang)),
    angleP95Deg: round(pct(ang, 0.95)),
    angleJitterHpDeg: round(rms(axes.map((a, i) => angleDeg(a, slowA[i])))),
    tipJitterMm: round(rms(tips.map((t) => dist(t, meanTip)))),
    tipJitterHpMm: round(rms(tips.map((t, i) => dist(t, slowT[i])))),
  };
}

export function summarize(phase: PhaseId, samples: BenchSample[], accel: AccelSample[]): PhaseSummary {
  const s = samples.filter((x) => x.phase === phase);
  const raw = s.filter((x) => x.raw), filt = s.filter((x) => x.filtered);
  const acc = accel.filter((x) => x.phase === phase).map((x) => x.a);
  const accMean = acc.length ? acc.reduce((a, b) => a + b, 0) / acc.length : 0;
  const out: PhaseSummary = {
    phase,
    frames: s.length,
    tracked: s.length ? round(raw.length / s.length, 3) : 0,
    markers: round(median(raw.map((x) => x.markers)), 1),
    rmsPx: round(median(raw.map((x) => x.rmsPx)), 3),
    latencyMs: round(median(s.map((x) => x.latencyMs)), 1),
    raw: poseStats(raw.map((x) => x.t), raw.map((x) => x.raw!)),
    filtered: poseStats(filt.map((x) => x.t), filt.map((x) => x.filtered!)),
    accelRms: acc.length > 10 ? round(rms(acc.map((a) => a - accMean)), 3) : null,
  };
  if (phase === "check-a2") {
    const tips = filt.map((x) => x.filtered!.tip);
    if (tips.length) {
      const m = meanV(tips);
      out.a2 = { planarMm: round(Math.hypot(m[0] - A2_MM[0], m[1] - A2_MM[1]), 2), heightMm: round(m[2], 2), distanceMm: round(dist(m, A2_MM), 2) };
    } else out.a2 = null;
  }
  return out;
}

// ---------------- recording ----------------

export class BenchRecorder {
  samples: BenchSample[] = [];
  accel: AccelSample[] = [];
  /** the phase being recorded, and until when (run time, s) */
  current: { phase: PhaseId; until: number } | null = null;
  /** the last couple of seconds, recording or not: the live readout */
  live: BenchSample[] = [];
  private t0: number | null = null;

  /** run time (s) from a clock in seconds */
  time(tNow: number) {
    if (this.t0 == null) this.t0 = tNow;
    return tNow - this.t0;
  }
  start(phase: PhaseId, tNow: number, seconds: number = PHASES[phase].seconds) {
    // a phase recorded again replaces the earlier take
    this.samples = this.samples.filter((s) => s.phase !== phase);
    this.accel = this.accel.filter((s) => s.phase !== phase);
    this.current = { phase, until: this.time(tNow) + seconds };
  }
  /** seconds left in the current phase (0 when idle) */
  remaining(tNow: number) {
    return this.current ? Math.max(0, this.current.until - this.time(tNow)) : 0;
  }
  add(tNow: number, s: Omit<BenchSample, "t" | "phase">) {
    const t = this.time(tNow);
    const sample = { t: round(t, 4), phase: this.current?.phase ?? "motor-off", ...s };
    this.live.push(sample);
    while (this.live.length && t - this.live[0].t > 2) this.live.shift();
    if (!this.current) return;
    if (t > this.current.until) {
      this.current = null;
      return;
    }
    this.samples.push(sample);
  }
  addAccel(tNow: number, a: number) {
    if (!this.current) return;
    const t = this.time(tNow);
    if (t <= this.current.until) this.accel.push({ t: round(t, 4), phase: this.current.phase, a: round(a, 4) });
  }
  recorded(): PhaseId[] {
    return (Object.keys(PHASES) as PhaseId[]).filter((p) => this.samples.some((s) => s.phase === p));
  }
  /** Stats of the last second: what the screen shows while you set up. */
  liveStats() {
    const last = this.live.filter((s) => s.t >= (this.live[this.live.length - 1]?.t ?? 0) - 1);
    const raw = last.filter((s) => s.raw), filt = last.filter((s) => s.filtered);
    const f = filt[filt.length - 1]?.filtered ?? null;
    return {
      tracked: last.length ? raw.length / last.length : 0,
      markers: raw[raw.length - 1]?.markers ?? 0,
      raw: poseStats(raw.map((s) => s.t), raw.map((s) => s.raw!)),
      filtered: poseStats(filt.map((s) => s.t), filt.map((s) => s.filtered!)),
      tiltDeg: f ? angleDeg(f.axis, SHEET_IN) : null,
      toA2Mm: f ? dist(f.tip, A2_MM) : null,
    };
  }
  finish(meta: Omit<BenchRun, "kind" | "v" | "samples" | "accel" | "summary" | "id" | "created"> & { id?: string; created?: string }): BenchRun {
    const phases = this.recorded();
    return {
      kind: BENCH_KIND,
      v: BENCH_VERSION,
      id: meta.id ?? globalThis.crypto?.randomUUID?.() ?? `bench-${Date.now().toString(36)}`,
      created: meta.created ?? new Date().toISOString(),
      ...meta,
      samples: this.samples,
      accel: this.accel,
      summary: phases.map((p) => summarize(p, this.samples, this.accel)),
    };
  }
}

/** The filtered tool pose from a snapshot, if the camera is measured now. */
export function filteredPose(s: EngineSnapshot | null, toolId: number, cameraId: number): ToolPose | null {
  if (!s) return null;
  const cam = s.nodes.find((n) => n.id === cameraId);
  const tool = s.nodes.find((n) => n.id === toolId);
  if (!cam || !tool || (cam.status !== "valid" && cam.status !== "predicted")) return null;
  return toolPose(tool.world);
}

export function isBenchRun(x: unknown): x is BenchRun {
  const r = x as Partial<BenchRun> | null;
  return !!r && r.kind === BENCH_KIND && r.v === BENCH_VERSION && Array.isArray(r.samples) && Array.isArray(r.summary);
}

// ---------------- published runs ----------------

const finiteDeep = (v: unknown, at: string, out: string[]) => {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) out.push(`summary: ${at} is not a finite number`);
  } else if (Array.isArray(v)) v.forEach((x, i) => finiteDeep(x, `${at}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) finiteDeep(x, at ? `${at}.${k}` : k, out);
};

/** One line per phase of a run: what scripts/bench-sim.mts and scripts/bench-add.mts print. */
export function phaseLine(s: PhaseSummary): string {
  const r = s.raw, f = s.filtered;
  return (
    `${s.phase.padEnd(10)} tracked ${(s.tracked * 100).toFixed(0)}% · angle jitter raw ${r?.angleJitterDeg.toFixed(3)}° filtered ${f?.angleJitterDeg.toFixed(3)}° · tip raw ${r?.tipJitterMm.toFixed(3)} filtered ${f?.tipJitterMm.toFixed(3)} mm` +
    (s.a2 ? ` · tip to A2 ${s.a2.distanceMm} mm` : "")
  );
}

/** Every problem of a run file, by name (empty when it can be published). */
export function checkBenchRun(x: unknown): string[] {
  const r = x as Partial<BenchRun> | null;
  if (!r || typeof r !== "object" || r.kind !== BENCH_KIND) return [`not a bench run (kind must be ${BENCH_KIND})`];
  const e: string[] = [];
  if (r.v !== BENCH_VERSION) e.push(`version ${String(r.v)}, expected ${BENCH_VERSION}`);
  if (typeof r.id !== "string" || !r.id) e.push("no id");
  if (typeof r.created !== "string" || Number.isNaN(Date.parse(r.created))) e.push("created is not a date");
  if (r.source !== "camera" && r.source !== "simulation") e.push(`source must be "camera" or "simulation", not ${JSON.stringify(r.source)}`);
  if (!Array.isArray(r.samples) || !r.samples.length) e.push("no samples");
  if (!Array.isArray(r.summary)) e.push("no summary");
  else {
    r.summary.forEach((s, i) => {
      if (!s || typeof s.phase !== "string" || !Object.hasOwn(PHASES, s.phase)) e.push(`summary ${i}: phase ${JSON.stringify(s?.phase)} does not exist`);
      finiteDeep(s, `${s?.phase ?? i}`, e);
    });
    if (r.source === "camera" && !r.summary.some((s) => s?.phase === "motor-off" || s?.phase === "motor-on")) e.push("a camera run needs a motor-off or a motor-on phase");
  }
  return e;
}

/** A run as listed in public/benchmarks/index.json. created: missing on the first published runs. */
export interface BenchIndexEntry {
  id: string;
  file: string;
  source: "camera" | "simulation";
  title: string;
  created?: string;
}
export interface BenchIndex {
  runs: BenchIndexEntry[];
}

/** The index with this entry in it (an entry with the same id is replaced): camera runs first, newest first, then
 * simulations, newest first. Entries without a date go after the dated ones of their kind, in the order they had. */
export function indexWith(index: BenchIndex, entry: BenchIndexEntry): BenchIndex {
  const runs = [...index.runs.filter((r) => r.id !== entry.id), entry];
  const at = (r: BenchIndexEntry) => (r.created ? Date.parse(r.created) : -Infinity);
  const order = runs.map((r, i) => ({ r, i }));
  order.sort((a, b) => Number(a.r.source !== "camera") - Number(b.r.source !== "camera") || at(b.r) - at(a.r) || a.i - b.i);
  return { runs: order.map((o) => o.r) };
}
