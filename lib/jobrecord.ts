// The job recorder (docs/ARCHITECTURE.md §3, "Job record"): fed with the engine's snapshots while a plan is
// worked, it keeps every hole's depth and angle as the engine measured them, and when the job ends it builds
// the job record: the plan, the report (graded, lib/report.ts) and what produced it (engine, phone,
// calibration). lib/ledger.ts turns a record into an agentvcs ledger.

import { ALARMS, ENGINE_ABI, type EngineSnapshot } from "./engine.ts";
import { scoreScrew, type ScrewSample } from "./coach.ts";
import { buildReport, type JobReport, type ScrewRecord } from "./report.ts";
import type { Plan } from "./plan.ts";

export const JOB_KIND = "smarttools-job";
export const JOB_VERSION = 1;
export const APP_VERSION = "0.0.14";

/** What runs, for the screen: "SmartTools 0.0.13 · build abc1234 · engine ABI 6". An empty build reads "dev". */
export function versionLine(build: string | undefined, abi: number = ENGINE_ABI, app: string = APP_VERSION): string {
  return `SmartTools ${app} · build ${build?.trim() || "dev"} · engine ABI ${abi}`;
}

export interface HoleRecord extends ScrewRecord {
  startedAt: string;
  endedAt: string;
  score: number | null;
}

/** The person's answer to a recipe step the engine cannot measure. id: the statement id. */
export interface Confirmation {
  id: string;
  ok: boolean;
  at: string;
}

export interface JobRecord {
  kind: typeof JOB_KIND;
  v: typeof JOB_VERSION;
  id: string;
  started: string;
  ended: string;
  status: "completed" | "aborted";
  plan: Plan;
  report: JobReport;
  holes: HoleRecord[];
  /** the person's answers to the recipe's steps the engine cannot measure (hole Checks are recomputed, not kept) */
  confirmations?: Confirmation[];
  /** what produced the measurements: the ledger's manifest is built from this */
  context: {
    app: string;
    engineAbi: number;
    phone: { id: string; name: string; provisional: boolean };
    calibration: { lens: boolean; dock: boolean };
    /** "camera" = a real job; "simulation" = the demo or a test */
    source: "camera" | "simulation";
    /** how the phone tracked during the job (the alternatives under evaluation): what blame compares */
    tracking?: TrackingSettings;
  };
}

export interface TrackingSettings {
  detector: string;
  /** the One Euro filter: off, at the camera, at the tool's tip */
  filter: "off" | "camera" | "tip";
  /** detection resolution, longest side, px */
  detectPx: number;
  camera: { fps60: boolean; lock: boolean };
}

type Ctx = JobRecord["context"];
const iso = (ms: number) => new Date(ms).toISOString();

export class JobRecorder {
  readonly plan: Plan;
  readonly context: Ctx;
  readonly id: string;
  /** engine time (s) -> wall clock (ms) */
  private readonly wall: (t: number) => number;
  private readonly startedMs: number;
  private samples = new Map<string, ScrewSample[]>();
  private seated = new Map<string, number>();
  private flags = new Map<string, string>();
  private firstT = new Map<string, number>();
  private done: HoleRecord[] = [];
  private answers: Confirmation[] = [];
  private labelOf: (id: number) => string | undefined;

  /** wall: engine time (s) to wall-clock ms (defaults to "now"); t0: the engine time the job starts at;
   * resume: a job the page lost (a draft): its id, start time and the holes that are in this plan carry on */
  constructor(plan: Plan, context: Ctx, labelOf: (nodeId: number) => string | undefined, o: { wall?: (t: number) => number; t0?: number; resume?: JobRecord } = {}) {
    this.plan = plan;
    this.context = context;
    this.labelOf = labelOf;
    this.wall = o.wall ?? (() => Date.now());
    const r = o.resume;
    const resumedMs = r ? Date.parse(r.started) : NaN;
    this.startedMs = Number.isFinite(resumedMs) ? resumedMs : o.t0 != null ? this.wall(o.t0) : Date.now();
    this.id = r?.id ?? globalThis.crypto?.randomUUID?.() ?? `job-${Date.now().toString(36)}`;
    if (r) this.done = resumableHoles(r, plan).map((h) => ({ ...h }));
    if (r?.confirmations) for (const c of r.confirmations) this.confirm(c.id, c.ok, c.at);
  }

