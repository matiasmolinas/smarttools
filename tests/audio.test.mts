import { test } from "node:test";
import assert from "node:assert/strict";
import { toneFor, type ToneInput } from "../lib/audio.ts";

const base: ToneInput = { phase: "approach", offsetMm: 10, angleDeg: 3, gapMm: 30, depthMm: 0, depthTargetMm: 14, ready: false, locking: false, alarms: 0, lost: false };

test("pitch rises as the bit lines up, pulses quicken near the surface", () => {
  const far = toneFor(base);
  const near = toneFor({ ...base, offsetMm: 1.2, angleDeg: 0.6, gapMm: 2 });
  const on = toneFor({ ...base, phase: "align", offsetMm: 0.3, angleDeg: 0.2, gapMm: 0 });
  assert.ok(far.freq < near.freq && near.freq < on.freq, `${far.freq} < ${near.freq} < ${on.freq}`);
  assert.ok(far.rate < near.rate);
  assert.equal(on.mode, "pulse");
});

test("ready is a steady note; driving ticks faster toward the depth; seated chimes", () => {
  assert.equal(toneFor({ ...base, ready: true, offsetMm: 0.2, angleDeg: 0.1, gapMm: 0 }).mode, "steady");
  const a = toneFor({ ...base, phase: "drill", depthMm: 2 });
  const b = toneFor({ ...base, phase: "drill", depthMm: 12 });
  assert.ok(a.rate < b.rate && a.freq < b.freq);
  assert.equal(toneFor({ ...base, phase: "hold", depthMm: 14 }).says, "chime: seated");
});

test("alarms buzz, and nothing plays while not tracking", () => {
  assert.equal(toneFor({ ...base, phase: "drill", alarms: 8 }).mode, "alarm");
  assert.equal(toneFor({ ...base, lost: true, alarms: 8 }).mode, "silent");
});
