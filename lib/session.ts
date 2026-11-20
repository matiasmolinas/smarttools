// A navigation session: the marker tracker produces measurements, the engine (Rust, WASM) owns the
// clock, the scene graph and every decision, and renderers read snapshots. The same class runs on
// the phone (/hud), in the browser lab (/engine) and in the end-to-end tests (scripts/e2e.mts).
//
//   camera frames ──► MarkerTracker ──► measurement (T_camera_sheet, t_capture)
//                                            │ push
//   wall clock ────────────────────────► Engine.advance(t) ── ticks at 120 Hz
//                                            │
//   renderers (3D, 2D plan, HUD) ◄─ snapshot ┘  as often as they can, or never (headless)

import type { MarkerBody } from "./anchors.ts";
import type { Camera, EngineConfig, EngineSnapshot, NavCore, ToolCalib } from "./engine.ts";
import { GATE_REASONS } from "./engine.ts";
import { MarkerTracker, type CaptureKind, type CaptureResult, type Detector, type Rgba, type TrackerFrame } from "./markertracker.ts";
import { buildEngine, smartToolsScene, toolLocal, type BuiltScene, type SceneDef } from "./scenedef.ts";
import { applyPoint, compose, fromPose, inverse, toPose, type Xf } from "./xform.ts";
import type { V3 } from "./pose.ts";

type P = { x: number; y: number };

/** The requirement promised to the user; the engine's gate is stricter by the measured margin. */
export const REQUIREMENT = { angleDeg: 0.5, offsetMm: 1.0 };

export interface SessionOptions {
  camera: Camera;
  cameraCalibrated: boolean;
  tool: ToolCalib;
  toolCalibrated: boolean;
  engine?: Partial<EngineConfig>;
  /** defaults to the SmartTools A4 job */
  scene?: SceneDef;
  /** markers on parts to track (factory markers, or stickers learned on a located part) */
  bodies?: MarkerBody[];
  /** depth to reach per target (mm), in the scene's navigation order (screws seat at their own depth) */
  targetDepths?: number[];
  t0?: number;
}

export class NavSession {
  readonly core: NavCore;
  readonly tracker: MarkerTracker;
  readonly scene: BuiltScene;
  tool: ToolCalib;
  toolCalibrated: boolean;
  /** last tracker output (for overlays) */
  lastFrame: TrackerFrame | null = null;
  private snap: EngineSnapshot | null = null;
  private pendingEvents: EngineSnapshot["events"] = [];

  constructor(core: NavCore, detector: Detector, o: SessionOptions) {
    this.core = core;
    this.tool = o.tool;
    this.toolCalibrated = o.toolCalibrated;
    this.tracker = new MarkerTracker(core, detector, o.camera, o.cameraCalibrated);
    if (o.bodies) this.tracker.setBodies(o.bodies);
    const engine = core.createEngine();
    if (o.engine) engine.configure(o.engine);
    this.scene = buildEngine(engine, o.scene ?? smartToolsScene({ tool: o.tool }));
    if (o.targetDepths) engine.setTargetDepths(o.targetDepths);
    engine.setCalibrated(this.id(this.scene.def.navigation.tool), o.toolCalibrated);
    engine.start(o.t0 ?? 0);
  }

  get engine() {
    return this.scene.engine;
  }
  id(name: string): number {
    const v = this.scene.ids[name];
    if (v == null) throw new Error(`no node "${name}"`);
    return v;
  }
  name(id: number): string {
    return this.scene.names[id] ?? `#${id}`;
  }

  dispose() {
    this.engine.free();
  }

  /** A camera frame captured at tCapture: track it here and hand the measurement to the engine. */
  frame(img: Rgba, tCapture: number): TrackerFrame {
    const f = this.tracker.frame(img, tCapture);
    this.pushTrackerFrame(f);
    return f;
  }

  /** A tracker result computed elsewhere (a Web Worker): hand its measurement to the engine. */
  pushTrackerFrame(f: TrackerFrame) {
    this.lastFrame = f;
    const nav = this.scene.def.navigation;
    if (f.pose) this.engine.push(this.id(nav.tracked), this.id(nav.reference), fromPose(f.pose), f.tCapture, f.markers, f.rmsPx);
    // markers on parts: the camera against each part's body node (the engine places the part, or the
    // camera from the part when the sheet is not seen)
    for (const b of f.bodies ?? []) {
      const id = this.scene.ids[b.name];
      if (id != null) this.engine.push(this.id(nav.tracked), id, fromPose(b.pose), f.tCapture, b.markers, b.rmsPx);
    }
  }