  /** Feed one snapshot (each one once). */
  feed(s: EngineSnapshot) {
    const tgt = s.active >= 0 ? s.targets[s.active] : null;
    const label = tgt ? this.labelOf(tgt.id) : undefined;
    if (tgt && label && !this.done.some((h) => h.name === label)) {
      const l = this.samples.get(label) ?? [];
      l.push({ t: s.t, phase: s.phase, angleDeg: tgt.angleErrDeg, offsetMm: tgt.offsetMm, depthMm: tgt.depthMm });
      this.samples.set(label, l);
      if (!this.firstT.has(label)) this.firstT.set(label, s.t);
      if (s.phase === "drill" && !this.flags.has(label)) {
        if (s.alarms & ALARMS.ANGLE) this.flags.set(label, "angle alarm while drilling");
        else if (s.alarms & ALARMS.KEEP_OUT) this.flags.set(label, "no-go zone");
      }
    }
    for (const e of s.events) {
      const name = this.labelOf(e.node);
      if (!name) continue;
      if (e.kind === "depth-reached") this.seated.set(name, e.value);
      if (e.kind === "drilled") this.close(name, s.t);
    }
  }

  private close(name: string, t: number) {
    if (this.done.some((h) => h.name === name)) return;
    const hole = this.plan.holes.find((h) => h.label === name);
    if (!hole) return;
    const samples = this.samples.get(name) ?? [];
    const sc = scoreScrew(samples);
    const drilling = samples.filter((x) => x.phase === "drill" || x.phase === "hold");
    const maxAngle = sc?.maxAngleDeg ?? Math.max(0, ...drilling.map((x) => x.angleDeg));
    const seatedMm = this.seated.get(name) ?? Math.max(0, ...samples.map((x) => x.depthMm));
    const flagged = this.flags.get(name) ?? (seatedMm > hole.depthMm + 2 ? "too deep" : undefined);
    this.done.push({
      name,
      face: "sheet",
      size: `Ø${hole.diameterMm} mm`,
      plannedMm: hole.depthMm,
      seatedMm: round2(seatedMm),
      maxAngleDeg: round2(maxAngle),
      ...(flagged ? { flagged } : {}),
      startedAt: iso(this.wall(this.firstT.get(name) ?? t)),
      endedAt: iso(this.wall(t)),
      score: sc?.score ?? null,
    });
  }

  /** Holes finished so far. */
  get holes(): readonly HoleRecord[] {
    return this.done;
  }

  /** The person's answer to a recipe step (its statement id): one per step, a new answer replaces the old one. */
  confirm(id: string, ok: boolean, at = new Date().toISOString()) {
    this.answers = [...this.answers.filter((c) => c.id !== id), { id, ok, at }];
  }

  /** The answers so far, in the order they were last given. */
  get confirmations(): readonly Confirmation[] {
    return this.answers;
  }

  finish(endT?: number, tracking?: TrackingSettings): JobRecord {
    const ended = endT == null ? Date.now() : this.wall(endT);
    const status = this.done.length >= this.plan.holes.length ? "completed" : "aborted";
    const report = buildReport(this.plan.name, this.done, this.plan.holes.length, iso(ended));
    return { kind: JOB_KIND, v: JOB_VERSION, id: this.id, started: iso(this.startedMs), ended: iso(ended), status, plan: this.plan, report, holes: [...this.done], ...(this.answers.length ? { confirmations: this.answers.map((c) => ({ ...c })) } : {}), context: tracking ? { ...this.context, tracking } : this.context };
  }
}

/** The holes of a draft that belong to this plan (by name), each once. */
export function resumableHoles(draft: JobRecord, plan: Plan): HoleRecord[] {
  const out: HoleRecord[] = [];
  for (const h of draft.holes) if (plan.holes.some((p) => p.label === h.name) && !out.some((o) => o.name === h.name)) out.push(h);
  return out;
}

/** What to do with a draft found at start (the page died mid-job): carry on with it when it is the plan being
 * worked and has holes in it, keep it as an unfinished job when it is another plan, drop it when it is empty. */
export function draftAction(draft: JobRecord | null, plan: Plan): "none" | "resume" | "save" {
  if (!draft || !draft.holes.length) return "none";
  if (draft.plan.id === plan.id && resumableHoles(draft, plan).length) return "resume";
  return "save";
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export const defaultContext = (over: Partial<Ctx> = {}): Ctx => ({
  app: APP_VERSION,
  engineAbi: ENGINE_ABI,
  phone: { id: "unknown", name: "unknown", provisional: true },
  calibration: { lens: false, dock: false },
  source: "camera",
  ...over,
});
