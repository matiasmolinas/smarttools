// Browser side of the navigation. Three independent loops on two threads (docs/ENGINE_SPEC.md §7, §11):
//   frame(source, tCapture)  — at the camera rate; the tracker runs in a Web Worker and its results
//                              are pushed to the engine as they arrive
//   advance(tWall)           — at 120 Hz (a timer), the engine's clock
//   view()                   — whenever the screen refreshes, the latest snapshot for the HUD
// It also keeps the calibrations (lens, dock) in localStorage and runs the calibration flows.

import { AR } from "./aruco";
import { BOARD_TARGETS, DICTIONARY } from "./board";
import { NavCore, cameraFromHfov, ENGINE_DEFAULTS, type Camera, type ToolCalib } from "./engine";
import { NavSession } from "./session";
import type { CaptureKind, CaptureResult } from "./markertracker";
import { TrackerClient, type WorkerResult } from "./trackerclient";
import type { Rig } from "./scene";
import type { Xf } from "./xform";
import type { Overlay } from "./hud";
import type { SimState } from "./sim";
import { hudView } from "./render/hudview";
import { DEFAULT_PHONE_ID, PHONES, phoneById, type PhoneProfile } from "./phones";
import { checkCalibration, dockRig } from "./dockrig";
import { smartToolsScene, toolLocal } from "./scenedef";
import { BenchRecorder, filteredPose, toolPose } from "./bench";
import type { DetectorKind } from "./detectors";
import { encodeRecording } from "./recording";
import { compose, fromPose, inverse } from "./xform";
import { SHEET_PLAN, planDepths, planTargets, tipOnSheet, type Mark, type Plan } from "./plan";
import { JobRecorder, defaultContext, type HoleRecord, type JobRecord, type TrackingSettings } from "./jobrecord";

export const DEFAULT_HFOV_DEG = 66; // typical phone main camera, long side
/** If a calibrated tip is further than this from what the phone profile predicts, warn (mm). */
const SANITY_MM = 15;
/** detection resolution (longest side, px): a phone setting, kept per device */
export const DETECT_SIDES = [640, 800, 960] as const;
const DEFAULT_SIDE = 960;

export type CalResult =
  | { kind: "camera"; ok: true; rmsPx: number; views: number }
  | { kind: "pivot"; ok: true; rmsMm: number }
  | { kind: "roll"; ok: true; tiltDeg: number; offProfileMm: number }
  | { kind: CaptureKind; ok: false; error: string };

export interface TrackerPerf {
  /** the detector in use, and (compare mode) the other one on the same frames */
  detector: DetectorKind;
  alt: { kind: string; detectMs: number; markers: number; cornerPx: number } | null;
  /** frames processed per second, and dropped because the tracker was still busy */
  fps: number;
  droppedPerS: number;
  /** medians over the last seconds, ms */
  bitmapMs: number;
  drawMs: number;
  detectMs: number;
  refineMs: number;
  poseMs: number;
  latencyMs: number;
  markers: number;
  /** what the camera gives and what the detector works on, px */
  video: { w: number; h: number };
  detect: { w: number; h: number };
}

const CAL_SECONDS: Record<CaptureKind, number> = { pivot: 5, roll: 5, camera: 20 };
const CAL_TEXT: Record<CaptureKind, string> = {
  pivot: "Tip on A2 · circle the drill",
  roll: "Tip on A2 · twist the drill",
  camera: "Move the phone over the sheet",
};

/** v2: calibrations saved before the iOS frame-scaling fix (v1) may have been measured on a mis-scaled image */
type Stored<T> = { v: 2; width: number; height: number; value: T; /** ISO time it was measured */ at?: string };

