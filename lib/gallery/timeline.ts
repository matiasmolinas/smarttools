// Scripted tool motion for the 3D-assembly scenarios: keyframes of the bit tip and the bit axis,
// interpolated smoothly, plus timed actions (register a part, verify a point) that run on the real
// engine. The camera is kept facing the marker sheet by turning the tool about its bit.

import { toolAt } from "../assembly.ts";
import { applyDir, compose, qaxis, xf, type Xf } from "../xform.ts";
import type { V3 } from "../pose.ts";

export interface Key {
  t: number;
  tip: V3;
  axis: V3;
  /** the drill turned about its bit (deg), for twist gestures */
  roll?: number;
}

export interface Chapter {
  from: number;
  label: string;
  headline: string;
}

export interface TimedAction {
  at: number;
  id: string;
}

const ease = (x: number) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};
const lerp3 = (a: V3, b: V3, k: number): V3 => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Turn the drill about its bit so the camera faces the sheet's centre (the world origin). */
export const towardSheet = (p: V3): V3 => [-p[0], -p[1], 0];

export class Timeline {
  keys: Key[] = [];
  actions: TimedAction[] = [];
  chapters: Chapter[] = [];
  /** screw name -> [start, seated] times */
  screws: Record<string, [number, number]> = {};
  t = 0;

  chapter(label: string, headline: string) {
    this.chapters.push({ from: this.t, label, headline });
    return this;
  }
  /** move to a tip/axis over `dur` seconds */
  to(tip: V3, axis: V3, dur: number) {
    this.t += dur;
    this.keys.push({ t: this.t, tip, axis: unit(axis) });
    return this;
  }
  hold(dur: number) {
    const k = this.keys[this.keys.length - 1];
    return this.to(k.tip, k.axis, dur);
  }
  /** two quick taps of the tip on a surface point (a "confirm" gesture), starting 4 mm above it */
  doubleTap(p: V3, axis: V3 = [0, 0, -1]) {
    const a = unit(axis);
    const up: V3 = [p[0] - a[0] * 0.004, p[1] - a[1] * 0.004, p[2] - a[2] * 0.004];
    this.to(up, a, 0.5).hold(0.3);
    for (let i = 0; i < 2; i++) this.to(p, a, 0.09).hold(0.08).to(up, a, 0.1).hold(0.15);
    return this.hold(0.4);
  }
  /** turn the drill about its bit by `deg` and back (a "next" gesture) */
  twist(deg = 70, dur = 0.8) {
    const k = this.keys[this.keys.length - 1];
    this.t += dur / 2;
    this.keys.push({ t: this.t, tip: k.tip, axis: k.axis, roll: deg });
    this.t += dur / 2;
    this.keys.push({ t: this.t, tip: k.tip, axis: k.axis, roll: 0 });
    return this;
  }
  action(id: string, delay = 0) {
    this.actions.push({ at: this.t + delay, id });
    return this;
  }
  /** approach above a point along the axis, touch it, dwell; fires `touch:<id>` at the end of the dwell */
  touch(id: string, p: V3, axis: V3 = [0, 0, -1], dwell = 0.9) {
    const a = unit(axis);
    this.to([p[0] - a[0] * 0.02, p[1] - a[1] * 0.02, p[2] - a[2] * 0.02], a, 0.55);
    this.to(p, a, 0.45);
    this.hold(dwell);
    this.action(`touch:${id}`);
    this.to([p[0] - a[0] * 0.015, p[1] - a[1] * 0.015, p[2] - a[2] * 0.015], a, 0.3);
    return this;
  }
  /** a full screw cycle at a (true) hole frame: approach tilted, align, lock, drive, seat, back out */
  screw(name: string, hole: Xf, depthMm: number, speed = 1, o: { driveTiltDeg?: number; offsetMm?: number } = {}) {
    const tilt = o.driveTiltDeg ?? 0.1;
    const off = (o.offsetMm ?? 0.1) / 1000;
    const at = (p: V3, tiltDeg: number) => {
      const w = compose(hole, xf(p, qaxis([1, 0.5, 0], (tiltDeg * Math.PI) / 180)));
      return { tip: w.p, axis: applyDir(w, [0, 0, 1]) };
    };
    const go = (k: { tip: V3; axis: V3 }, d: number) => this.to(k.tip, k.axis, d / speed);
    const start = this.t;
    go(at([0.005, -0.004, -0.026], 4), 0.7);
    go(at([0.0004, 0.0002, 0], 1.6), 0.6);
    go(at([off, 0, 0], tilt), 0.5);
    this.hold(0.5 / speed);
    go(at([off, 0, (depthMm / 1000) * 1.004], tilt), 1.0);
    const seated = this.t;
    this.hold(0.25 / speed);
    go(at([off, 0, -0.02], tilt), 0.45);
    this.screws[name] = [start, seated];
    return this;
  }

  get duration() {
    return this.t;
  }

  /** The tool's world pose at time t (plus a little hand tremor). */
  toolAt(t: number, tremor = 1): Xf {
    const k = this.keys;
    if (!k.length) return xf();
    let i = k.findIndex((x) => x.t >= t);
    if (i < 0) i = k.length - 1;
    const b = k[i];
    const a = i > 0 ? k[i - 1] : b;
    const u = b.t > a.t ? ease((t - a.t) / (b.t - a.t)) : 1;
    const tip = lerp3(a.tip, b.tip, u);
    const axis = unit(lerp3(a.axis, b.axis, u));
    const tr = 0.00012 * tremor;
    const jitter: V3 = [tr * Math.sin(t * 2 * Math.PI * 9.3), tr * Math.sin(t * 2 * Math.PI * 11.1 + 1), 0];
    const roll = (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * u;
    return compose(toolAt(tip, axis, towardSheet(tip)), xf(jitter, qaxis([0, 0, 1], (roll * Math.PI) / 180)));
  }

  chapterAt(t: number): Chapter | null {
    let c: Chapter | null = null;
    for (const x of this.chapters) if (x.from <= t) c = x;
    return c;
  }
}
