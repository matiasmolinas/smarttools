// The browser simulator's clock (lib/scene.ts SimClock): simulated time that waits for slow frames, so the scene
// plays in slow motion but on the same timeline as the headless run (scripts/pilot-sim.mts: frames every 1/15 s,
// at the engine 0.03 s after their capture, the engine ticking at 120 Hz).
import test from "node:test";
import assert from "node:assert/strict";
import { SIM_FPS, SIM_LATENCY_S, SIM_TICK_S, SimClock } from "../lib/scene.ts";

/** Drive a clock as the screen does: polls every 4 ms of wall time; a frame sent takes `frameMs` of wall time to come
 * back. Returns the capture times, the ticks, and for each delivered frame the clock's time when it reached the engine. */
function drive(frameMs: number, wallS: number) {
  const c = new SimClock(100);
  const captures: number[] = [];
  const ticks: number[] = [];
  const arrivals: { tCapture: number; t: number }[] = [];
  let inFlight: { tCapture: number; back: number } | null = null;
  for (let wall = 0; wall <= wallS; wall += 0.004) {
    if (inFlight && wall >= inFlight.back) {
      c.delivered();
      arrivals.push({ tCapture: inFlight.tCapture, t: c.t });
      inFlight = null;
    }
    const tc = c.due();
    if (tc != null) {
      c.sent(tc);
      captures.push(tc);
      inFlight = { tCapture: tc, back: wall + frameMs / 1000 };
    }
    c.run(wall, (t) => ticks.push(t));
  }
  return { c, captures, ticks, arrivals };
}

test("SimClock: a slow simulator (270 ms a frame) keeps the phone's timeline in slow motion", () => {
  const { c, captures, ticks, arrivals } = drive(270, 30);
  // frames every 1/15 s of simulated time, never two in flight
  assert.ok(captures.length > 100, `${captures.length} frames`);
  captures.forEach((t, i) => assert.ok(Math.abs(t - (100 + i / SIM_FPS)) < 1e-9, `frame ${i} at ${t}`));
  // the engine ticks one tick at a time
  for (let i = 1; i < ticks.length; i++) assert.ok(Math.abs(ticks[i] - ticks[i - 1] - SIM_TICK_S) < 1e-9);
  // each frame reaches the engine no later than its capture + the latency (+ one tick): never stale
  for (const a of arrivals) assert.ok(a.t - a.tCapture <= SIM_LATENCY_S + SIM_TICK_S + 1e-9, `late by ${a.t - a.tCapture}`);
  // slow motion: about 1/15 s of simulated time per 270 ms of wall time
  const rate = (c.t - 100) / 30;
  assert.ok(rate > 0.2 && rate < 0.26, `simulated s per wall s: ${rate.toFixed(3)}`);
});

test("SimClock: a fast simulator never runs ahead of the wall clock", () => {
  const { c, captures } = drive(10, 10);
  assert.ok(c.t - 100 <= 10 + 1e-6 && c.t - 100 > 9.8, `simulated ${(c.t - 100).toFixed(2)} s in 10 s`);
  assert.ok(Math.abs(captures.length - 10 * SIM_FPS) <= 2, `${captures.length} frames`);
});

test("SimClock: due, sent, delivered; it waits for the frame in flight; a long wait is not caught up at once", () => {
  const c = new SimClock(5);
  assert.equal(c.due(), 5, "the first frame at once");
  c.sent(5);
  assert.equal(c.due(), null, "one in flight");
  let n = c.run(0, () => {});
  assert.equal(n, 0, "no wall time yet");
  n = c.run(1, () => {});
  assert.equal(n, Math.floor((SIM_LATENCY_S + 1e-9) / SIM_TICK_S), "up to the frame's latency, then it waits");
  assert.ok(c.t <= 5 + SIM_LATENCY_S + 1e-9);
  assert.equal(c.run(2, () => {}), 0, "still waiting");
  c.delivered();
  // after a long wait at most 0.1 s is caught up
  n = c.run(10, () => {});
  assert.ok(n <= Math.round(0.1 / SIM_TICK_S) + 1, `${n} ticks`);
  assert.ok(c.t <= 5 + 1 / SIM_FPS + SIM_LATENCY_S + 1e-9, "and never past the next frame's latency");
  assert.equal(c.due(), 5 + 1 / SIM_FPS);
});