export class BrowserNav {
  readonly core: NavCore;
  session: NavSession | null = null;
  private client: TrackerClient | null = null;
  private size = { w: 0, h: 0 };
  private ending = false;
  /** which endCapture `ending` belongs to: an old one that settles late must not clear a newer one's flag */
  private endingSeq = 0;
  /** simulated frames rendered by the worker, for display */
  onSimImage: (img: ImageData) => void = () => {};
  /** frame px -> source px */
  private scale = 1;
  private cal: { step: CaptureKind; t0: number; until: number; then: CaptureKind | null } | null = null;
  private ephemeral = false;
  onMessage: (m: string) => void = () => {};
  /** The tracker worker failed for good: the page must show it (a phone has no console). */
  onFault: (message: string) => void = () => {};
  /** a calibration step finished: what it measured, or why it failed (for the guided setup) */
  onCalResult: (r: CalResult) => void = () => {};
  extraInfo: () => string = () => "";
  /** tracker frames processed, for the stats line */
  frames = 0;
  /** the phone in the dock; calibrations are stored per phone */
  phone: PhoneProfile = phoneById(readPhoneId());
  /** the plan being worked (the sheet's A1-A3 until one is chosen) */
  plan: Plan = SHEET_PLAN;
  /** the job in progress: every hole of the plan, as the engine measures it */
  recorder: JobRecorder | null = null;
  /** a hole was finished: the job so far, to keep as a draft (the page may die before the job is saved) */
  onJobProgress: (draft: JobRecord) => void = () => {};
  /** a hole was finished: that hole and the job so far (for its Check; also in the simulator when it records) */
  onHoleDone: (hole: HoleRecord, job: JobRecord) => void = () => {};
  /** the simulator records the job of this plan (recordInSimulator): never a draft, never saved */
  private simPlan: Plan | null = null;
  /** a job the page lost, to carry on with when the next job starts on its plan */
  private pendingResume: JobRecord | null = null;
  /** the bench lab (motor off / on): raw and filtered poses of every tracker frame, when open */
  bench: BenchRecorder | null = null;
  /** the engine's One Euro pose filter on (default) or off (raw poses on screen, for comparison) */
  filterOn = true;
  /** filter the tool's pose (at the tip) rather than the camera's (an option to evaluate; kept per device) */
  filterAtTool: boolean = readFlag("st-filter-tool");
  /** the angle tolerance (deg): the specification (0.5) or a wider one to practise by hand */
  tolDeg: number = readTol();
  /** detection resolution, longest side (px) */
  maxSide: number = readSide();
  /** the marker detector: js-aruco2 (default) or the Rust one; compare runs both on each frame */
  detector: DetectorKind = readDetector();
  compare = false;
  /** the camera options in use (set by the screen that opened the camera) */
  cameraOpts = { fps60: false, lock: false };
  private videoSize = { w: 0, h: 0 };
  private perfLog: { t: number; bitmapMs: number; drawMs: number; detectMs: number; refineMs: number; poseMs: number; latencyMs: number; markers: number; altMs: number; altMarkers: number; altCornerPx: number; altKind: string }[] = [];
  private droppedLog: { t: number; n: number }[] = [];

  private constructor(core: NavCore) {
    this.core = core;
  }
  static async create(): Promise<BrowserNav> {
    return new BrowserNav(await NavCore.load());
  }

  /** Simulation: a known calibration, nothing stored. */
  useCalibration(camera: Camera, tool: ToolCalib, width: number, height: number, t0: number) {
    this.ephemeral = true;
    this.size = { w: width, h: height };
    this.session?.dispose();
    this.session = new NavSession(this.core, new AR.Detector({ dictionaryName: DICTIONARY }), { camera, cameraCalibrated: true, tool, toolCalibrated: true, t0 });
    this.attachWorker(camera, true);
    this.applyFilter();
    this.recorder = null;
    this.startSimJob(t0);
  }

  /** Simulation only: record the job of `plan` (its holes must be the sheet's A1-A3, the simulator's scene), so the
   * live Checks can be seen. Its holes reach onHoleDone; nothing reaches onJobProgress and finishJob saves nothing. */
  recordInSimulator(plan: Plan) {
    this.simPlan = plan;
    this.plan = plan;
    if (this.session && this.ephemeral) this.startSimJob(performance.now() / 1000);
  }
  private startSimJob(t0: number) {
    const s = this.session, plan = this.simPlan;
    if (!s || !plan || !this.ephemeral) return;
    this.recorder = new JobRecorder(plan, defaultContext({ source: "simulation" }), (id) => (plan.holes.some((h) => h.label === s.name(id)) ? s.name(id) : undefined), {
      wall: (t) => Date.now() - (performance.now() / 1000 - t) * 1000,
      t0,
    });
  }

  private attachWorker(camera: Camera, calibrated: boolean) {
    this.client?.terminate();
    const c = new TrackerClient(camera, calibrated, this.maxSide, this.detector, this.compare);
    c.onResult = (r: WorkerResult) => this.onWorkerResult(r);
    c.onFatal = (m) => {
      if (this.client === c) this.onFault(m);
    };
    this.client = c;
  }

