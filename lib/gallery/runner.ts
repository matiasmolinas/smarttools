// Runs a gallery scenario on the real engine with no rendering: scripted tool motion -> camera pose
// measurements at 30 Hz (captured 30 ms earlier) -> engine (120 Hz) -> snapshots, events and the
// scenario's panel. The player (components/gallery) draws from it; the unit tests run it headless.

import type { EngineEvent, EngineSnapshot, NavCore } from "../engine.ts";
import { buildEngine, toolLocal, type BuiltScene } from "../scenedef.ts";
import { compose, inverse, type Xf } from "../xform.ts";
import type { Ctx, PanelModel, Scenario, Segment } from "./scenarios.ts";

const MEASURE_HZ = 30;
const LATENCY_S = 0.03;

export interface RunFrame {
  t: number;
  segment: Segment;
  segmentIndex: number;
  scene: BuiltScene;
  snap: EngineSnapshot | null;
  /** the scripted (true) tool pose at t */
  toolW: Xf;
  seen: boolean;
  hidden: string[];
}

export class ScenarioRun {
  readonly core: NavCore;
  readonly scenario: Scenario;
  private built: BuiltScene | null = null;
  private segIndex = -1;
  private lastPush = -Infinity;
  private snap: EngineSnapshot | null = null;
  private calibrated = false;
  events: EngineEvent[] = [];
  store: Record<string, unknown> = {};
  /** bumps whenever the scene definition changes (renderers rebuild) */
  sceneVersion = 0;

  constructor(core: NavCore, scenario: Scenario) {
    this.core = core;
    this.scenario = scenario;
  }

  dispose() {
    this.built?.engine.free();
    this.built = null;
  }

  /** Start over (the player loops). */
  reset() {
    this.dispose();
    this.segIndex = -1;
    this.lastPush = -Infinity;
    this.snap = null;
    this.events = [];
    this.store = {};
  }

  private segmentAt(t: number) {
    let i = 0;
    this.scenario.segments.forEach((s, k) => {
      if (s.from <= t) i = k;
    });
    return i;
  }

  private build(i: number, t: number) {
    this.dispose();
    const seg = this.scenario.segments[i];
    const e = this.core.createEngine();
    this.built = buildEngine(e, this.scenario.scene(seg));
    if (this.scenario.depths) e.setTargetDepths(this.scenario.depths);
    this.calibrated = this.scenario.calibratedAt == null || t >= this.scenario.calibratedAt;
    e.setCalibrated(this.built.ids[this.built.def.navigation.tool], this.calibrated);
    e.start(t);
    this.segIndex = i;
    this.lastPush = -Infinity;
    this.sceneVersion++;
  }

  ctx(t: number, seg: Segment): Ctx {
    return { core: this.core, t, snap: this.snap, rig: seg.rig, names: this.built?.names ?? {}, events: this.events, store: this.store };
  }

  /** Advance to scenario time t (seconds, 0..duration). */
  step(t: number): RunFrame {
    const i = this.segmentAt(t);
    if (i !== this.segIndex || !this.built) this.build(i, t);
    const seg = this.scenario.segments[i];
    const built = this.built!;
    const e = built.engine;
    const nav = built.def.navigation;
    if (!this.calibrated && this.scenario.calibratedAt != null && t >= this.scenario.calibratedAt) {
      this.calibrated = true;
      e.setCalibrated(built.ids[nav.tool], true);
    }
    const ctx = this.ctx(t, seg);
    this.scenario.onStep?.(ctx, { core: this.core, engine: e, ids: built.ids });
    const ts = this.scenario.tool(ctx);
    const seen = ts.seen !== false;
    // measurements at 30 Hz, captured LATENCY_S before they reach the engine
    while (this.lastPush + 1 / MEASURE_HZ <= t) {
      this.lastPush = this.lastPush === -Infinity ? t : this.lastPush + 1 / MEASURE_HZ;
      if (!seen) continue;
      const tc = Math.max(this.lastPush - LATENCY_S, 0);
      const ctc = this.ctx(tc, seg);
      const toolW = this.scenario.tool(ctc).toolW;
      const camW = compose(toolW, inverse(toolLocal(seg.rig.tool)));
      // the sheet is the world origin: the tracker would see T_camera_sheet = camW⁻¹
      if (this.scenario.sheetSeen?.(ctc) !== false) e.push(built.ids[nav.tracked], built.ids[nav.reference], inverse(camW), tc, ts.markers ?? 9, 0.3);
      // markers on parts: T_camera_body
      for (const b of this.scenario.bodies?.(ctc) ?? []) {
        const id = built.ids[b.node];
        if (id != null) e.push(built.ids[nav.tracked], id, compose(inverse(camW), b.world), tc, 10, 0.35);
      }
    }
    if (e.advance(t) > 0 || !this.snap) {
      this.snap = e.snapshot();
      this.events.push(...this.snap.events);
    }
    return { t, segment: seg, segmentIndex: i, scene: built, snap: this.snap, toolW: ts.toolW, seen, hidden: this.scenario.hidden?.(this.ctx(t, seg)) ?? [] };
  }

  panel(t: number): PanelModel {
    const seg = this.scenario.segments[Math.max(0, this.segIndex)];
    return this.scenario.panel(this.ctx(t, seg));
  }
}