  /** Run the engine up to the wall-clock time; returns the ticks run. */
  advance(tWall: number): number {
    const n = this.engine.advance(tWall);
    if (n > 0 || !this.snap) {
      this.snap = this.engine.snapshot();
      this.pendingEvents.push(...this.snap.events);
    }
    return n;
  }

  /** The latest snapshot (null before the first tick). */
  get snapshot(): EngineSnapshot | null {
    return this.snap;
  }
  /** Events since the last call. */
  takeEvents() {
    const e = this.pendingEvents;
    this.pendingEvents = [];
    return e;
  }

  // ---------------- calibration ----------------
  beginCapture(kind: CaptureKind) {
    this.tracker.beginCapture(kind);
  }
  cancelCapture() {
    this.tracker.cancelCapture();
  }
  /** Finish a capture; dock results update the tool node in the engine. */
  endCapture(): CaptureResult {
    return this.applyCapture(this.tracker.endCapture(this.tool));
  }
  /** Apply a calibration result (from this tracker or a worker's). */
  applyCapture(r: CaptureResult): CaptureResult {
    if ("camera" in r) this.tracker.setCamera(r.camera, true);
    if ("tipCam" in r) this.setTool({ ...this.tool, tipCam: r.tipCam }, this.toolCalibrated);
    if ("axisCam" in r) this.setTool({ ...this.tool, axisCam: r.axisCam }, true);
    return r;
  }
  setTool(tool: ToolCalib, calibrated: boolean) {
    this.tool = tool;
    this.toolCalibrated = calibrated;
    const id = this.id(this.scene.def.navigation.tool);
    this.engine.setLocal(id, toolLocal(tool));
    this.engine.setCalibrated(id, calibrated);
  }

  // ---------------- helpers for renderers ----------------
  world(name: string, s: EngineSnapshot | null = this.snap): Xf | null {
    const id = this.scene.ids[name];
    return s?.nodes.find((n) => n.id === id)?.world ?? null;
  }

  /** Image-space points for the camera overlay: where the bit axis meets the active target's
   * plane, and the target itself (pixels of the tracker's frames). */
  overlayPoints(s: EngineSnapshot | null = this.snap): { aim: P | null; mark: P | null } {
    if (!s || s.active < 0) return { aim: null, mark: null };
    const nav = this.scene.def.navigation;
    const camW = this.world(nav.tracked, s);
    const t = s.targets[s.active];
    const tgW = s.nodes.find((n) => n.id === t.id)?.world;
    if (!camW || !tgW) return { aim: null, mark: null };
    const camFromWorld = inverse(camW);
    const pts: V3[] = [applyPoint(tgW, [t.aim[0], t.aim[1], 0]), applyPoint(tgW, [0, 0, 0])];
    const cam = this.lastFrame?.camera ?? this.tracker.effectiveCamera;
    const [aim, mark] = this.core.projectPoints(cam, toPose(camFromWorld), pts);
    return { aim, mark };
  }
}

export function gateMessage(bits: number): string | null {
  if (!bits) return null;
  if (bits & GATE_REASONS.NOT_CALIBRATED) return "Calibrate first";
  if (bits & GATE_REASONS.NOT_LOCATED) return "Locate the part first";
  if (bits & GATE_REASONS.KEEP_OUT) return "No-go zone: not here";
  if (bits & (GATE_REASONS.STALE | GATE_REASONS.FEW_MARKERS)) return "Show more markers";
  if (bits & GATE_REASONS.POOR_FIT) return "Markers unclear";
  if (bits & GATE_REASONS.UNSTEADY) return "Hold steady";
  if (bits & GATE_REASONS.TILTED) return "Line up the rings";
  if (bits & GATE_REASONS.OFF_TARGET) return "Tip to the mark";
  return null;
}

/** The tool's world transform from the camera's (for simulators). */
export function toolWorld(cameraWorld: Xf, tool: ToolCalib): Xf {
  return compose(cameraWorld, { ...toolLocal(tool) });
}