  private onWorkerResult(r: WorkerResult) {
    this.scale = r.scale;
    this.session?.pushTrackerFrame(r.frame);
    this.frames++;
    this.benchSample(r);
    const now = performance.now() / 1000;
    const tm = r.frame.timings;
    this.perfLog.push({
      t: now,
      bitmapMs: tm?.bitmapMs ?? 0,
      drawMs: tm?.drawMs ?? 0,
      detectMs: tm?.detectMs ?? 0,
      refineMs: tm?.refineMs ?? 0,
      poseMs: tm?.poseMs ?? 0,
      latencyMs: Math.max(0, (now - r.frame.tCapture) * 1000),
      markers: r.frame.markers,
      altMs: tm?.alt?.detectMs ?? NaN,
      altMarkers: tm?.alt?.markers ?? NaN,
      altCornerPx: tm?.alt?.meanCornerPx ?? NaN,
      altKind: tm?.alt?.kind ?? "",
    });
    this.droppedLog.push({ t: now, n: this.client?.dropped ?? 0 });
    while (this.perfLog.length && now - this.perfLog[0].t > 3) this.perfLog.shift();
    while (this.droppedLog.length && now - this.droppedLog[0].t > 3) this.droppedLog.shift();
    if (r.pixels) this.onSimImage(new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height));
  }

  /** frames dropped because the tracker was still busy */
  get dropped() {
    return this.client?.dropped ?? 0;
  }

  private ensureSession(w: number, h: number, t0: number) {
    if (this.session && (this.ephemeral || (this.size.w === w && this.size.h === h))) return this.session;
    this.size = { w, h };
    migrateLegacy(this.phone.id);
    const cam = load<Camera>(key("camera", this.phone.id), w, h, (c, k) => ({ ...c, f: c.f * k, cx: c.cx * k, cy: c.cy * k }));
    const tool = load<ToolCalib>(key("tool", this.phone.id), w, h, (t) => t);
    this.session?.dispose();
    const camera = cam ?? cameraFromHfov(w, h, DEFAULT_HFOV_DEG);
    // before calibrating, what the phone profile predicts at mid tilt (the gate stays closed anyway)
    const toolCal = tool ?? dockRig({ phone: this.phone, tiltDeg: 8 }).tool;
    this.session = new NavSession(this.core, new AR.Detector({ dictionaryName: DICTIONARY }), {
      camera,
      cameraCalibrated: !!cam,
      tool: toolCal,
      toolCalibrated: !!tool,
      scene: smartToolsScene({ tool: toolCal, targets: planTargets(this.plan) }),
      targetDepths: planDepths(this.plan),
      t0,
    });
    this.attachWorker(camera, !!cam);
    this.applyFilter();
    this.startJob(t0);
    return this.session;
  }

  get calibrated() {
    return { camera: !!this.session?.tracker.cameraCalibrated, tool: !!this.session?.toolCalibrated };
  }

  // ---------------- loop 1: frames (tracked in the worker) ----------------
  /** A frame from a <video> or <canvas>, captured at tCapture (s, performance.now() timebase).
   * Dropped if the tracker is still busy with the previous one. */
  frame(source: HTMLVideoElement | HTMLCanvasElement, tCapture: number) {
    const sw = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
    const sh = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
    if (!sw || !sh || (source instanceof HTMLVideoElement && source.readyState < 2)) return;
    const ds = Math.min(1, this.maxSide / Math.max(sw, sh));
    this.videoSize = { w: sw, h: sh };
    this.ensureSession(Math.round(sw * ds), Math.round(sh * ds), tCapture);
    void this.client?.frame(source, tCapture);
  }
  /** Simulation: the worker renders what the docked camera sees for this tool pose, then tracks it. */
  simFrame(rig: Rig, codes: Uint8Array, toolW: Xf, tCapture: number, seed: number) {
    this.client?.sim(rig, codes, toolW, tCapture, seed);
  }

  // ---------------- loop 2: the engine clock ----------------
  advance(tWall: number) {
    const s = this.session;
    if (!s) return 0;
    const n = s.advance(tWall);
    const r = this.recorder;
    if (n > 0 && s.snapshot && r) {
      const before = r.holes.length;
      r.feed(s.snapshot);
      if (r.holes.length > before) {
        const job = r.finish(tWall, this.trackingSettings());
        if (!this.ephemeral) this.onJobProgress(job);
        for (const h of r.holes.slice(before)) this.onHoleDone(h, job);
      }
    }
    this.stepCalibration(tWall);
    return n;
  }

  /** Where the calibrated tip (and a point 5 cm up the bit) fall in the camera image, in detection px.
   * The camera is fixed to the drill, so this never moves: it must sit on the real tip. */
  tipInImage(tool: ToolCalib | null = this.session?.tool ?? null): { tip: { x: number; y: number }; bit: { x: number; y: number } | null; inside: boolean } | null {
    const s = this.session;
    if (!s || !tool) return null;
    const cam = s.lastFrame?.camera ?? s.tracker.effectiveCamera;
    const id = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], rms: 0 } as unknown as Parameters<NavCore["projectPoints"]>[1];
    const up = [tool.tipCam[0] - tool.axisCam[0] * 0.05, tool.tipCam[1] - tool.axisCam[1] * 0.05, tool.tipCam[2] - tool.axisCam[2] * 0.05] as [number, number, number];
    const [tip, bit] = this.core.projectPoints(cam, id, [tool.tipCam, up]);
    if (!tip || tool.tipCam[2] <= 0) return null;
    const inside = tip.x >= 0 && tip.y >= 0 && tip.x <= this.size.w && tip.y <= this.size.h;
    return { tip, bit, inside };
  }

  // ---------------- for the guided setup ----------------
  /** The calibration in progress: which step, how far (0..1), frames captured. */
  calStatus(): { step: CaptureKind; progress: number; captured: number } | null {
    const c = this.cal, s = this.session;
    if (!c || !s?.snapshot) return null;
    return { step: c.step, progress: Math.min(1, (s.snapshot.t - c.t0) / CAL_SECONDS[c.step]), captured: s.tracker.captured };
  }
  /** What the camera sees now: markers, and where the calibrated tip is relative to A2. */
  liveCheck(): { markers: number; tracking: boolean; tipToA2Mm: number | null; tiltDeg: number | null } {
    const s = this.session, snap = s?.snapshot;
    if (!s || !snap) return { markers: 0, tracking: false, tipToA2Mm: null, tiltDeg: null };
    const nav = s.scene.def.navigation;
    const p = filteredPose(snap, s.id(nav.tool), s.id(nav.tracked));
    const a2 = BOARD_TARGETS.find((t) => t.label === "A2")!;
    const tracking = !!p && snap.markers > 0;
    return {
      markers: snap.markers,
      tracking,
      tipToA2Mm: p ? Math.hypot(p.tip[0] - a2.x * 1000, p.tip[1] - a2.y * 1000, p.tip[2]) : null,
      tiltDeg: p ? (Math.acos(Math.max(-1, Math.min(1, -p.axis[2]))) * 180) / Math.PI : null,
    };
  }

  // ---------------- tracker speed ----------------
  /** How fast the tracker runs on this phone, over the last 3 s (null before any frame). */
  perf(): TrackerPerf | null {
    const l = this.perfLog;
    if (l.length < 2) return null;
    const med = (k: Exclude<keyof (typeof l)[number], "altKind">) => {
      const v = l.map((x) => x[k]).filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
      return v.length ? v[Math.floor(v.length / 2)] : NaN;
    };
    const altKind = l[l.length - 1].altKind;
    const span = Math.max(1e-3, l[l.length - 1].t - l[0].t);
    const d = this.droppedLog;
    const dropped = d.length > 1 ? (d[d.length - 1].n - d[0].n) / Math.max(1e-3, d[d.length - 1].t - d[0].t) : 0;
    return {
      detector: this.detector,
      alt: altKind ? { kind: altKind, detectMs: med("altMs"), markers: med("altMarkers"), cornerPx: med("altCornerPx") } : null,
      fps: (l.length - 1) / span,
      droppedPerS: dropped,
      bitmapMs: med("bitmapMs"),
      drawMs: med("drawMs"),
      detectMs: med("detectMs"),
      refineMs: med("refineMs"),
      poseMs: med("poseMs"),
      latencyMs: med("latencyMs"),
      markers: med("markers"),
      video: this.videoSize,
      detect: { w: Math.round(this.size.w), h: Math.round(this.size.h) },
    };
  }
  /** Record about `seconds` of camera frames as the tracker sees them, with the calibration in use: a .strec
   * file to analyse again on a laptop (scripts/replay.mts). Null if there is nothing to record, or it was cancelled
   * (cancelRecording, the tracker stopped, or no frames came for 3 × `seconds`). */
  async record(seconds: number, notes = ""): Promise<Blob | null> {
    const c = this.client, s = this.session;
    if (!c || !s) return null;
    const fps = Math.max(5, Math.min(60, this.perf()?.fps ?? 30));
    // a safety net: frames that stop coming (camera off, worker stuck) must not leave the recording open forever
    const timer = setTimeout(() => c.cancelRecord(), seconds * 3 * 1000);
    const r = await c.record(Math.round(seconds * fps)).finally(() => clearTimeout(timer));
    if (!r) return null;
    const cal = this.calibrated;
    return encodeRecording(
      {
        kind: "smarttools-recording",
        v: 1,
        created: new Date().toISOString(),
        phone: { id: this.phone.id, name: this.phone.name },
        width: r.width,
        height: r.height,
        video: this.videoSize,
        camera: s.lastFrame?.camera ?? s.tracker.effectiveCamera,
        cameraCalibrated: cal.camera,
        tool: s.tool,
        toolCalibrated: cal.tool,
        detector: this.detector,
        notes,
        times: r.times,
      },
      r.frames,
    );
  }

  /** Stop a recording in progress: its record() returns null. */
  cancelRecording() {
    this.client?.cancelRecord();
  }

  /** Choose the marker detector (kept per device), and whether to run the other one alongside to compare. */
  setDetector(kind: DetectorKind, compare = this.compare) {
    this.detector = kind;
    this.compare = compare;
    try {
      localStorage.setItem("st-detector", kind);
    } catch {}
    this.perfLog = [];
    this.client?.setDetector(kind, compare);
  }
  /** Change the detection resolution (the session restarts at the new size; calibrations are rescaled). */
  setMaxSide(side: number) {
    this.maxSide = side;
    try {
      localStorage.setItem("st-detect-side", String(side));
    } catch {}
    this.perfLog = [];
    this.droppedLog = [];
    this.forgetCalibrationSilently();
  }

  // ---------------- the bench lab ----------------
  private benchSample(r: WorkerResult) {
    const b = this.bench, s = this.session;
    if (!b || !s) return;
    const f = r.frame;
    const now = performance.now() / 1000;
    // raw: this frame's marker pose and the tool calibration, nothing else (sheet = world)
    const raw = f.pose ? toolPose(compose(inverse(fromPose(f.pose)), toolLocal(s.tool))) : null;
    const nav = s.scene.def.navigation;
    const filtered = filteredPose(s.snapshot, s.id(nav.tool), s.id(nav.tracked));
    b.add(now, { raw, filtered, markers: f.markers, rmsPx: f.rmsPx ?? 0, latencyMs: Math.max(0, (now - f.tCapture) * 1000) });
  }
  /** The engine's pose filter: on (One Euro, the default) or off (every frame as measured). */
  setFilter(on: boolean) {
    this.filterOn = on;
    this.applyFilter();
  }
  /** Open the bench lab: samples are recorded, and prediction is turned off so that the "filtered" pose is
   * the one the gate decides with (filtered, not extrapolated to the display time). */
  openBench(on: boolean) {
    this.bench = on ? (this.bench ?? new BenchRecorder()) : null;
    this.applyFilter();
  }
  filterConfig() {
    const d = ENGINE_DEFAULTS;
    const predict = d.predict && !this.bench;
    const filterAtTool = this.filterAtTool;
    return this.filterOn
      ? { posMinCutoff: d.posMinCutoff, posBeta: d.posBeta, rotMinCutoff: d.rotMinCutoff, rotBeta: d.rotBeta, dCutoff: d.dCutoff, predict, filterAtTool }
      : // a cutoff far above the camera rate: the filter passes every measurement through
        { posMinCutoff: 1000, posBeta: 0, rotMinCutoff: 1000, rotBeta: 0, dCutoff: d.dCutoff, predict, filterAtTool };
  }
  private applyFilter() {
    // one configuration: the pose filter and the angle tolerance (configure fills the rest with defaults)
    const tol = this.tolDeg;
    this.session?.engine.configure({ ...this.filterConfig(), requirementAngleDeg: tol, limits: { ...ENGINE_DEFAULTS.limits, maxAngleDeg: tol * 0.8 } });
  }
  /** Filter at the tip (true) or at the camera (false, the default). Kept per device. */
  setFilterAtTool(on: boolean) {
    this.filterAtTool = on;
    try {
      localStorage.setItem("st-filter-tool", on ? "1" : "0");
    } catch {}
    this.applyFilter();
  }
  /** Angle tolerance: 0.5° (the specification) or wider to practise by hand. Kept per device. */
  setTolerance(deg: number) {
    this.tolDeg = deg;
    try {
      localStorage.setItem("st-tol", String(deg));
    } catch {}
    this.applyFilter();
  }

  // ---------------- plans and jobs ----------------
  /** Work a plan (validated by the caller, lib/memory). The session is rebuilt with its holes. */
  setPlan(plan: Plan) {
    this.plan = plan;
    this.forgetCalibrationSilently();
  }
  /** Where the tip touches the sheet now, to mark a hole (planning with the tool as a pointer). */
  markHere(): Mark {
    const s = this.session;
    if (!s) return { ok: false, reason: "Point the camera at the sheet" };
    if (!s.toolCalibrated) return { ok: false, reason: "Calibrate first" };
    const nav = s.scene.def.navigation;
    return tipOnSheet(s.snapshot, s.id(nav.tool), s.id(nav.tracked));
  }
  /** Carry on with a job the page lost (a draft), once, if it is the plan being worked; null drops it. If a
   * session already runs, its job is replaced now. The engine is not told which holes are done (it has no call
   * for that): it may guide to one again, and the recorder ignores a hole it already has. */
  resumeJob(draft: JobRecord | null) {
    this.pendingResume = draft;
    if (draft && this.session && !this.ephemeral) this.startJob(performance.now() / 1000);
  }
  private startJob(t0: number) {
    const s = this.session;
    if (!s || this.ephemeral) return;
    const resume = this.pendingResume?.plan.id === this.plan.id ? this.pendingResume : undefined;
    this.pendingResume = null;
    const c = this.calibrated;
    // engine time is performance.now() in seconds; map it to the wall clock when asked
    const wall = (t: number) => Date.now() - (performance.now() / 1000 - t) * 1000;
    this.recorder = new JobRecorder(
      this.plan,
      defaultContext({ phone: { id: this.phone.id, name: this.phone.name, provisional: this.phone.provisional }, calibration: { lens: c.camera, dock: c.tool }, source: "camera" }),
      (id) => (this.plan.holes.some((h) => h.label === s.name(id)) ? s.name(id) : undefined),
      { wall, t0, resume },
    );
  }
  /** The person's answer to a recipe step (its statement id): kept with the job, and the draft is written again.
   * Nothing happens without a job in progress. */
  confirmStep(id: string, ok: boolean) {
    const r = this.recorder;
    if (!r) return;
    r.confirm(id, ok);
    if (!this.ephemeral) this.onJobProgress(r.finish(performance.now() / 1000, this.trackingSettings()));
  }
  /** The job so far (null without one in progress): for the Checks on screen. */
  jobSoFar(): JobRecord | null {
    return this.recorder?.finish(performance.now() / 1000, this.trackingSettings()) ?? null;
  }
  /** How the phone is tracking now: recorded with each job, so jobs can be compared by setting. */
  trackingSettings(): TrackingSettings {
    return { detector: this.detector, filter: !this.filterOn ? "off" : this.filterAtTool ? "tip" : "camera", detectPx: this.maxSide, camera: { ...this.cameraOpts } };
  }
  /** End the job: its record (null if no hole was drilled), and a fresh job on the same plan. */
  finishJob(): JobRecord | null {
    const r = this.recorder, s = this.session;
    if (!r || !s) return null;
    // the simulator's job is never saved: it starts again, and there is no record to keep
    const rec = r.holes.length && !this.ephemeral ? r.finish(performance.now() / 1000, this.trackingSettings()) : null;
    s.engine.resetJob();
    if (this.ephemeral) this.startSimJob(performance.now() / 1000);
    else this.startJob(performance.now() / 1000);
    return rec;
  }

  // ---------------- loop 3: what to draw ----------------
  view(): { state: SimState; overlay: Overlay } | null {
    const s = this.session;
    const snap = s?.snapshot;
    if (!s || !snap) return null;
    const pts = s.overlayPoints();
    const c = this.calibrated;
    const lf = s.lastFrame;
    const cal = this.cal;
    return hudView({
      def: s.scene.def,
      ids: s.scene.ids,
      snapshot: snap,
      image: (() => {
        const ti = c.tool ? this.tipInImage() : null;
        return { aim: pts.aim, mark: pts.mark, quads: lf?.quads ?? [], scale: this.scale, tip: ti?.tip ?? null, bit: ti?.bit ?? null };
      })(),
      info: `${snap.markers} tags · ${c.camera ? "lens ✓" : `f ${Math.round(lf?.focalPx ?? 0)}${lf?.focalLocked ? "" : "?"}`} · ${c.tool ? "dock ✓" : "dock ?"} · ${Math.round(snap.stats.latencyS * 1000)} ms${this.extraInfo()}`,
      calibrating: cal ? { text: CAL_TEXT[cal.step], progress: Math.min(1, (snap.t - cal.t0) / CAL_SECONDS[cal.step]), count: s.tracker.captured } : null,
      limits: { ...ENGINE_DEFAULTS.limits, maxAngleDeg: this.tolDeg * 0.8 },
      tolDeg: this.tolDeg,
    });
  }

  // ---------------- calibration flows ----------------
  startToolCalibration(t: number) {
    if (!this.session) return;
    this.client?.beginCapture("pivot");
    this.cal = { step: "pivot", t0: t, until: t + CAL_SECONDS.pivot, then: "roll" };
  }
  startCameraCalibration(t: number) {
    if (!this.session) return;
    this.client?.beginCapture("camera");
    this.cal = { step: "camera", t0: t, until: t + CAL_SECONDS.camera, then: null };
  }
  cancelCalibration() {
    this.client?.cancelCapture();
    this.cal = null;
    this.ending = false;
  }
  /** Stop the worker and free the engine without touching stored calibrations. */
  forgetCalibrationSilently() {
    this.session?.dispose();
    this.session = null;
    this.recorder = null;
    this.client?.terminate();
    this.client = null;
    this.cal = null;
    this.ending = false;
  }
  /** Switch phones: its own calibrations are loaded on the next frame. */
  setPhone(id: string) {
    this.phone = phoneById(id);
    try {
      localStorage.setItem("st-phone", this.phone.id);
    } catch {}
    this.forgetCalibrationSilently();
  }
  nextPhone() {
    const i = PHONES.findIndex((p) => p.id === this.phone.id);
    this.setPhone(PHONES[(i + 1) % PHONES.length].id);
    return this.phone;
  }

  /** This phone's profile and calibrations as JSON (to keep, share or move to another browser). */
  exportProfile(): string {
    const read = (k: string) => {
      try {
        return JSON.parse(localStorage.getItem(k) ?? "null");
      } catch {
        return null;
      }
    };
    return JSON.stringify({ kind: "smarttools-phone", v: 1, phone: this.phone, camera: read(key("camera", this.phone.id)), tool: read(key("tool", this.phone.id)), exported: new Date().toISOString() }, null, 2);
  }
  importProfile(json: string): string {
    const d = JSON.parse(json);
    if (d?.kind !== "smarttools-phone" || !d.phone?.id) throw new Error("not a SmartTools phone file");
    try {
      if (d.camera) localStorage.setItem(key("camera", d.phone.id), JSON.stringify(d.camera));
      if (d.tool) localStorage.setItem(key("tool", d.phone.id), JSON.stringify(d.tool));
    } catch {}
    this.setPhone(d.phone.id);
    return phoneById(d.phone.id).name;
  }

  /** When this phone's drill calibration was measured (null if none, or saved before times were kept). */
  toolCalibratedAt(): string | null {
    try {
      const s = JSON.parse(localStorage.getItem(key("tool", this.phone.id)) ?? "null") as Stored<unknown> | null;
      return s?.v === 2 ? (s.at ?? null) : null;
    } catch {
      return null;
    }
  }
  /** Drop the drill calibration only (the bit or the phone's seat changed); the lens stays. */
  forgetDrillCalibration() {
    try {
      localStorage.removeItem(key("tool", this.phone.id));
    } catch {}
    this.forgetCalibrationSilently();
  }

  forgetCalibration() {
    try {
      localStorage.removeItem(key("camera", this.phone.id));
      localStorage.removeItem(key("tool", this.phone.id));
    } catch {}
    this.session?.dispose();
    this.session = null;
    this.recorder = null;
    this.client?.terminate();
    this.client = null;
    this.cal = null;
    this.ending = false;
  }
  private stepCalibration(t: number) {
    const c = this.cal, s = this.session;
    if (!c || !s || !this.client || t < c.until || this.ending) return;
    this.ending = true;
    const seq = ++this.endingSeq;
    this.client
      .endCapture(s.tool)
      .then((r) => {
        // cancelled, replaced or the engine restarted while it was computed: the result belongs to nobody
        if (this.cal !== c || this.session !== s) return;
        this.finishStep(c, s, r, performance.now() / 1000);
      })
      .finally(() => {
        if (this.endingSeq === seq) this.ending = false;
      });
  }
  private finishStep(c: NonNullable<BrowserNav["cal"]>, s: NavSession, r0: CaptureResult, t: number) {
    // a tip that would sit outside the camera image (or behind it) cannot be the real tip: refuse it
    if ("tipCam" in r0) {
      const where = this.tipInImage({ ...s.tool, tipCam: r0.tipCam });
      if (!where || !where.inside) {
        const error = "the tip ended up outside the image: keep the tip still on A2 and circle slowly";
        this.onMessage(error.toUpperCase());
        this.onCalResult({ kind: "pivot", ok: false, error });
        this.client?.cancelCapture();
        this.cal = null;
        return;
      }
    }
    const r = s.applyCapture(r0);
    if ("camera" in r) this.client?.setCamera(r.camera, true);
    if ("error" in r) {
      this.onMessage(r.error.toUpperCase());
      this.onCalResult({ kind: c.step, ok: false, error: r.error });
      this.cal = null;
      return;
    }
    if ("camera" in r) {
      if (!this.ephemeral) save(key("camera", this.phone.id), this.size, r.camera);
      this.onMessage(`LENS OK · ${r.views} VIEWS · ${r.rms.toFixed(2)} PX`);
      this.onCalResult({ kind: "camera", ok: true, rmsPx: r.rms, views: r.views });
    }
    if ("tipCam" in r) {
      this.onMessage(`TIP OK · ${r.rmsMm.toFixed(2)} MM`);
      this.onCalResult({ kind: "pivot", ok: true, rmsMm: r.rmsMm });
    }
    if ("axisCam" in r) {
      if (!this.ephemeral) save(key("tool", this.phone.id), this.size, s.tool);
      // sanity check against the phone profile and the dock's geometry
      const chk = checkCalibration(s.tool, { phone: this.phone });
      this.onCalResult({ kind: "roll", ok: true, tiltDeg: chk.tiltDeg, offProfileMm: chk.distanceMm });
      this.onMessage(
        chk.distanceMm > SANITY_MM
          ? `CHECK THE PHONE: TIP ${Math.round(chk.distanceMm)} MM FROM THE ${this.phone.name.toUpperCase()} PROFILE`
          : `DOCK CALIBRATED · TILT ≈ ${chk.tiltDeg.toFixed(0)}°`,
      );
    }
    if (c.then) {
      this.client?.beginCapture(c.then);
      this.cal = { step: c.then, t0: t, until: t + CAL_SECONDS[c.then], then: null };
    } else this.cal = null;
  }
}

