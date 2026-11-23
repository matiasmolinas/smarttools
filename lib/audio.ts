// Sound guidance: eyes on the work, not on the phone. A tone that rises in pitch as the bit lines up
// (like a metal detector), turns into a clean steady note when the engine says "ready", ticks faster
// as the screw nears its depth, chimes when it is seated, and buzzes on an alarm. Plus vibration
// on the phone for the events that matter.
//
// toneFor() is pure (tested); SoundGuide plays it with WebAudio.

import type { EnginePhase } from "./engine.ts";

export interface ToneInput {
  phase: EnginePhase;
  offsetMm: number;
  angleDeg: number;
  gapMm: number;
  depthMm: number;
  depthTargetMm: number;
  ready: boolean;
  locking: boolean;
  alarms: number;
  lost: boolean;
  /** the requirement (the gate's limits) */
  limits?: { offsetMm: number; angleDeg: number };
}
export interface Tone {
  mode: "silent" | "pulse" | "steady" | "alarm";
  /** Hz */
  freq: number;
  /** pulses per second (pulse mode) */
  rate: number;
  gain: number;
  /** a short text for a visual cue (what the sound is saying) */
  says: string;
}

export function toneFor(s: ToneInput): Tone {
  const lim = s.limits ?? { offsetMm: 0.75, angleDeg: 0.5 };
  if (s.lost) return { mode: "silent", freq: 0, rate: 0, gain: 0, says: "silent: not tracking" };
  if (s.alarms) return { mode: "alarm", freq: 440, rate: 7, gain: 0.5, says: "buzz: stop" };
  if (s.phase === "hold") return { mode: "steady", freq: 1568, rate: 0, gain: 0.35, says: "chime: seated" };
  if (s.phase === "drill") {
    const left = Math.max(0, s.depthTargetMm - s.depthMm);
    const k = 1 - Math.min(1, left / Math.max(1, s.depthTargetMm));
    return { mode: "pulse", freq: 660 + 220 * k, rate: 2 + 14 * k * k, gain: 0.3, says: `ticks: ${left.toFixed(0)} mm to go` };
  }
  if (s.phase === "retract") return { mode: "silent", freq: 0, rate: 0, gain: 0, says: "silent" };
  if (s.ready) return { mode: "steady", freq: 1175, rate: 0, gain: 0.3, says: "steady note: ready" };
  // error in units of the requirement: 1 = at the limit; pitch rises as it falls, pulses quicken near the surface
  const err = Math.max(s.offsetMm / lim.offsetMm, s.angleDeg / lim.angleDeg);
  const freq = 260 + 760 / (1 + Math.max(0, err - 1) * 0.6);
  const rate = 1.5 + 6 / (1 + s.gapMm / 8);
  if (s.locking) return { mode: "pulse", freq: 1100, rate: 12, gain: 0.28, says: "fast trill: hold still" };
  return { mode: "pulse", freq, rate, gain: 0.22, says: `${err <= 1 ? "high" : err < 4 ? "rising" : "low"} pitch: ${err <= 1 ? "on it" : "line up"}` };
}

/** The tone for what the phone HUD shows (lib/render/hudview.ts state + overlay). */
export function toneFromHud(
  s: { phase: EnginePhase; offsetMm: number; angleErrDeg: number; gapMm: number; depthMm: number; depthTargetMm?: number },
  o: { lost: boolean; gate?: { ready: boolean; locking?: boolean }; alarms?: number },
): Tone {
  return toneFor({
    phase: s.phase,
    offsetMm: s.offsetMm,
    angleDeg: s.angleErrDeg,
    gapMm: s.gapMm,
    depthMm: s.depthMm,
    depthTargetMm: s.depthTargetMm ?? 35,
    ready: !!o.gate?.ready,
    locking: !!o.gate?.locking,
    alarms: o.alarms ?? 0,
    lost: o.lost,
  });
}

/** Vibration patterns for events (ms on/off). */
export const VIBRATE: Record<string, number[]> = {
  ready: [40],
  "depth-reached": [120, 60, 120],
  "gesture-tap": [30, 40, 30],
  "gesture-twist": [60],
  alarm: [300, 100, 300],
};

/** Plays tones with WebAudio. Create it from a user gesture (browsers need one to start audio). */
export class SoundGuide {
  private ctx: AudioContext;
  private osc: OscillatorNode;
  private amp: GainNode;
  private phase = 0;
  private last = 0;
  enabled = true;

  constructor() {
    this.ctx = new AudioContext();
    this.osc = this.ctx.createOscillator();
    this.osc.type = "sine";
    this.amp = this.ctx.createGain();
    this.amp.gain.value = 0;
    this.osc.connect(this.amp).connect(this.ctx.destination);
    this.osc.start();
  }

  /** Call every frame with the current tone. */
  play(tone: Tone) {
    const now = this.ctx.currentTime;
    const dt = this.last ? Math.min(0.1, now - this.last) : 0;
    this.last = now;
    let g = 0;
    if (this.enabled && tone.mode !== "silent") {
      if (tone.mode === "steady") g = tone.gain;
      else {
        this.phase = (this.phase + dt * tone.rate) % 1;
        g = this.phase < (tone.mode === "alarm" ? 0.5 : 0.28) ? tone.gain : 0;
      }
      const f = tone.mode === "alarm" ? (this.phase < 0.25 ? 880 : 440) : tone.freq;
      this.osc.frequency.setTargetAtTime(f, now, 0.01);
    }
    this.amp.gain.setTargetAtTime(g * 0.25, now, 0.008);
  }

  /** Quiet now (a pause or a stop): no last tone left sounding, and the next pulse starts from the top. */
  silence() {
    const now = this.ctx.currentTime;
    this.amp.gain.cancelScheduledValues(now);
    this.amp.gain.setValueAtTime(0, now);
    this.phase = 0;
    this.last = 0;
  }

  vibrate(event: string) {
    const p = VIBRATE[event];
    if (p && this.enabled && typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(p);
  }

  close() {
    this.osc.stop();
    void this.ctx.close();
  }
}