function load<T>(key: string, w: number, h: number, rescale: (v: T, k: number) => T): T | null {
  try {
    const s = JSON.parse(localStorage.getItem(key) ?? "null") as Stored<T> | null;
    if (!s || s.v !== 2) return null;
    const k = w / s.width;
    if (Math.abs(h / s.height - k) > 0.01) return null;
    return rescale(s.value, k);
  } catch {
    return null;
  }
}
function save<T>(key: string, size: { w: number; h: number }, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify({ v: 2, width: size.w, height: size.h, value, at: new Date().toISOString() } satisfies Stored<T>));
  } catch {}
}

const key = (what: "camera" | "tool", phoneId: string) => `st-${what}:${phoneId}`;
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function readDetector(): DetectorKind {
  try {
    return localStorage.getItem("st-detector") === "rust" ? "rust" : "js";
  } catch {
    return "js";
  }
}
function readTol(): number {
  try {
    const v = Number(localStorage.getItem("st-tol"));
    return v === 2 ? 2 : 0.5;
  } catch {
    return 0.5;
  }
}
function readSide(): number {
  try {
    const v = Number(localStorage.getItem("st-detect-side"));
    return (DETECT_SIDES as readonly number[]).includes(v) ? v : DEFAULT_SIDE;
  } catch {
    return DEFAULT_SIDE;
  }
}
function readPhoneId(): string {
  try {
    return localStorage.getItem("st-phone") ?? DEFAULT_PHONE_ID;
  } catch {
    return DEFAULT_PHONE_ID;
  }
}
/** Calibrations saved before phone profiles existed belong to the phone in use. */
function migrateLegacy(phoneId: string) {
  try {
    for (const w of ["camera", "tool"] as const) {
      const old = localStorage.getItem(`st-${w}`);
      if (old && !localStorage.getItem(key(w, phoneId))) localStorage.setItem(key(w, phoneId), old);
      localStorage.removeItem(`st-${w}`);
    }
  } catch {}
}
